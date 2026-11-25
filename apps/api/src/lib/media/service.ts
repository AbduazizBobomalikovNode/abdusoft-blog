import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { media } from "../../db/schema.js";
import { toMediaDto } from "../admin-reads/media.js";
import { recordAuditSafe } from "../audit.js";
import { fail, ok, type Actor, type ServiceResult } from "../posts/types.js";
import { deleteStoredFile, processImage, storeProcessedFile } from "./store.js";

export type MediaDto = ReturnType<typeof toMediaDto>;

/**
 * `POST /admin/media` (ishlov berish + saqlash + yozuv + jurnal) va MCP `upload_image`. Fayl turi/hajmini TEKSHIRISH
 * chaqiruvchining ishi (HTTP: `Content-Type`, MCP: baytlarning o'zi bo'yicha).
 */
export async function createMediaFromBuffer(
  actor: Actor,
  input: { buffer: Buffer; mime: string; alt: string | null },
): Promise<ServiceResult<MediaDto>> {
  let processed: Awaited<ReturnType<typeof processImage>>;
  try {
    processed = await processImage(input.buffer, input.mime);
  } catch (error) {
    console.error("Rasmni qayta ishlashda xatolik:", error);
    return fail("bad_request", "Rasmni qayta ishlab bo'lmadi");
  }

  const stored = await storeProcessedFile(processed);

  const [created] = await db
    .insert(media)
    .values({
      key: stored.key,
      url: stored.url,
      mime: processed.mime,
      size: processed.buffer.byteLength,
      width: processed.width,
      height: processed.height,
      alt: input.alt,
      createdBy: actor.userId,
    })
    .returning();
  if (!created) return fail("bad_request", "Yuklab bo'lmadi");

  await recordAuditSafe(actor, {
    action: "media.upload",
    entityType: "media",
    entityId: created.id,
    summary: "Media fayl yuklandi",
    meta: { mime: created.mime, size: created.size },
  });
  return ok(toMediaDto(created));
}

/** `PATCH /admin/media/:id` va MCP `update_media_alt`. Xodim faqat o'zi yuklaganini o'zgartiradi. */
export async function updateMediaAlt(actor: Actor, id: string, alt: string | null): Promise<ServiceResult<MediaDto>> {
  const [existing] = await db.select({ createdBy: media.createdBy }).from(media).where(eq(media.id, id)).limit(1);
  if (!existing) return fail("not_found", "Topilmadi");
  if (actor.role === "staff" && existing.createdBy !== actor.userId) {
    return fail("forbidden", "Faqat o'zingiz yuklagan fayllarni o'zgartira olasiz");
  }

  const [updated] = await db.update(media).set({ alt }).where(eq(media.id, id)).returning();
  if (!updated) return fail("not_found", "Topilmadi");
  await recordAuditSafe(actor, {
    action: "media.update",
    entityType: "media",
    entityId: id,
    summary: "Media fayl tavsifi (alt) o'zgartirildi",
    meta: { fields: ["alt"] },
  });
  return ok(toMediaDto(updated));
}

/** `DELETE /admin/media/:id` va MCP `delete_media`. */
export async function deleteMedia(actor: Actor, id: string): Promise<ServiceResult<{ url: string }>> {
  const [row] = await db.select().from(media).where(eq(media.id, id)).limit(1);
  if (!row) return fail("not_found", "Topilmadi");
  if (actor.role === "staff" && row.createdBy !== actor.userId) {
    return fail("forbidden", "Faqat o'zingiz yuklagan fayllarni o'chira olasiz");
  }

  await deleteStoredFile(row.key);
  await db.delete(media).where(eq(media.id, id));
  await recordAuditSafe(actor, {
    action: "media.delete",
    entityType: "media",
    entityId: id,
    summary: "Media fayl o'chirildi",
    meta: { mime: row.mime, size: row.size },
  });
  return ok({ url: row.url });
}

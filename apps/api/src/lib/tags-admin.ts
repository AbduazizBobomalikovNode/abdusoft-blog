import { eq, sql } from "drizzle-orm";
import { slugify, type CreateTagBody, type UpdateTagBody } from "@blog/shared";
import { db } from "../db/index.js";
import { postTags, tags } from "../db/schema.js";
import { tagsQuery } from "./admin-reads/tags.js";
import { recordAuditSafe } from "./audit.js";
import { fail, ok, type Actor, type ServiceResult } from "./posts/types.js";

type TagView = Awaited<ReturnType<typeof tagsQuery>>[number];

/** `POST /admin/tags` va MCP `create_tag`: slug tozalanadi, band bo'lsa 409. */
export async function createTag(actor: Actor, input: CreateTagBody): Promise<ServiceResult<TagView>> {
  const slug = slugify(input.slug ?? input.name);
  if (!slug) return fail("bad_request", "Slug bo'sh bo'lishi mumkin emas");

  const [existing] = await db.select({ id: tags.id }).from(tags).where(eq(tags.slug, slug)).limit(1);
  if (existing) return fail("conflict", `"${slug}" slug allaqachon band`);

  const [created] = await db
    .insert(tags)
    .values({ slug, name: input.name, description: input.description ?? null, color: input.color ?? null })
    .returning();
  if (!created) return fail("bad_request", "Yaratib bo'lmadi");

  await recordAuditSafe(actor, {
    action: "tag.create",
    entityType: "tag",
    entityId: created.id,
    summary: `Teg yaratildi: ${created.name}`,
    meta: { slug: created.slug },
  });
  return ok({ ...created, postsCount: 0 });
}

/** `PATCH /admin/tags/:id` va MCP `update_tag`. */
export async function updateTag(actor: Actor, id: string, input: UpdateTagBody): Promise<ServiceResult<TagView>> {
  const [existingTag] = await db.select().from(tags).where(eq(tags.id, id)).limit(1);
  if (!existingTag) return fail("not_found", "Topilmadi");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle partial update payload
  const update: Record<string, any> = {};
  if (input.name !== undefined) update.name = input.name;
  if (input.description !== undefined) update.description = input.description;
  if (input.color !== undefined) update.color = input.color;

  if (input.slug !== undefined) {
    const clean = slugify(input.slug);
    if (!clean) return fail("bad_request", "Slug bo'sh bo'lishi mumkin emas");
    const [conflict] = await db.select({ id: tags.id }).from(tags).where(eq(tags.slug, clean)).limit(1);
    if (conflict && conflict.id !== id) return fail("conflict", `"${clean}" slug allaqachon band`);
    update.slug = clean;
  }

  if (Object.keys(update).length > 0) {
    await db.update(tags).set(update).where(eq(tags.id, id));
    await recordAuditSafe(actor, {
      action: "tag.update",
      entityType: "tag",
      entityId: id,
      summary: `Teg tahrirlandi: ${(update.name as string | undefined) ?? existingTag.name}`,
      meta: { fields: Object.keys(update) },
    });
  }

  const [row] = await tagsQuery(id);
  return row ? ok(row) : fail("not_found", "Topilmadi");
}

/** `DELETE /admin/tags/:id` va MCP `delete_tag`: postlarda ishlatilsa `force` kerak (aks holda 409 + `postsCount`). */
export async function deleteTag(actor: Actor, id: string, force: boolean): Promise<ServiceResult<{ slug: string; name: string; postsCount: number }>> {
  const [existingTag] = await db.select().from(tags).where(eq(tags.id, id)).limit(1);
  if (!existingTag) return fail("not_found", "Topilmadi");

  const [countRow] = await db.select({ count: sql<number>`count(*)::int` }).from(postTags).where(eq(postTags.tagId, id));
  const postsCount = countRow?.count ?? 0;

  if (postsCount > 0 && !force) {
    return fail("conflict", "Teg postlarda ishlatilmoqda — o'chirish uchun ?force=1 qo'shing", { postsCount });
  }

  await db.delete(postTags).where(eq(postTags.tagId, id));
  await db.delete(tags).where(eq(tags.id, id));
  await recordAuditSafe(actor, {
    action: "tag.delete",
    entityType: "tag",
    entityId: id,
    summary: `Teg o'chirildi: ${existingTag.name}`,
    meta: { slug: existingTag.slug, postsCount, force },
  });
  return ok({ slug: existingTag.slug, name: existingTag.name, postsCount });
}

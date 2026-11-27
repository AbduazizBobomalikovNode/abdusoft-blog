import { and, asc, eq } from "drizzle-orm";
import {
  DISTRIBUTION_IMAGE_CHOICES,
  DISTRIBUTION_VERSION_MAX_PER_CHANNEL,
  DISTRIBUTION_VERSION_NAME_MAX,
  DISTRIBUTION_VERSION_TEXT_MAX,
  type CreateDistributionVersionBody,
  type DistributionImageChoice,
  type DistributionLinkMode,
  type DistributionProviderId,
  type DistributionVersionDto,
  type UpdateDistributionVersionBody,
} from "@blog/shared";
import { db } from "../../../db/index.js";
import { distributionVersions } from "../../../db/schema.js";
import { recordAuditSafe } from "../../audit.js";
import { fail, ok, type Actor, type ServiceResult } from "../../posts/types.js";
import type { ProviderId } from "../types.js";
import { PROVIDER_LABEL } from "./accounts.js";
import { distNow } from "./env.js";
import { loadPostForDistribution } from "./post-source.js";
import { resolvePlan } from "./prepare.js";

/**
 * Nomli matn versiyalari (Telegram kanal versiyalariga o'xshash). Versiya faqat matn/rasm/rejimni SAQLAYDI: yuborish yo'li
 * (`actions.ts`) o'zgarmagan — yuboriladigan matn har doim so'rovdagi matn, versiya id'si esa faqat `distributions.version_id`ga yoziladi.
 */

export type VersionRow = typeof distributionVersions.$inferSelect;

function pgCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
}

export function toVersionDto(row: VersionRow): DistributionVersionDto {
  return {
    id: row.id,
    postId: row.postId,
    provider: row.provider as DistributionProviderId,
    name: row.name,
    text: row.text,
    imageChoice: row.imageChoice as DistributionImageChoice,
    linkMode: (row.linkMode as DistributionLinkMode | null) ?? null,
    isPrimary: row.isPrimary,
    createdBy: row.createdBy,
    createdVia: row.createdVia,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getVersion(id: string): Promise<VersionRow | null> {
  const [row] = await db.select().from(distributionVersions).where(eq(distributionVersions.id, id)).limit(1);
  return row ?? null;
}

export async function listVersionRowsForPost(postId: string, provider?: string): Promise<VersionRow[]> {
  return db
    .select()
    .from(distributionVersions)
    .where(provider ? and(eq(distributionVersions.postId, postId), eq(distributionVersions.provider, provider)) : eq(distributionVersions.postId, postId))
    .orderBy(asc(distributionVersions.createdAt), asc(distributionVersions.id));
}

export async function listVersions(postId: string, provider: ProviderId): Promise<ServiceResult<DistributionVersionDto[]>> {
  const post = await loadPostForDistribution(postId);
  if (!post) return fail("not_found", "Post topilmadi");
  return ok((await listVersionRowsForPost(postId, provider)).map(toVersionDto));
}

function validateFields(provider: ProviderId, f: { name?: string | undefined; text?: string | undefined; imageChoice?: DistributionImageChoice | undefined; linkMode?: DistributionLinkMode | null | undefined }): string | null {
  if (provider === "github") return "GitHub README bloki avtomatik yig'iladi — versiya yo'q";
  if (f.name !== undefined && (f.name.trim() === "" || f.name.trim().length > DISTRIBUTION_VERSION_NAME_MAX)) return `Versiya nomi 1–${DISTRIBUTION_VERSION_NAME_MAX} belgi bo'lsin`;
  if (f.text !== undefined && f.text.length > DISTRIBUTION_VERSION_TEXT_MAX) return `Matn juda uzun (${DISTRIBUTION_VERSION_TEXT_MAX} belgidan oshmasin)`;
  if (f.imageChoice !== undefined && !DISTRIBUTION_IMAGE_CHOICES.includes(f.imageChoice)) return "Noto'g'ri rasm tanlovi";
  if (f.linkMode !== undefined && f.linkMode !== null && provider !== "linkedin") return "Havola rejimi faqat LinkedIn uchun";
  return null;
}

/** "N-versiya" — hali band bo'lmagan eng kichik N (mavjud soni + 1 dan boshlab). */
export function nextDefaultVersionName(existing: readonly { name: string }[]): string {
  const names = new Set(existing.map((r) => r.name));
  let n = existing.length + 1;
  while (names.has(`${n}-versiya`)) n += 1;
  return `${n}-versiya`;
}

function auditEntry(action: string, row: VersionRow, summary: string, meta: Record<string, unknown> = {}) {
  return { action, entityType: "distribution_version", entityId: row.id, summary: `${PROVIDER_LABEL[row.provider as ProviderId]}: ${summary}`, meta: { postId: row.postId, provider: row.provider, ...meta } };
}

export async function createVersion(actor: Actor, postId: string, provider: ProviderId, body: CreateDistributionVersionBody): Promise<ServiceResult<DistributionVersionDto>> {
  const post = await loadPostForDistribution(postId);
  if (!post || post.deletedAt) return fail("not_found", "Post topilmadi");
  const invalid = validateFields(provider, body);
  if (invalid) return fail("bad_request", invalid);
  if (body.fromVersionId && body.text !== undefined) return fail("bad_request", "text va fromVersionId birga berilmaydi");

  const existing = await listVersionRowsForPost(postId, provider);
  if (existing.length >= DISTRIBUTION_VERSION_MAX_PER_CHANNEL) return fail("conflict", `Bitta kanal uchun ko'pi bilan ${DISTRIBUTION_VERSION_MAX_PER_CHANNEL} ta versiya`);

  let text = body.text;
  let imageChoice = body.imageChoice;
  let linkMode = body.linkMode;
  if (body.fromVersionId) {
    const from = existing.find((v) => v.id === body.fromVersionId);
    if (!from) return fail("not_found", "Nusxa olinadigan versiya topilmadi");
    text = from.text;
    imageChoice ??= from.imageChoice as DistributionImageChoice;
    if (linkMode === undefined) linkMode = (from.linkMode as DistributionLinkMode | null) ?? null;
  }
  if (text === undefined) {
    const plan = await resolvePlan(postId, provider, { overrides: { text: null, ...(linkMode !== undefined ? { linkMode } : {}) } });
    if (!plan) return fail("not_found", "Post topilmadi");
    text = plan.defaultText;
  }
  const name = body.name?.trim() || nextDefaultVersionName(existing);
  const now = distNow();
  const values = {
    postId,
    provider,
    name,
    text,
    imageChoice: imageChoice ?? "auto",
    linkMode: provider === "linkedin" ? (linkMode ?? null) : null,
    // Birinchi versiya o'zi asosiy bo'lmaydi: "asosiy" — egasining ongli tanlovi.
    isPrimary: false,
    createdBy: actor.userId,
    createdVia: actor.via === "mcp" ? "mcp" : "web",
    // `createdAt` — bazaning `now()`i (mikrosekund: tartiblash aniq); `updatedAt` — JS Date (ms), optimistik taqqoslash uchun aniq mos keladi.
    updatedAt: now,
  };
  const [row] = await db.insert(distributionVersions).values(values).returning();
  if (!row) return fail("conflict", "Versiyani yaratib bo'lmadi");
  await recordAuditSafe(actor, auditEntry("distribution.version_create", row, `versiya yaratildi: ${row.name}`));
  if (body.makePrimary) return setPrimary(actor, row.id);
  return ok(toVersionDto(row));
}

export async function updateVersion(actor: Actor, id: string, body: UpdateDistributionVersionBody): Promise<ServiceResult<DistributionVersionDto>> {
  const row = await getVersion(id);
  if (!row) return fail("not_found", "Versiya topilmadi");
  const invalid = validateFields(row.provider as ProviderId, body);
  if (invalid) return fail("bad_request", invalid);
  if (body.expectedUpdatedAt !== undefined && new Date(body.expectedUpdatedAt).getTime() !== row.updatedAt.getTime()) {
    return fail("conflict", "Versiya boshqa joyda o'zgargan — yangilab qayta urinib ko'ring", { reason: "stale_version", currentUpdatedAt: row.updatedAt.toISOString() });
  }
  const set: Partial<typeof distributionVersions.$inferInsert> = { updatedAt: distNow() };
  if (body.name !== undefined) set.name = body.name.trim();
  if (body.text !== undefined) set.text = body.text;
  if (body.imageChoice !== undefined) set.imageChoice = body.imageChoice;
  if (body.linkMode !== undefined) set.linkMode = body.linkMode;
  // Optimistik: o'qilgan `updatedAt` hali o'zgarmagan bo'lsagina yozamiz (ikki bir vaqtdagi saqlash bir-birini bosmasin).
  const [updated] = await db
    .update(distributionVersions)
    .set(set)
    .where(and(eq(distributionVersions.id, id), eq(distributionVersions.updatedAt, row.updatedAt)))
    .returning();
  if (!updated) return fail("conflict", "Versiya boshqa joyda o'zgargan — yangilab qayta urinib ko'ring");
  await recordAuditSafe(actor, auditEntry("distribution.version_update", updated, `versiya saqlandi: ${updated.name}`, { fields: Object.keys(body).filter((k) => k !== "expectedUpdatedAt") }));
  return ok(toVersionDto(updated));
}

export async function deleteVersion(actor: Actor, id: string): Promise<ServiceResult<{ id: string; wasPrimary: boolean }>> {
  const row = await getVersion(id);
  if (!row) return fail("not_found", "Versiya topilmadi");
  // `distributions.version_id` ON DELETE SET NULL: o'tgan yuborishlar saqlanadi, faqat bog'lanish uziladi.
  await db.delete(distributionVersions).where(eq(distributionVersions.id, id));
  await recordAuditSafe(actor, auditEntry("distribution.version_delete", row, `versiya o'chirildi: ${row.name}`, { wasPrimary: row.isPrimary }));
  return ok({ id, wasPrimary: row.isPrimary });
}

/** Versiyani asosiy qiladi (shu post+kanaldagi boshqasidan olinadi); bitta tranzaksiyada, qisman unique indeks bilan himoyalangan. */
export async function setPrimary(actor: Actor, id: string): Promise<ServiceResult<DistributionVersionDto>> {
  const row = await getVersion(id);
  if (!row) return fail("not_found", "Versiya topilmadi");
  if (row.isPrimary) return ok(toVersionDto(row));
  try {
    const updated = await db.transaction(async (tx) => {
      await tx
        .update(distributionVersions)
        .set({ isPrimary: false })
        .where(and(eq(distributionVersions.postId, row.postId), eq(distributionVersions.provider, row.provider), eq(distributionVersions.isPrimary, true)));
      const [r] = await tx.update(distributionVersions).set({ isPrimary: true }).where(eq(distributionVersions.id, id)).returning();
      return r;
    });
    if (!updated) return fail("not_found", "Versiya topilmadi");
    await recordAuditSafe(actor, auditEntry("distribution.version_primary", updated, `asosiy versiya: ${updated.name}`));
    return ok(toVersionDto(updated));
  } catch (error) {
    if (pgCode(error) === "23505") return fail("conflict", "Asosiy versiya bir vaqtda o'zgartirildi — qayta urinib ko'ring");
    throw error;
  }
}

/** Asosiy belgisini olib tashlaydi (versiyalarning o'zi qoladi). */
export async function clearPrimary(actor: Actor, postId: string, provider: ProviderId): Promise<ServiceResult<{ cleared: number }>> {
  const post = await loadPostForDistribution(postId);
  if (!post) return fail("not_found", "Post topilmadi");
  const rows = await db
    .update(distributionVersions)
    .set({ isPrimary: false })
    .where(and(eq(distributionVersions.postId, postId), eq(distributionVersions.provider, provider), eq(distributionVersions.isPrimary, true)))
    .returning();
  for (const r of rows) await recordAuditSafe(actor, auditEntry("distribution.version_primary_clear", r, "asosiy belgisi olib tashlandi"));
  return ok({ cleared: rows.length });
}

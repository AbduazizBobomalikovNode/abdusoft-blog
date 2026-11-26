import { and, eq, inArray } from "drizzle-orm";
import { DISTRIBUTION_IMAGE_CHOICES, type DistributionImageChoice, type DistributionItemDto, type DistributionLinkMode, type DistributionPostResponse } from "@blog/shared";
import { db } from "../../../db/index.js";
import { distributions } from "../../../db/schema.js";
import { recordAuditSafe } from "../../audit.js";
import { fail, ok, type Actor, type ServiceResult } from "../../posts/types.js";
import { parsePublicHttpsUrl } from "../checks.js";
import type { ProviderId } from "../types.js";
import { PROVIDER_LABEL, ensureFreshAccount, getActiveAccount, safeErrorMessage, toConnected } from "./accounts.js";
import { listChannels } from "./channels.js";
import { distNow, getProvider, providerDeps } from "./env.js";
import { resolvePlan, type PlanOverrides, type ResolvedPlan } from "./prepare.js";
import { loadPostForDistribution } from "./post-source.js";
import { getActiveDistribution, getDistribution, listForPost, toItemDto, type DistributionRow } from "./rows.js";
import { kickDistribution } from "./runner.js";

const MAX_TEXT_CHARS = 20_000;
const MIN_SCHEDULE_LEAD_MS = 30_000;
const MAX_SCHEDULE_AHEAD_MS = 366 * 86_400_000;

export interface DraftInput {
  /** `null` — qo'lda tahrirni olib tashlab, standart shablonga qaytish. `undefined` — o'zgarmaydi. */
  text?: string | null | undefined;
  imageChoice?: DistributionImageChoice | undefined;
  linkMode?: DistributionLinkMode | null | undefined;
}

function pgCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
}

function validateDraft(provider: ProviderId, input: DraftInput): string | null {
  if (typeof input.text === "string" && input.text.length > MAX_TEXT_CHARS) return `Matn juda uzun (${MAX_TEXT_CHARS} belgidan oshmasin)`;
  if (typeof input.text === "string" && provider === "github") return "GitHub README bloki avtomatik yig'iladi — matn tahrirlanmaydi";
  if (input.imageChoice !== undefined && !DISTRIBUTION_IMAGE_CHOICES.includes(input.imageChoice)) return "Noto'g'ri rasm tanlovi";
  if (input.linkMode !== undefined && input.linkMode !== null && provider !== "linkedin") return "Havola rejimi faqat LinkedIn uchun";
  return null;
}

function draftFields(input: DraftInput): Partial<typeof distributions.$inferInsert> {
  const f: Partial<typeof distributions.$inferInsert> = {};
  if (input.text !== undefined) f.text = input.text === null || input.text.trim() === "" ? null : input.text;
  if (input.imageChoice !== undefined) f.imageChoice = input.imageChoice;
  if (input.linkMode !== undefined) f.linkMode = input.linkMode;
  return f;
}

/** Faol qatorni topadi yoki yaratadi (unique indeks bir vaqtdagi ikki yaratishni to'xtatadi). */
async function ensureActiveRow(actor: Actor, postId: string, provider: ProviderId): Promise<DistributionRow> {
  const existing = await getActiveDistribution(postId, provider);
  if (existing) return existing;
  const account = await getActiveAccount(provider);
  try {
    const [row] = await db
      .insert(distributions)
      .values({ postId, provider, accountId: account?.id ?? null, status: "draft", createdBy: actor.userId, createdVia: actor.via })
      .returning();
    if (row) return row;
  } catch (error) {
    if (pgCode(error) !== "23505") throw error;
  }
  const again = await getActiveDistribution(postId, provider);
  if (!again) throw new Error("Tarqatish qatorini yaratib bo'lmadi");
  return again;
}

async function guardPost(postId: string) {
  const post = await loadPostForDistribution(postId);
  if (!post || post.deletedAt) return null;
  return post;
}

function auditEntry(action: string, row: DistributionRow, summary: string, meta: Record<string, unknown> = {}) {
  return { action, entityType: "distribution", entityId: row.id, summary: `${PROVIDER_LABEL[row.provider as ProviderId]}: ${summary}`, meta: { postId: row.postId, provider: row.provider, ...meta } };
}

/**
 * Post savatda bo'lsa ham ro'yxat qaytadi (`postDeleted: true`): yuborilgan postlarni platformadan olib tashlash mumkin bo'lishi
 * uchun. Savatdagi postga yangi yuborish/rejalashtirish baribir mumkin emas (`guardPost`).
 */
export async function listPostDistributions(postId: string): Promise<ServiceResult<DistributionPostResponse>> {
  const post = await loadPostForDistribution(postId);
  if (!post) return fail("not_found", "Post topilmadi");
  const [channels, rows] = await Promise.all([listChannels(), listForPost(postId)]);
  return ok({ channels, distributions: rows.map(toItemDto), autoPost: false, ...(post.deletedAt ? { postDeleted: true as const } : {}) });
}

/** Matn/rasm tanlovini saqlaydi (qoralama). Hech narsa yuborilmaydi. */
export async function saveDraft(actor: Actor, postId: string, provider: ProviderId, input: DraftInput): Promise<ServiceResult<DistributionItemDto>> {
  if (!(await guardPost(postId))) return fail("not_found", "Post topilmadi");
  const invalid = validateDraft(provider, input);
  if (invalid) return fail("bad_request", invalid);
  const row = await ensureActiveRow(actor, postId, provider);
  if (!["draft", "failed", "scheduled"].includes(row.status)) {
    return fail("conflict", row.status === "sending" ? "Hozir yuborilmoqda — tahrirlab bo'lmaydi" : "Avval «tekshirish kerak» holatini hal qiling");
  }
  // Rejalashtirilgan tarqatishning matni o'zgarsa, "muzlatilgan" matn ham yangi ko'rsatilgan matnga yangilanadi.
  let frozen: Partial<typeof distributions.$inferInsert> = {};
  if (row.status === "scheduled" && provider !== "github") {
    const plan = await resolvePlan(postId, provider, { overrides: toOverrides(input), row });
    if (plan) frozen = { renderedText: plan.text };
  }
  const [updated] = await db
    .update(distributions)
    .set({ ...draftFields(input), ...frozen, updatedAt: distNow() })
    .where(and(eq(distributions.id, row.id), inArray(distributions.status, ["draft", "failed", "scheduled"])))
    .returning();
  if (!updated) return fail("conflict", "Holat o'zgargan — qayta urinib ko'ring");
  await recordAuditSafe(actor, auditEntry("distribution.save_text", updated, "matn/rasm saqlandi", { edited: updated.text !== null, imageChoice: updated.imageChoice }));
  return ok(toItemDto(updated));
}

function failChecks(plan: ResolvedPlan): ReturnType<typeof fail> {
  const first = plan.checks.filter((c) => c.status === "error").map((c) => c.message).slice(0, 3).join("; ");
  return fail("unprocessable", `Tekshiruv o'tmadi, hech narsa yuborilmadi: ${first}`, { checks: plan.checks, errorCount: plan.errorCount, warnCount: plan.warnCount });
}

export interface QueueInput extends DraftInput {
  /** Avval yuborilgan postni yana yuborishga rozilik (dublikat). */
  again?: boolean | undefined;
}

async function queue(
  actor: Actor,
  postId: string,
  provider: ProviderId,
  input: QueueInput,
  when: Date,
  kind: "send" | "schedule",
): Promise<ServiceResult<DistributionItemDto>> {
  const post = await guardPost(postId);
  if (!post) return fail("not_found", "Post topilmadi");
  const invalid = validateDraft(provider, input);
  if (invalid) return fail("bad_request", invalid);
  const existing = await getActiveDistribution(postId, provider);
  if (existing && !["draft", "failed", "scheduled"].includes(existing.status)) {
    return fail("conflict", existing.status === "sending" ? "Hozir yuborilmoqda" : "Natijasi noma'lum yuborish bor — avval uni hal qiling (tekshirish kerak)");
  }
  const plan = await resolvePlan(postId, provider, { overrides: toOverrides(input), row: existing });
  if (!plan) return fail("not_found", "Post topilmadi");
  if (plan.errorCount > 0) return failChecks(plan);
  if (provider !== "github" && !input.again) {
    const sent = await db.select().from(distributions).where(and(eq(distributions.postId, postId), eq(distributions.provider, provider), eq(distributions.status, "sent"))).limit(1);
    if (sent.length > 0) return fail("conflict", "Bu post shu kanalga allaqachon yuborilgan. Yana yuborish dublikat yaratadi — tasdiqlang (again).", { code: "already_sent", previous: toItemDto(sent[0]!) });
  }
  const row = await ensureActiveRow(actor, postId, provider);
  const account = await getActiveAccount(provider);
  const [updated] = await db
    .update(distributions)
    .set({
      ...draftFields(input),
      status: "scheduled",
      // Ko'rsatilgan matn va akkaunt "muzlatiladi": yuborish paytida postning keyingi o'zgarishi yoki boshqa akkaunt ta'sir qilmaydi.
      renderedText: provider === "github" ? null : plan.text,
      accountExternalId: account?.externalId ?? null,
      scheduledAt: when,
      nextAttemptAt: null,
      attempts: 0,
      lastErrorKind: null,
      lastErrorMessage: null,
      accountId: account?.id ?? row.accountId,
      createdBy: row.createdBy ?? actor.userId,
      updatedAt: distNow(),
    })
    .where(and(eq(distributions.id, row.id), inArray(distributions.status, ["draft", "failed", "scheduled"])))
    .returning();
  if (!updated) return fail("conflict", "Holat o'zgargan (boshqa so'rov oldinroq) — qayta urinib ko'ring");
  await recordAuditSafe(actor, auditEntry(kind === "send" ? "distribution.send" : "distribution.schedule", updated, kind === "send" ? "yuborish navbatga qo'yildi" : "yuborish rejalashtirildi", { scheduledAt: when.toISOString(), imageChoice: updated.imageChoice }));
  if (kind === "send") kickDistribution(updated.id);
  return ok(toItemDto(updated));
}

function toOverrides(input: DraftInput): PlanOverrides {
  const o: PlanOverrides = {};
  if (input.text !== undefined) o.text = input.text === null || input.text.trim() === "" ? null : input.text;
  if (input.imageChoice !== undefined) o.imageChoice = input.imageChoice;
  if (input.linkMode !== undefined) o.linkMode = input.linkMode;
  return o;
}

/** "Yuborish": navbatga qo'yadi; haqiqiy yuborish so'rovdan TASHQARIDA (scheduler/orqa fon). */
export function sendNow(actor: Actor, postId: string, provider: ProviderId, input: QueueInput = {}) {
  return queue(actor, postId, provider, input, distNow(), "send");
}

export function schedule(actor: Actor, postId: string, provider: ProviderId, at: Date, input: QueueInput = {}) {
  const now = distNow().getTime();
  if (Number.isNaN(at.getTime())) return Promise.resolve(fail("bad_request", "Vaqt noto'g'ri"));
  if (at.getTime() < now + MIN_SCHEDULE_LEAD_MS) return Promise.resolve(fail("bad_request", "Vaqt kamida bir necha soniya kelajakda bo'lishi kerak"));
  if (at.getTime() > now + MAX_SCHEDULE_AHEAD_MS) return Promise.resolve(fail("bad_request", "Vaqt bir yildan uzoq bo'lmasin"));
  return queue(actor, postId, provider, input, at, "schedule");
}

export async function cancel(actor: Actor, id: string): Promise<ServiceResult<DistributionItemDto>> {
  const row = await getDistribution(id);
  if (!row) return fail("not_found", "Topilmadi");
  const [updated] = await db
    .update(distributions)
    .set({ status: "cancelled", nextAttemptAt: null, updatedAt: distNow() })
    .where(and(eq(distributions.id, id), inArray(distributions.status, ["draft", "scheduled", "failed"])))
    .returning();
  if (!updated) {
    const msg =
      row.status === "sending" ? "Hozir yuborilmoqda — bekor qilib bo'lmaydi" : row.status === "needs_checking" ? "Natijasi noma'lum — «hal qilish» orqali yoping" : "Bu holatda bekor qilib bo'lmaydi";
    return fail("conflict", msg);
  }
  await recordAuditSafe(actor, auditEntry("distribution.cancel", updated, "bekor qilindi"));
  return ok(toItemDto(updated));
}

/** Qayta urinish: `failed` dan (resume `partial`dan). `needs_checking` dan — faqat `resolve(retry)` orqali, bilib turib. */
export async function retry(actor: Actor, id: string): Promise<ServiceResult<DistributionItemDto>> {
  const row = await getDistribution(id);
  if (!row) return fail("not_found", "Topilmadi");
  if (row.status === "needs_checking") return fail("conflict", "Natijasi noma'lum — avval platformada tekshiring; qayta urinish uchun «hal qilish → qayta urinish» (bilib turib)");
  if (row.status !== "failed") return fail("conflict", "Faqat xato bilan tugagan yuborishni qayta urinish mumkin");
  return requeue(actor, row, "distribution.retry", "qayta urinish navbatga qo'yildi");
}

async function requeue(actor: Actor, row: DistributionRow, action: string, summary: string): Promise<ServiceResult<DistributionItemDto>> {
  const plan = await resolvePlan(row.postId, row.provider as ProviderId, { row });
  if (!plan) return fail("not_found", "Post topilmadi");
  if (plan.errorCount > 0) return failChecks(plan);
  const now = distNow();
  const [updated] = await db
    .update(distributions)
    .set({ status: "scheduled", scheduledAt: now, nextAttemptAt: null, attempts: 0, updatedAt: now })
    .where(and(eq(distributions.id, row.id), inArray(distributions.status, ["failed", "needs_checking"])))
    .returning();
  if (!updated) return fail("conflict", "Holat o'zgargan — qayta urinib ko'ring");
  await recordAuditSafe(actor, auditEntry(action, updated, summary, { resume: Boolean(updated.partial), step: updated.step }));
  kickDistribution(updated.id);
  return ok(toItemDto(updated));
}

export type ResolveInput =
  | { action: "mark_sent"; url: string; externalId?: string | undefined }
  | { action: "retry"; confirmDuplicateRisk: boolean }
  | { action: "not_posted" };

/** "Tekshirish kerak" ni odam hal qiladi. */
export async function resolveNeedsChecking(actor: Actor, id: string, input: ResolveInput): Promise<ServiceResult<DistributionItemDto>> {
  const row = await getDistribution(id);
  if (!row) return fail("not_found", "Topilmadi");
  if (row.status !== "needs_checking") return fail("conflict", "Bu yuborish «tekshirish kerak» holatida emas");
  const now = distNow();
  if (input.action === "mark_sent") {
    const u = parsePublicHttpsUrl(input.url);
    if (!u) return fail("bad_request", "Post havolasi ochiq https URL bo'lishi kerak");
    const [updated] = await db
      .update(distributions)
      .set({ status: "sent", externalUrl: u.href, externalId: input.externalId ?? row.externalId, sentAt: now, lastErrorKind: null, lastErrorMessage: null, step: null, partial: null, updatedAt: now })
      .where(and(eq(distributions.id, id), eq(distributions.status, "needs_checking")))
      .returning();
    if (!updated) return fail("conflict", "Holat o'zgargan");
    await recordAuditSafe(actor, auditEntry("distribution.resolve_sent", updated, "qo'lda «yuborilgan» deb belgilandi", { manual: true }));
    return ok(toItemDto(updated));
  }
  if (input.action === "not_posted") {
    const [updated] = await db
      .update(distributions)
      .set({ status: "cancelled", nextAttemptAt: null, updatedAt: now })
      .where(and(eq(distributions.id, id), eq(distributions.status, "needs_checking")))
      .returning();
    if (!updated) return fail("conflict", "Holat o'zgargan");
    await recordAuditSafe(actor, auditEntry("distribution.resolve_not_posted", updated, "platformada yo'q — yopildi"));
    return ok(toItemDto(updated));
  }
  if (!input.confirmDuplicateRisk) return fail("bad_request", "Qayta urinish dublikat yaratishi mumkin — tasdiqlang (platformada post yo'qligini tekshirganingizdan keyin)");
  return requeue(actor, row, "distribution.resolve_retry", "bilib turib qayta urinish navbatga qo'yildi");
}

/** Yuborilgan postni platformadan olib tashlash (provider qo'llasa). Sinxron (bitta DELETE so'rovi, 30 s timeout). */
export async function removeFromPlatform(actor: Actor, id: string): Promise<ServiceResult<DistributionItemDto>> {
  const row = await getDistribution(id);
  if (!row) return fail("not_found", "Topilmadi");
  const provider = getProvider(row.provider as ProviderId);
  if (row.status !== "sent" || !row.externalId) return fail("conflict", "Faqat yuborilgan (va platforma id'si ma'lum) post olib tashlanadi");
  if (!provider.capabilities.delete) return fail("unprocessable", provider.capabilities.notes?.delete ?? "Bu platforma postni API orqali o'chirishni qo'llamaydi");
  let account = await getActiveAccount(row.provider as ProviderId);
  if (!account) return fail("unprocessable", "Akkaunt ulanmagan — avval ulang");
  try {
    account = await ensureFreshAccount(account);
    await provider.remove({ deps: providerDeps(), account: toConnected(account) }, row.externalId);
  } catch (error: unknown) {
    const safe = safeErrorMessage(error, account ? [toConnected(account).accessToken] : []);
    await recordAuditSafe(actor, auditEntry("distribution.remove_failed", row, "olib tashlash muvaffaqiyatsiz", { kind: safe.kind }));
    return fail("unprocessable", `Olib tashlab bo'lmadi: ${safe.message}`);
  }
  const now = distNow();
  const [updated] = await db
    .update(distributions)
    .set({ status: "cancelled", removedAt: now, updatedAt: now })
    .where(and(eq(distributions.id, id), eq(distributions.status, "sent")))
    .returning();
  await recordAuditSafe(actor, auditEntry("distribution.remove", updated ?? row, "platformadan olib tashlandi"));
  return ok(toItemDto(updated ?? row));
}

export async function getDistributionDto(id: string): Promise<ServiceResult<DistributionItemDto>> {
  const row = await getDistribution(id);
  return row ? ok(toItemDto(row)) : fail("not_found", "Topilmadi");
}


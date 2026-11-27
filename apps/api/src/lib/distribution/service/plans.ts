import { and, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { DISTRIBUTION_PLAN_MAX_DELAY_MINUTES, type ChannelCheck, type DistributionItemDto } from "@blog/shared";
import { db } from "../../../db/index.js";
import { distributions, posts } from "../../../db/schema.js";
import { recordAuditSafe } from "../../audit.js";
import { SCHEDULER_ACTOR, fail, ok, type Actor, type ServiceResult } from "../../posts/types.js";
import type { ProviderId } from "../types.js";
import { getActiveAccount } from "./accounts.js";
import { auditEntry, draftFields, ensureActiveRow, guardPost, toOverrides, validateDraft, type DraftInput } from "./actions.js";
import { distNow } from "./env.js";
import { resolvePlan, type PlanOverrides } from "./prepare.js";
import { getActiveDistribution, getLatestSent, toItemDto, type DistributionRow } from "./rows.js";
import { getVersion, listVersionRowsForPost } from "./versions.js";

/**
 * "Saytga chiqqach N daqiqadan keyin" (Telegram `channel_plan` ning ijtimoiy kanallardagi ekvivalenti).
 * Reja post chop etilishidan OLDIN (qoralama / rejalashtirilgan) qo'yiladi va faol `distributions` qatorida saqlanadi
 * (`plan_delay_minutes`, tanlangan versiya `version_id`da). Post chop etilgach (`posts/effects.ts` -> `announcePublished`, yoki
 * tick'dagi tiklash supurgisi) har bir reja mavjud mutlaq rejalashtirishga (`status=scheduled`, `scheduled_at = hozir + N`) aylanadi —
 * `queue()` bilan bir xil tekshiruvdan (`resolvePlan`) o'tib. O'tmasa qator `failed` (`plan_invalid`) bo'ladi, sababi ko'rinadi.
 */

/** Reja faqat shu post holatlarida o'rnatiladi: chop etilgan postda "Yuborish"/"Rejalashtirish" (mutlaq vaqt) ishlatiladi. */
const PLANNABLE_POST_STATUSES = ["draft", "in_review", "scheduled"];

export interface PlanInput extends DraftInput {
  delayMinutes: number;
  versionId?: string | undefined;
}

export function validDelay(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= DISTRIBUTION_PLAN_MAX_DELAY_MINUTES;
}

export interface PlanCheckSummary {
  checks: ChannelCheck[];
  errorCount: number;
  warnCount: number;
  text: string;
  length: number;
  limit: number | null;
}

/**
 * Plan qo'yishdan oldingi tekshiruv (hech narsa saqlanmaydi): chop etish bilan bog'liq "post chop etilgan" tekshiruvi tushiriladi
 * (post hali chop etilmagan — bu kutilgan holat). Yuborish paytida tekshiruv BARIBIR qayta ishlaydi.
 */
export async function checkPlan(postId: string, provider: ProviderId, input: DraftInput): Promise<PlanCheckSummary | null> {
  const plan = await resolvePlan(postId, provider, { overrides: toOverrides(input) });
  if (!plan) return null;
  const checks = plan.checks.filter((c) => c.id !== "dist.published");
  return {
    checks,
    errorCount: checks.filter((c) => c.status === "error").length,
    warnCount: checks.filter((c) => c.status === "warn").length,
    text: plan.text,
    length: plan.provider.measureText(plan.text),
    limit: plan.provider.limits.textMax ?? null,
  };
}

export async function setPlan(actor: Actor, postId: string, provider: ProviderId, input: PlanInput): Promise<ServiceResult<DistributionItemDto>> {
  const post = await guardPost(postId);
  if (!post) return fail("not_found", "Post topilmadi");
  if (!validDelay(input.delayMinutes)) return fail("bad_request", `Kechikish 0–${DISTRIBUTION_PLAN_MAX_DELAY_MINUTES} daqiqa oralig'ida butun son bo'lsin`);
  if (post.status === "published") return fail("conflict", "Post allaqachon chop etilgan — «Yuborish» yoki «Rejalashtirish» (aniq vaqt) ishlating");
  if (!PLANNABLE_POST_STATUSES.includes(post.status)) return fail("conflict", "Arxivlangan post uchun reja qo'yib bo'lmaydi");
  const invalid = validateDraft(provider, input);
  if (invalid) return fail("bad_request", invalid);

  let versionId: string | null = null;
  if (input.versionId) {
    const version = await getVersion(input.versionId);
    if (!version || version.postId !== postId || version.provider !== provider) return fail("bad_request", "Versiya topilmadi yoki bu post/kanalga tegishli emas");
    versionId = version.id;
  }

  const existing = await getActiveDistribution(postId, provider);
  if (existing && existing.status !== "draft") {
    return fail("conflict", existing.status === "sending" ? "Hozir yuborilmoqda" : "Bu kanalda faol yuborish bor (rejalashtirilgan/xato/tekshirish kerak) — avval uni bekor qiling yoki hal qiling");
  }
  // Versiya ham, matn ham berilmasa va kanalda "asosiy" versiya bo'lsa — reja shu versiyaga bog'lanadi (matni yuborish paytida o'qiladi).
  if (!versionId && provider !== "github" && input.text === undefined && !(existing?.text)) {
    const primary = (await listVersionRowsForPost(postId, provider)).find((v) => v.isPrimary);
    if (primary) versionId = primary.id;
  }

  const row = existing ?? (await ensureActiveRow(actor, postId, provider));
  const [updated] = await db
    .update(distributions)
    .set({ ...draftFields(input), versionId, planDelayMinutes: input.delayMinutes, planMaterializedAt: null, updatedAt: distNow() })
    .where(and(eq(distributions.id, row.id), eq(distributions.status, "draft")))
    .returning();
  if (!updated) return fail("conflict", "Holat o'zgargan (boshqa so'rov oldinroq) — qayta urinib ko'ring");
  await recordAuditSafe(actor, auditEntry("distribution.plan_set", updated, `«saytga chiqqach ${input.delayMinutes} daqiqa» rejasi qo'yildi`, { delayMinutes: input.delayMinutes, versionId }));
  return ok(toItemDto(updated));
}

export interface ClearPlanResult {
  /** Reja bor edi va olib tashlandi. */
  cleared: boolean;
  /** Rejadan hosil bo'lgan, hali yuborilmagan rejalashtirish ham bekor qilindi. */
  cancelled: boolean;
  distribution: DistributionItemDto | null;
}

export async function clearPlan(actor: Actor, postId: string, provider: ProviderId): Promise<ServiceResult<ClearPlanResult>> {
  const post = await guardPost(postId);
  if (!post) return fail("not_found", "Post topilmadi");
  const row = await getActiveDistribution(postId, provider);
  if (!row || row.planDelayMinutes === null) return ok({ cleared: false, cancelled: false, distribution: row ? toItemDto(row) : null });
  // Rejadan hosil bo'lgan va hali ketmagan rejalashtirish ("scheduled") bekor qilinadi; boshqa holatlarda faqat reja olib tashlanadi.
  const cancelIt = row.status === "scheduled" && row.planMaterializedAt !== null;
  const [updated] = await db
    .update(distributions)
    .set({ planDelayMinutes: null, planMaterializedAt: null, ...(cancelIt ? { status: "cancelled" as const, nextAttemptAt: null } : {}), updatedAt: distNow() })
    .where(and(eq(distributions.id, row.id), eq(distributions.status, row.status), isNotNull(distributions.planDelayMinutes)))
    .returning();
  if (!updated) return fail("conflict", "Holat o'zgargan — qayta urinib ko'ring");
  await recordAuditSafe(actor, auditEntry("distribution.plan_clear", updated, cancelIt ? "reja olib tashlandi va rejalashtirish bekor qilindi" : "reja olib tashlandi", { cancelled: cancelIt }));
  return ok({ cleared: true, cancelled: cancelIt, distribution: toItemDto(updated) });
}

// ---------------------------------------------------------------------------------------------
// Chop etilganda: reja -> mutlaq rejalashtirish
// ---------------------------------------------------------------------------------------------

const PLAN_FAIL_MAX = 380;

async function failPlanRow(row: DistributionRow, reason: string, now: Date, kind: "plan_invalid" | "internal"): Promise<boolean> {
  const [updated] = await db
    .update(distributions)
    .set({ status: "failed", lastErrorKind: kind, lastErrorMessage: `Reja bajarilmadi: ${reason}`.slice(0, PLAN_FAIL_MAX), nextAttemptAt: null, planMaterializedAt: now, updatedAt: now })
    .where(and(eq(distributions.id, row.id), eq(distributions.status, "draft"), isNull(distributions.planMaterializedAt)))
    .returning();
  if (updated) await recordAuditSafe(SCHEDULER_ACTOR, auditEntry("distribution.plan_failed", updated, "reja bajarilmadi", { reason: reason.slice(0, 200) }));
  return Boolean(updated);
}

/** Qatorning yuborish matni/rasmi: reja versiyaga bog'langan bo'lsa — versiyaning HOZIRGI matni; aks holda saqlangan matn yoki standart shablon. */
async function overridesFor(row: DistributionRow): Promise<PlanOverrides> {
  if (!row.versionId || row.provider === "github") return {};
  const version = await getVersion(row.versionId);
  if (!version || version.postId !== row.postId || version.provider !== row.provider) return {};
  return {
    text: version.text.trim() === "" ? null : version.text,
    imageChoice: version.imageChoice as PlanOverrides["imageChoice"] & string,
    ...(version.provider === "linkedin" ? { linkMode: version.linkMode as "article" | "text" | null } : {}),
  };
}

export type MaterializeOutcome = "scheduled" | "failed" | "skipped";

/**
 * BITTA rejani mutlaq rejalashtirishga aylantiradi: `scheduled_at = now + delay`. Idempotent: faqat `draft` + `plan_materialized_at IS NULL`
 * qator o'tadi va yangilash shu shart bilan bajariladi (ikki parallel chaqiruvdan faqat biri yutadi).
 */
export async function materializePlanRow(row: DistributionRow, now: Date = distNow()): Promise<MaterializeOutcome> {
  if (row.planDelayMinutes === null || row.planMaterializedAt !== null || row.status !== "draft") return "skipped";
  const provider = row.provider as ProviderId;
  const overrides = await overridesFor(row);
  const plan = await resolvePlan(row.postId, provider, { overrides, row });
  if (!plan) return "skipped";
  if (plan.post.status !== "published" || plan.post.deletedAt) return "skipped";
  if (plan.errorCount > 0) {
    const first = plan.checks.filter((c) => c.status === "error").map((c) => c.message).slice(0, 3).join("; ");
    return (await failPlanRow(row, `tekshiruv o'tmadi — ${first}`, now, "plan_invalid")) ? "failed" : "skipped";
  }
  if (provider !== "github" && (await getLatestSent(row.postId, provider))) {
    return (await failPlanRow(row, "bu post shu kanalga allaqachon yuborilgan — dublikat bo'lmasligi uchun yuborilmadi; kerak bo'lsa qo'lda «Yana yuborish»", now, "plan_invalid")) ? "failed" : "skipped";
  }
  const account = await getActiveAccount(provider);
  const at = new Date(now.getTime() + row.planDelayMinutes * 60_000);
  const [updated] = await db
    .update(distributions)
    .set({
      status: "scheduled",
      // `queue()` bilan bir xil "muzlatish": ko'rsatilgan matn va akkaunt rejalashtirish paytida qayd etiladi.
      renderedText: provider === "github" ? null : plan.text,
      accountExternalId: account?.externalId ?? null,
      accountId: account?.id ?? row.accountId,
      imageChoice: plan.imageChoice,
      ...(provider === "linkedin" ? { linkMode: plan.linkMode } : {}),
      scheduledAt: at,
      nextAttemptAt: null,
      attempts: 0,
      lastErrorKind: null,
      lastErrorMessage: null,
      planMaterializedAt: now,
      updatedAt: now,
    })
    .where(and(eq(distributions.id, row.id), eq(distributions.status, "draft"), isNull(distributions.planMaterializedAt)))
    .returning();
  if (!updated) return "skipped";
  await recordAuditSafe(SCHEDULER_ACTOR, auditEntry("distribution.plan_materialized", updated, "reja rejalashtirishga aylandi", { scheduledAt: at.toISOString(), delayMinutes: row.planDelayMinutes }));
  return "scheduled";
}

async function materializeSafely(row: DistributionRow, now: Date): Promise<MaterializeOutcome> {
  try {
    return await materializePlanRow(row, now);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "noma'lum xato";
    console.error(`Tarqatish rejasini bajarib bo'lmadi (${row.id}):`, message);
    // Jim tashlab ketilmaydi: qator "xato" bo'ladi (kutilmagan xato), odam ko'radi va «Qayta urinish» bosadi.
    try {
      return (await failPlanRow(row, "kutilmagan xato — «Qayta urinish»ni bosing", now, "internal")) ? "failed" : "skipped";
    } catch {
      return "skipped";
    }
  }
}

function pendingPlanRows(where: SQL) {
  return db
    .select({ row: distributions })
    .from(distributions)
    .innerJoin(posts, eq(posts.id, distributions.postId))
    .where(and(where, eq(distributions.status, "draft"), isNotNull(distributions.planDelayMinutes), isNull(distributions.planMaterializedAt), eq(posts.status, "published"), isNull(posts.deletedAt)));
}

/** Post chop etilgach chaqiriladi (barcha yo'llar: qo'lda, tasdiqlash, scheduler, MCP, Telegram buyrug'i). */
export async function materializePlansForPost(postId: string, now: Date = distNow()): Promise<{ scheduled: number; failed: number }> {
  const rows = await pendingPlanRows(eq(distributions.postId, postId));
  const out = { scheduled: 0, failed: 0 };
  for (const { row } of rows) {
    const outcome = await materializeSafely(row, now);
    if (outcome === "scheduled") out.scheduled += 1;
    else if (outcome === "failed") out.failed += 1;
  }
  return out;
}

/** Tick supurgisi: chop etish paytidagi chaqiruv uzilib qolgan bo'lsa (jarayon o'ldi) — reja baribir bajariladi. */
export async function materializeDuePlans(now: Date = distNow()): Promise<number> {
  const rows = await pendingPlanRows(sql`true`);
  let n = 0;
  for (const { row } of rows) {
    if ((await materializeSafely(row, now)) !== "skipped") n += 1;
  }
  return n;
}

/**
 * Post chop etilganlikdan chiqqanda (qoralama, arxiv, qayta rejalashtirish): rejadan hosil bo'lgan, hali YUBORILMAGAN rejalashtirishlar
 * qoralamaga qaytadi (REJA SAQLANADI: qayta chop etilsa yana bajariladi). Yuborilayotgan/yuborilgan/"tekshirish kerak" qatorlarga tegilmaydi.
 */
export async function revertPlansForPost(postId: string, now: Date = distNow()): Promise<number> {
  const reverted = await db
    .update(distributions)
    .set({ status: "draft", scheduledAt: null, nextAttemptAt: null, attempts: 0, lastErrorKind: null, lastErrorMessage: null, renderedText: null, step: null, partial: null, planMaterializedAt: null, updatedAt: now })
    .where(
      and(
        eq(distributions.postId, postId),
        isNotNull(distributions.planDelayMinutes),
        isNotNull(distributions.planMaterializedAt),
        isNull(distributions.sentAt),
        sql`(${distributions.status} = 'scheduled' or (${distributions.status} = 'failed' and ${distributions.lastErrorKind} in ('plan_invalid', 'internal') and ${distributions.attempts} = 0))`,
      ),
    )
    .returning();
  for (const row of reverted) await recordAuditSafe(SCHEDULER_ACTOR, auditEntry("distribution.plan_reverted", row, "post chop etilmagan — reja kutish holatiga qaytdi"));
  return reverted.length;
}


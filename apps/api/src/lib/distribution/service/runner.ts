import { and, eq, isNull, lte, lt, or, sql } from "drizzle-orm";
import type { DistributionLinkMode } from "@blog/shared";
import { config } from "../../../config.js";
import { db } from "../../../db/index.js";
import { distributionAccounts, distributions } from "../../../db/schema.js";
import { recordAuditSafe } from "../../audit.js";
import { SCHEDULER_ACTOR } from "../../posts/types.js";
import { DistributionError, isDistributionError } from "../errors.js";
import type { PartialRefs } from "../errors.js";
import type { ImageInput, ProviderId, PublishInput } from "../types.js";
import { PROVIDER_LABEL, ensureFreshAccount, getActiveAccount, safeErrorMessage, toConnected } from "./accounts.js";
import { distNow, getProvider, providerDeps } from "./env.js";
import { escapeHtml, notifyOwner } from "./notify.js";
import { resolvePlan } from "./prepare.js";
import { latestPublishedPosts, loadPostForDistribution, toDistributionPost } from "./post-source.js";
import { getDistribution, type DistributionRow } from "./rows.js";

/** Avtomatik urinishlar chegarasi (birinchi urinish bilan birga). Undan keyin `failed` — odam qayta urinadi. */
export const MAX_AUTO_ATTEMPTS = 5;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const RATE_LIMIT_MIN_MS = 60_000;
const RATE_LIMIT_MAX_MS = 6 * 3_600_000;
const RATE_LIMIT_DEFAULT_MS = 15 * 60_000;
/** `sending` holatida shuncha vaqt turib qolsa — jarayon o'lgan; noaniq natija sifatida "tekshirish kerak". */
export const STALE_SENDING_MS = 20 * 60_000;

export const ACCOUNT_CHANGED_MESSAGE = "Rejalashtirilgandan keyin bu kanalga BOSHQA akkaunt ulangan — yangi akkauntga yuborilmadi. Bekor qilib, qaytadan rejalashtiring (yoki yuboring)";

/** Tiklash belgisi: bu xabar bilan `needs_checking`ga o'tgan qatorga kech tugagan yuborishning natijasi yoziladi (qarang `finishSent`). */
export const RECOVERED_MESSAGE = "Yuborish jarayoni to'xtab qoldi (server qayta ishga tushgan bo'lishi mumkin). Platformada tekshiring.";

export function backoffFor(attempt: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempt - 1, 0), BACKOFF_MS.length - 1)]!;
}

export function rateLimitDelay(retryAt: Date | undefined, now: Date): number {
  if (!retryAt) return RATE_LIMIT_DEFAULT_MS;
  return Math.min(Math.max(retryAt.getTime() - now.getTime(), RATE_LIMIT_MIN_MS), RATE_LIMIT_MAX_MS);
}

function partialToStrings(p: PartialRefs | undefined): Record<string, string> | null {
  if (!p) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) if (typeof v === "string" && v) out[k] = v;
  return Object.keys(out).length > 0 ? out : null;
}

/** Orqa fonda darhol ishga tushirish (so'rov kutmaydi). Testlarda o'chiq — testlar `runDistribution`ni o'zi chaqiradi. */
export function kickDistribution(id: string): void {
  if (config.NODE_ENV === "test") return;
  setTimeout(() => {
    runDistribution(id).catch((error: unknown) => console.error("Tarqatishni ishga tushirishda xato:", error instanceof Error ? error.message : "noma'lum"));
  }, 0);
}

async function claim(id: string, now: Date): Promise<DistributionRow | null> {
  const [row] = await db
    .update(distributions)
    .set({ status: "sending", attempts: sql`${distributions.attempts} + 1`, updatedAt: now })
    .where(
      and(
        eq(distributions.id, id),
        eq(distributions.status, "scheduled"),
        or(isNull(distributions.scheduledAt), lte(distributions.scheduledAt, now)),
        or(isNull(distributions.nextAttemptAt), lte(distributions.nextAttemptAt, now)),
      ),
    )
    .returning();
  return row ?? null;
}

function secretsOf(account: Awaited<ReturnType<typeof getActiveAccount>>): string[] {
  if (!account) return [];
  const c = toConnected(account);
  return [c.accessToken, c.refreshToken ?? ""].filter(Boolean);
}

/**
 * Har bir "claim" o'z belgisiga ega: claim qatorning `updatedAt`ini `now`ga qo'yadi va bu qiymat shu urinish tugaguncha o'zgarmaydi
 * (`sending` holatidagi qatorni hech qanday boshqa yozuv o'zgartirmaydi; tiklash ham uni saqlab qoladi). Natija yozuvlari shu belgini
 * talab qiladi: eski urinishning kech natijasi (qayta urinish `attempts`ni nolga qaytargan) yangi urinishni bosib ketmaydi.
 */
const claimed = (row: DistributionRow) => eq(distributions.updatedAt, row.updatedAt);

async function finishSent(row: DistributionRow, result: { externalId: string; url: string | null }, text: string, titleForNotice: string): Promise<void> {
  const now = distNow();
  const sentFields = { status: "sent" as const, sentText: text, externalId: result.externalId, externalUrl: result.url, sentAt: now, lastErrorKind: null, lastErrorMessage: null, step: null, partial: null, nextAttemptAt: null, updatedAt: now };
  let [updated] = await db
    .update(distributions)
    .set(sentFields)
    .where(and(eq(distributions.id, row.id), eq(distributions.status, "sending"), claimed(row)))
    .returning();
  let late = false;
  if (!updated) {
    // Deploy kesishuvi: qator yuborish paytida (boshqa jarayon) "tekshirish kerak"ga o'tkazilgan bo'lishi mumkin. Platforma post'ni
    // yaratgani ANIQ bo'lgani uchun natija yoziladi — faqat tiklash belgisi turgan, shu urinishning qatoriga (odam hal qilgan qatorga tegilmaydi).
    [updated] = await db
      .update(distributions)
      .set(sentFields)
      .where(and(eq(distributions.id, row.id), eq(distributions.status, "needs_checking"), eq(distributions.lastErrorMessage, RECOVERED_MESSAGE), claimed(row)))
      .returning();
    late = Boolean(updated);
  }
  if (!updated) {
    await reportIgnoredLateSuccess(row, result, titleForNotice);
    return;
  }
  await recordAuditSafe(SCHEDULER_ACTOR, {
    action: "distribution.sent",
    entityType: "distribution",
    entityId: row.id,
    summary: `${PROVIDER_LABEL[row.provider as ProviderId]}: yuborildi`,
    meta: { postId: row.postId, provider: row.provider, attempts: row.attempts, via: row.createdVia, ...(late ? { recordedAfterRecovery: true } : {}) },
  });
}

/**
 * Platforma post chop etilganini xabar qildi, lekin qator bu urinishga tegishli emas (egasi "yuborilmagan" deb yopgan yoki bilib turib
 * qayta urindi). Egasining qarori saqlanadi, lekin platformadagi post jimgina yo'qolmasligi uchun audit yozuvi va bildirishnoma.
 */
async function reportIgnoredLateSuccess(row: DistributionRow, result: { externalId: string; url: string | null }, titleForNotice: string): Promise<void> {
  const current = await getDistribution(row.id);
  if (!current || current.status === "sent") return;
  const label = PROVIDER_LABEL[row.provider as ProviderId];
  const closed = current.status === "cancelled";
  await recordAuditSafe(SCHEDULER_ACTOR, {
    action: "distribution.late_result",
    entityType: "distribution",
    entityId: row.id,
    summary: `${label}: platforma postni chop etilgan deb xabar qildi, lekin yozuv boshqa holatda (${current.status}) — qo'lda tekshiring`,
    meta: { postId: row.postId, provider: row.provider, status: current.status, externalId: result.externalId, url: result.url },
  });
  const where = result.url ? ` ${escapeHtml(result.url)}` : ` (id: ${escapeHtml(result.externalId)})`;
  await notifyOwner(
    `⚠️ <b>${escapeHtml(label)}</b>: «${escapeHtml(titleForNotice)}» platformada chop etilgani xabar qilindi${where}, lekin panelda ${closed ? "«yuborilmadi» deb yopilgan edi" : "yozuv boshqa holatda"}. Qarori o'zgarmadi — postni platformada tekshiring.`,
  );
}

async function finishFailed(row: DistributionRow, error: unknown, secrets: readonly string[], titleForNotice: string): Promise<void> {
  const now = distNow();
  const safe = safeErrorMessage(error, secrets);
  const err = isDistributionError(error) ? error : null;
  const step = err?.step ?? row.step ?? null;
  const partial = partialToStrings(err?.partial) ?? row.partial ?? null;
  const base = { lastErrorKind: safe.kind, lastErrorMessage: safe.message, step, partial, updatedAt: now };
  const label = PROVIDER_LABEL[row.provider as ProviderId];

  if (err?.kind === "outcome_unknown") {
    // Noaniq natija: HECH QACHON avtomatik qayta urinilmaydi — odam platformani tekshiradi.
    const hit = await db.update(distributions).set({ ...base, status: "needs_checking", nextAttemptAt: null }).where(and(eq(distributions.id, row.id), eq(distributions.status, "sending"), claimed(row))).returning();
    if (hit.length === 0) return; // eski urinishning kech xatosi: yangi urinishga tegilmaydi
    await recordAuditSafe(SCHEDULER_ACTOR, { action: "distribution.needs_checking", entityType: "distribution", entityId: row.id, summary: `${label}: natija noma'lum — tekshirish kerak`, meta: { postId: row.postId, provider: row.provider, step } });
    await notifyOwner(`❓ <b>${escapeHtml(label)}</b>: «${escapeHtml(titleForNotice)}» yuborilgani noma'lum. Platformada tekshiring va panelda hal qiling (Tarqatish).`);
    return;
  }

  if (err?.retryable && row.attempts < MAX_AUTO_ATTEMPTS) {
    const delay = err.kind === "rate_limited" ? rateLimitDelay(err.retryAt, now) : backoffFor(row.attempts);
    const hit = await db.update(distributions).set({ ...base, status: "scheduled", nextAttemptAt: new Date(now.getTime() + delay) }).where(and(eq(distributions.id, row.id), eq(distributions.status, "sending"), claimed(row))).returning();
    if (hit.length === 0) return;
    await recordAuditSafe(SCHEDULER_ACTOR, { action: "distribution.retry_scheduled", entityType: "distribution", entityId: row.id, summary: `${label}: vaqtinchalik xato, qayta uriniladi`, meta: { postId: row.postId, provider: row.provider, kind: safe.kind, attempt: row.attempts, inSeconds: Math.round(delay / 1000) } });
    return;
  }

  const hit = await db.update(distributions).set({ ...base, status: "failed", nextAttemptAt: null }).where(and(eq(distributions.id, row.id), eq(distributions.status, "sending"), claimed(row))).returning();
  if (hit.length === 0) return;
  await recordAuditSafe(SCHEDULER_ACTOR, { action: "distribution.failed", entityType: "distribution", entityId: row.id, summary: `${label}: yuborilmadi (${safe.kind})`, meta: { postId: row.postId, provider: row.provider, kind: safe.kind, attempts: row.attempts, step } });
  await notifyOwner(`❌ <b>${escapeHtml(label)}</b>: «${escapeHtml(titleForNotice)}» yuborilmadi — ${escapeHtml(safe.message)}`);
}

export type RunOutcome = "skipped" | "sent" | "retry" | "failed" | "needs_checking";

/**
 * Bitta tarqatishni ATOMIK "claim" qilib bajaradi (`scheduled` -> `sending`; ikki jarayon/tick bir vaqtda olmaydi).
 * Hech qachon `outcome_unknown`ni qayta urinmaydi; faqat `transient`/`rate_limited` chegaralangan sonda, kutish bilan.
 */
export async function runDistribution(id: string, now: Date = distNow()): Promise<RunOutcome> {
  const row = await claim(id, now);
  if (!row) return "skipped";
  const providerId = row.provider as ProviderId;
  const provider = getProvider(providerId);
  let title = "post";
  let account = await getActiveAccount(providerId);
  try {
    const post0 = await loadPostForDistribution(row.postId);
    if (!post0) throw new DistributionError({ kind: "validation_rejected", message: "Post topilmadi" });
    title = post0.title;
    if (post0.deletedAt || post0.status !== "published") throw new DistributionError({ kind: "validation_rejected", message: "Post chop etilmagan yoki o'chirilgan — yuborilmadi" });
    if (!account) throw new DistributionError({ kind: "auth_expired", message: "Akkaunt ulanmagan — Sozlamalar → Tarqatish kanallari" });
    // Rejalashtirilgan akkaunt almashtirilgan bo'lsa (boshqa akkaunt ulangan) — yangi akkauntga POST QILINMAYDI.
    if (row.accountExternalId && account.externalId !== row.accountExternalId) {
      throw new DistributionError({ kind: "validation_rejected", message: ACCOUNT_CHANGED_MESSAGE });
    }
    account = await ensureFreshAccount(account);

    // Yuborish paytida QAYTA tayyorlanadi (rasm saqlashga yoziladi, tekshiruvlar yangilanadi), lekin matn — rejalashtirish
    // paytida ko'rsatilgani (`renderedText`): postning keyingi tahriri yuboriladigan matnni jimgina o'zgartirmaydi.
    const plan = await resolvePlan(row.postId, providerId, { row, forSend: true, ...(row.renderedText !== null && providerId !== "github" ? { overrides: { text: row.renderedText } } : {}) });
    if (!plan) throw new DistributionError({ kind: "validation_rejected", message: "Post topilmadi" });
    if (plan.errorCount > 0) {
      const first = plan.checks.filter((c) => c.status === "error").map((c) => c.message).slice(0, 3).join("; ");
      throw new DistributionError({ kind: "validation_rejected", message: `Tekshiruv o'tmadi: ${first}` });
    }

    const img = plan.image && plan.image.ok ? plan.image : null;
    const image: ImageInput | undefined =
      img && (providerId === "linkedin" || providerId === "x") ? { bytes: img.buffer, mime: img.mime, width: img.width, height: img.height, sizeBytes: img.sizeBytes, alt: plan.post.title.slice(0, 400) } : undefined;
    const input: PublishInput = {
      post: toDistributionPost(plan.post),
      text: plan.text,
      ...(image ? { image } : {}),
      ...(plan.imageUrl && img ? { imageUrl: plan.imageUrl } : {}),
      ...(plan.linkMode ? { linkMode: plan.linkMode as DistributionLinkMode } : {}),
      ...(providerId === "github" ? { latestPosts: await latestPublishedPosts(config.DISTRIBUTION_GITHUB_README_POSTS) } : {}),
      ...(row.partial && Object.keys(row.partial).length > 0 ? { resume: row.partial as PartialRefs } : {}),
    };
    const result = await provider.publish({ deps: providerDeps(), account: toConnected(account) }, input);
    await finishSent(row, result, plan.text, title);
    return "sent";
  } catch (error: unknown) {
    // Token yaroqsizligi: akkaunt "qayta ulash kerak" holatiga o'tadi (keyingi yuborishlar ham aniq xabar bilan to'xtaydi).
    if (isDistributionError(error) && error.kind === "auth_expired" && account && account.status !== "reauth_required") {
      await db.update(distributionAccounts).set({ status: "reauth_required", updatedAt: distNow() }).where(eq(distributionAccounts.id, account.id));
    }
    await finishFailed(row, error, secretsOf(account), title);
    const after = await getDistribution(row.id);
    return after?.status === "needs_checking" ? "needs_checking" : after?.status === "scheduled" ? "retry" : "failed";
  }
}

/** Scheduler tick'i: vaqti kelgan tarqatishlar. */
export async function runDueDistributions(now: Date = distNow()): Promise<number> {
  const due = await db
    .select({ id: distributions.id })
    .from(distributions)
    .where(and(eq(distributions.status, "scheduled"), or(isNull(distributions.scheduledAt), lte(distributions.scheduledAt, now)), or(isNull(distributions.nextAttemptAt), lte(distributions.nextAttemptAt, now))));
  let n = 0;
  for (const { id } of due) {
    // Bitta tarqatishdagi xato (masalan claim/finish paytidagi baza xatosi) qolganlarini to'xtatmasin. Qator `sending`da qolsa,
    // tiklash uni "tekshirish kerak"ka o'tkazadi (hech qachon avtomatik qayta yuborilmaydi).
    try {
      const outcome = await runDistribution(id, now);
      if (outcome !== "skipped") n += 1;
    } catch (error: unknown) {
      console.error(`Tarqatishni bajarishda xato (${id}):`, error instanceof Error ? error.message : "noma'lum");
    }
  }
  return n;
}

/**
 * Jarayon `sending` paytida to'xtab qolgan bo'lsa (deploy/crash) — yaratish so'rovi ketgan bo'lishi mumkin, shu sabab bu
 * "natija noma'lum" (`needs_checking`): avtomatik qayta urinilmaydi. `all=true` — ishga tushishda (hech narsa yuborilmayapti).
 */
export async function recoverInterruptedDistributions(now: Date = distNow(), all = false): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_SENDING_MS);
  const rows = await db
    .update(distributions)
    // `updatedAt` ataylab o'zgartirilmaydi: u shu urinishning claim belgisi (qarang `claimed`).
    .set({ status: "needs_checking", lastErrorKind: "outcome_unknown", lastErrorMessage: RECOVERED_MESSAGE })
    .where(and(eq(distributions.status, "sending"), all ? undefined : lt(distributions.updatedAt, cutoff)))
    .returning();
  for (const row of rows) {
    await recordAuditSafe(SCHEDULER_ACTOR, { action: "distribution.needs_checking", entityType: "distribution", entityId: row.id, summary: "Yuborish to'xtab qoldi — tekshirish kerak", meta: { postId: row.postId, provider: row.provider, recovered: true } });
  }
  return rows.length;
}

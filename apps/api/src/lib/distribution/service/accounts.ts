import { and, desc, eq, inArray, lt, ne } from "drizzle-orm";
import type { DistributionAccountDto, DistributionTokenState } from "@blog/shared";
import { db } from "../../../db/index.js";
import { distributionAccounts, distributionOauthStates } from "../../../db/schema.js";
import { recordAuditSafe } from "../../audit.js";
import { decryptSecret, encryptSecret } from "../../crypto.js";
import { fail, ok, SCHEDULER_ACTOR, type Actor, type ServiceResult } from "../../posts/types.js";
import { DistributionError, isDistributionError, sanitizeMessage } from "../errors.js";
import { createOAuthState, verifyOAuthState } from "../oauth-state.js";
import { DAY_MS } from "../token-status.js";
import type { ConnectedAccount, DistributionProvider, ProviderId } from "../types.js";
import { credentialsReady, getCredentials, isOAuthProvider, type OAuthProviderId } from "./credentials.js";
import { distNow, getProvider, providerDeps, redirectUrlFor } from "./env.js";
import { escapeHtml, notifyOwner } from "./notify.js";

export type AccountRow = typeof distributionAccounts.$inferSelect;

/** Qatordan deshifrlangan akkaunt — FAQAT server ichida (provayderga berish uchun). Hech qachon qaytarilmaydi/log qilinmaydi. */
export function toConnected(row: AccountRow): ConnectedAccount {
  return {
    provider: row.provider as ProviderId,
    externalId: row.externalId,
    displayName: row.displayName,
    username: row.username ?? undefined,
    accessToken: decryptSecret(row.accessTokenEnc),
    refreshToken: row.refreshTokenEnc ? decryptSecret(row.refreshTokenEnc) || null : null,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
    refreshTokenExpiresAt: row.refreshTokenExpiresAt,
    scopes: row.scopes,
    issuedAt: row.issuedAt,
    connectedAt: row.connectedAt,
    meta: row.meta,
  };
}

function tokenColumns(acc: ConnectedAccount) {
  return {
    accessTokenEnc: encryptSecret(acc.accessToken),
    refreshTokenEnc: acc.refreshToken ? encryptSecret(acc.refreshToken) : null,
    accessTokenExpiresAt: acc.accessTokenExpiresAt,
    refreshTokenExpiresAt: acc.refreshTokenExpiresAt,
    issuedAt: acc.issuedAt,
  };
}

/** Faol akkaunt: shu provider uchun eng oxirgi ulangan `active`/`reauth_required` (ikkinchisi imkonsiz emas, lekin hozircha bitta ishlatiladi). */
export async function getActiveAccount(provider: ProviderId): Promise<AccountRow | null> {
  const [row] = await db
    .select()
    .from(distributionAccounts)
    .where(and(eq(distributionAccounts.provider, provider), inArray(distributionAccounts.status, ["active", "reauth_required"])))
    .orderBy(desc(distributionAccounts.connectedAt))
    .limit(1);
  return row ?? null;
}

export async function getAccountById(id: string): Promise<AccountRow | null> {
  const [row] = await db.select().from(distributionAccounts).where(eq(distributionAccounts.id, id)).limit(1);
  return row ?? null;
}

/** Egasiga ko'rsatiladigan ko'rinish — tokenlarsiz. */
export function accountView(row: AccountRow, now: Date): DistributionAccountDto {
  const provider = getProvider(row.provider as ProviderId);
  const st = provider.tokenStatus(toConnected(row), now);
  const reauth = row.status === "reauth_required";
  const tokenState: DistributionTokenState = reauth ? "expired" : st.state;
  return {
    id: row.id,
    displayName: row.displayName,
    username: row.username,
    status: reauth ? "reauth_required" : "active",
    scopes: row.scopes,
    connectedAt: row.connectedAt.toISOString(),
    tokenState,
    expiresAt: st.expiresAt ? st.expiresAt.toISOString() : null,
    daysLeft: st.daysLeft,
    canRefresh: st.canRefresh,
  };
}

/** Qatorni yozadi (yangi yoki qayta ulash). Shu provider uchun boshqa akkauntlar `inactive` bo'ladi. */
async function persistConnected(actor: Actor, acc: ConnectedAccount): Promise<AccountRow> {
  const now = distNow();
  const values = {
    provider: acc.provider,
    externalId: acc.externalId,
    displayName: acc.displayName,
    username: acc.username ?? null,
    ...tokenColumns(acc),
    scopes: acc.scopes,
    meta: acc.meta ?? {},
    status: "active" as const,
    refreshAmbiguousAt: null,
    lastReminderAt: null,
    connectedAt: acc.connectedAt,
    connectedBy: actor.userId,
    updatedAt: now,
  };
  const [row] = await db
    .insert(distributionAccounts)
    .values(values)
    .onConflictDoUpdate({ target: [distributionAccounts.provider, distributionAccounts.externalId], set: { ...values, connectedAt: acc.connectedAt } })
    .returning();
  if (!row) throw new Error("Akkauntni saqlab bo'lmadi");
  await db
    .update(distributionAccounts)
    .set({ status: "inactive", updatedAt: now })
    .where(and(eq(distributionAccounts.provider, acc.provider), ne(distributionAccounts.id, row.id), inArray(distributionAccounts.status, ["active", "reauth_required"])));
  return row;
}

/** Platforma xatosini egasiga xavfsiz xabarga aylantiradi (maxfiy qiymatlarsiz). */
export function safeErrorMessage(error: unknown, secrets: readonly string[] = []): { kind: string; message: string } {
  if (isDistributionError(error)) {
    const extra = error.platformMessage ? ` — ${error.platformMessage}` : "";
    return { kind: error.kind, message: sanitizeMessage(`${error.message}${extra}`, secrets) };
  }
  return { kind: "internal", message: "Kutilmagan xato" };
}

// ---------------------------------------------------------------------------
// Ulash (OAuth)
// ---------------------------------------------------------------------------

export async function startConnect(actor: Actor, provider: ProviderId): Promise<ServiceResult<{ authorizationUrl: string; redirectUrl: string }>> {
  if (!isOAuthProvider(provider)) return fail("bad_request", "Bu provider OAuth bilan ulanmaydi (token yopishtiriladi)");
  const creds = await getCredentials(provider);
  if (!credentialsReady(provider, creds)) return fail("unprocessable", "Avval Client ID va Client Secret'ni kiriting va saqlang");
  const p = getProvider(provider);
  const now = distNow();
  // Eskirgan state'lar tozalanadi.
  await db.delete(distributionOauthStates).where(lt(distributionOauthStates.expiresAt, now));
  const created = createOAuthState({ provider, now, withPkce: p.auth.kind === "oauth_pkce" });
  await db.insert(distributionOauthStates).values({
    state: created.state,
    provider,
    codeVerifierEnc: created.record.codeVerifier ? encryptSecret(created.record.codeVerifier) : null,
    createdBy: actor.userId,
    expiresAt: created.record.expiresAt,
  });
  const redirectUrl = redirectUrlFor(provider);
  const authorizationUrl = p.auth.buildAuthorizationUrl!({ creds: { clientId: creds.clientId, clientSecret: creds.clientSecret || undefined, redirectUri: redirectUrl }, state: created.state, codeChallenge: created.codeChallenge });
  await recordAuditSafe(actor, { action: "distribution.account_connect_start", entityType: "distribution_account", entityId: provider, summary: `${PROVIDER_LABEL[provider]}: ulash boshlandi`, meta: { provider } });
  return ok({ authorizationUrl, redirectUrl });
}

export type CallbackReason = "state_invalid" | "state_expired" | "denied" | "exchange_failed" | "forbidden" | "not_configured";

export const CALLBACK_REASON_TEXT: Record<CallbackReason, string> = {
  state_invalid: "Ulanish so'rovi yaroqsiz yoki allaqachon ishlatilgan — qaytadan boshlang",
  state_expired: "Ulanish so'rovi muddati tugagan (10 daqiqa) — qaytadan boshlang",
  denied: "Platformada ruxsat berilmadi yoki bekor qilindi",
  exchange_failed: "Platforma tokenni bermadi — Client ID/Secret va redirect URL'ni tekshiring",
  forbidden: "Bu so'rov boshqa foydalanuvchi sessiyasi uchun boshlangan",
  not_configured: "Platforma ilovasi sozlanmagan",
};

export const PROVIDER_LABEL: Record<ProviderId, string> = { linkedin: "LinkedIn", x: "X", threads: "Threads", instagram: "Instagram", github: "GitHub" };

export async function completeConnect(
  actor: Actor,
  provider: ProviderId,
  query: { code?: string | undefined; state?: string | undefined; error?: string | undefined },
): Promise<{ ok: true; account: AccountRow } | { ok: false; reason: CallbackReason; detail?: string }> {
  const now = distNow();
  const received = query.state ?? "";
  // BIR MARTALIK: state qatori har qanday natijada (xato, rad etish, muddat) darhol o'chiriladi.
  const [stateRow] = received ? await db.delete(distributionOauthStates).where(eq(distributionOauthStates.state, received)).returning() : [];
  if (!stateRow) return { ok: false, reason: "state_invalid" };
  const verified = verifyOAuthState({ provider: stateRow.provider as ProviderId, state: stateRow.state, codeVerifier: undefined, expiresAt: stateRow.expiresAt }, received, provider, now);
  if (!verified.ok) return { ok: false, reason: verified.reason === "expired" ? "state_expired" : "state_invalid" };
  if (stateRow.createdBy && actor.userId && stateRow.createdBy !== actor.userId) return { ok: false, reason: "forbidden" };
  if (query.error) {
    await recordAuditSafe(actor, { action: "distribution.account_connect_failed", entityType: "distribution_account", entityId: provider, summary: `${PROVIDER_LABEL[provider]}: ulanish rad etildi`, meta: { provider, reason: "denied" } });
    return { ok: false, reason: "denied" };
  }
  if (!query.code || !isOAuthProvider(provider)) return { ok: false, reason: "state_invalid" };
  const creds = await getCredentials(provider);
  if (!credentialsReady(provider, creds)) return { ok: false, reason: "not_configured" };
  const p = getProvider(provider);
  try {
    const connected = await p.auth.exchangeCode!(providerDeps(), {
      creds: { clientId: creds.clientId, clientSecret: creds.clientSecret || undefined, redirectUri: redirectUrlFor(provider) },
      code: query.code,
      codeVerifier: stateRow.codeVerifierEnc ? decryptSecret(stateRow.codeVerifierEnc) : undefined,
    });
    const row = await persistConnected(actor, connected);
    await recordAuditSafe(actor, { action: "distribution.account_connect", entityType: "distribution_account", entityId: row.id, summary: `${PROVIDER_LABEL[provider]} akkaunti ulandi: ${row.displayName}`, meta: { provider, scopes: row.scopes } });
    return { ok: true, account: row };
  } catch (error: unknown) {
    const safe = safeErrorMessage(error, [creds.clientSecret, query.code]);
    await recordAuditSafe(actor, { action: "distribution.account_connect_failed", entityType: "distribution_account", entityId: provider, summary: `${PROVIDER_LABEL[provider]}: ulanish muvaffaqiyatsiz`, meta: { provider, kind: safe.kind } });
    return { ok: false, reason: "exchange_failed", detail: safe.message };
  }
}

/** GitHub: yopishtirilgan token provider orqali tekshiriladi, keyin shifrlab saqlanadi. */
export async function connectWithPastedToken(actor: Actor, provider: ProviderId, token: string): Promise<ServiceResult<{ account: DistributionAccountDto }>> {
  const p = getProvider(provider);
  if (p.auth.kind !== "pasted_token" || !p.auth.connectWithToken) return fail("bad_request", "Bu provider token yopishtirishni qo'llamaydi");
  const trimmed = token.trim();
  if (trimmed.length < 8 || /\s/.test(trimmed)) return fail("bad_request", "Token noto'g'ri ko'rinishda");
  try {
    const connected = await p.auth.connectWithToken(providerDeps(), trimmed);
    const row = await persistConnected(actor, connected);
    await recordAuditSafe(actor, { action: "distribution.account_connect", entityType: "distribution_account", entityId: row.id, summary: `${PROVIDER_LABEL[provider]} akkaunti ulandi: ${row.displayName}`, meta: { provider } });
    return ok({ account: accountView(row, distNow()) });
  } catch (error: unknown) {
    const safe = safeErrorMessage(error, [trimmed]);
    await recordAuditSafe(actor, { action: "distribution.account_connect_failed", entityType: "distribution_account", entityId: provider, summary: `${PROVIDER_LABEL[provider]}: token qabul qilinmadi`, meta: { provider, kind: safe.kind } });
    return fail("unprocessable", `Token qabul qilinmadi: ${safe.message}`);
  }
}

/**
 * Uzish: saqlangan tokenlar O'CHIRILADI. Hozirgi provider modullarida platforma "revoke" endpointi yo'q — shu sabab
 * tashqi chaqiruv QILINMAYDI (egasi kerak bo'lsa ruxsatni platforma sozlamalarida qaytarib oladi).
 */
export async function disconnectAccount(actor: Actor, provider: ProviderId): Promise<ServiceResult<{ removed: number }>> {
  const rows = await db.delete(distributionAccounts).where(eq(distributionAccounts.provider, provider)).returning();
  await recordAuditSafe(actor, { action: "distribution.account_disconnect", entityType: "distribution_account", entityId: provider, summary: `${PROVIDER_LABEL[provider]} akkaunti uzildi (tokenlar o'chirildi)`, meta: { provider, removed: rows.length } });
  return ok({ removed: rows.length });
}

// ---------------------------------------------------------------------------
// Token yangilash (bir akkaunt uchun bir vaqtda bitta)
// ---------------------------------------------------------------------------

const refreshLocks = new Map<string, Promise<RefreshOutcome>>();
const lastRefreshAttempt = new Map<string, number>();
const REFRESH_RETRY_MS = 10 * 60_000;

export type RefreshOutcome =
  | { ok: true; row: AccountRow }
  | { ok: false; row: AccountRow; error: DistributionError | null };

/**
 * Tokenni yangilaydi. TARTIB (shartnoma): yangilangan akkaunt (yangi refresh token bilan) bazaga YOZILADI, FAQAT shundan keyin
 * qaytariladi — chaqiruvchi yangi access token'dan undan keyin foydalanadi. `refresh_ambiguous`: eski tokenlar saqlanadi,
 * belgi qo'yiladi; keyingi yangilash ham muvaffaqiyatsiz bo'lsa akkaunt `reauth_required` bo'ladi.
 */
export function refreshAccount(row: AccountRow): Promise<RefreshOutcome> {
  const inflight = refreshLocks.get(row.id);
  if (inflight) return inflight;
  const run = doRefresh(row).finally(() => refreshLocks.delete(row.id));
  refreshLocks.set(row.id, run);
  return run;
}

async function doRefresh(row: AccountRow): Promise<RefreshOutcome> {
  const provider = getProvider(row.provider as ProviderId);
  if (!provider.auth.refresh) return { ok: false, row, error: null };
  const now = distNow();
  lastRefreshAttempt.set(row.id, now.getTime());
  const creds = isOAuthProvider(row.provider) ? await getCredentials(row.provider as OAuthProviderId) : { clientId: "", clientSecret: "" };
  try {
    const result = await provider.auth.refresh(providerDeps(), { clientId: creds.clientId, clientSecret: creds.clientSecret || undefined, redirectUri: redirectUrlFor(row.provider as ProviderId) }, toConnected(row));
    const [saved] = await db
      .update(distributionAccounts)
      .set({ ...tokenColumns(result.account), displayName: result.account.displayName, username: result.account.username ?? row.username, refreshAmbiguousAt: null, lastRefreshAt: now, status: "active", updatedAt: now })
      .where(eq(distributionAccounts.id, row.id))
      .returning();
    return { ok: true, row: saved ?? row };
  } catch (error: unknown) {
    const err = isDistributionError(error) ? error : null;
    const ambiguousBefore = row.refreshAmbiguousAt !== null;
    if (err?.kind === "refresh_ambiguous") {
      if (ambiguousBefore) {
        const [saved] = await markReauth(row, "Token yangilash natijasi ikki marta noma'lum — qayta ulang");
        return { ok: false, row: saved ?? row, error: err };
      }
      const [saved] = await db.update(distributionAccounts).set({ refreshAmbiguousAt: now, updatedAt: now }).where(eq(distributionAccounts.id, row.id)).returning();
      return { ok: false, row: saved ?? row, error: err };
    }
    if (err && (err.kind === "transient" || err.kind === "rate_limited")) return { ok: false, row, error: err };
    // auth_expired / permission / validation yoki oldin ham noaniq bo'lgan: qayta ulash kerak.
    const [saved] = await markReauth(row, err ? err.message : "Token yangilanmadi");
    return { ok: false, row: saved ?? row, error: err };
  }
}

async function markReauth(row: AccountRow, reason: string) {
  const now = distNow();
  const rows = await db.update(distributionAccounts).set({ status: "reauth_required", updatedAt: now }).where(and(eq(distributionAccounts.id, row.id), ne(distributionAccounts.status, "reauth_required"))).returning();
  if (rows.length > 0) {
    await recordAuditSafe(SCHEDULER_ACTOR, { action: "distribution.account_reauth_required", entityType: "distribution_account", entityId: row.id, summary: `${PROVIDER_LABEL[row.provider as ProviderId]}: qayta ulash kerak`, meta: { provider: row.provider, reason: sanitizeMessage(reason) } });
    await notifyOwner(`⚠️ <b>${escapeHtml(PROVIDER_LABEL[row.provider as ProviderId])}</b> akkaunti ishlamay qoldi — qayta ulang: Sozlamalar → Tarqatish kanallari.`);
  }
  return rows.length > 0 ? rows : [row];
}

/** Yuborishdan oldin: kerak bo'lsa tokenni yangilaydi. Akkaunt ishlamaydigan bo'lsa `DistributionError` tashlaydi. */
export async function ensureFreshAccount(row: AccountRow): Promise<AccountRow> {
  if (row.status === "reauth_required") throw new DistributionError({ kind: "auth_expired", message: "Akkaunt qayta ulanishi kerak (token yaroqsiz)" });
  const provider = getProvider(row.provider as ProviderId);
  const st = provider.tokenStatus(toConnected(row), distNow());
  if (st.refreshDue || (st.state === "expired" && st.canRefresh)) {
    const out = await refreshAccount(row);
    if (out.ok) return out.row;
    if (out.error) throw out.error;
    throw new DistributionError({ kind: "auth_expired", message: "Token yangilanmadi — qayta ulang" });
  }
  if (st.state === "expired") throw new DistributionError({ kind: "auth_expired", message: "Token muddati tugagan — qayta ulang" });
  return row;
}

// ---------------------------------------------------------------------------
// Scheduler: yangilash va eslatmalar
// ---------------------------------------------------------------------------

function daysText(n: number): string {
  return n <= 0 ? "bugun" : n === 1 ? "1 kundan keyin" : `${n} kundan keyin`;
}

/** Har tick'da: yangilash vaqti kelgan akkauntlarni yangilaydi. Qaytadi: urinishlar soni. */
export async function runTokenRefreshes(now: Date = distNow()): Promise<number> {
  const rows = await db.select().from(distributionAccounts).where(eq(distributionAccounts.status, "active"));
  let attempted = 0;
  for (const row of rows) {
    const provider = getProvider(row.provider as ProviderId);
    if (!provider.auth.refresh) continue;
    const st = provider.tokenStatus(toConnected(row), now);
    if (!st.refreshDue) continue;
    const last = lastRefreshAttempt.get(row.id) ?? 0;
    if (now.getTime() - last < REFRESH_RETRY_MS) continue;
    attempted += 1;
    await refreshAccount(row);
  }
  return attempted;
}

/**
 * Yangilanmaydigan tokenlar (LinkedIn 60 kun, GitHub): muddat yaqinlashganda (`remindBeforeMs`) egasiga Telegram orqali
 * eslatma — kuniga ko'pi bilan BITTA. Muddat tugaganda — "tugadi" xabari va akkaunt `reauth_required` (bir marta).
 */
export async function runTokenReminders(now: Date = distNow()): Promise<number> {
  const rows = await db.select().from(distributionAccounts).where(eq(distributionAccounts.status, "active"));
  let sent = 0;
  for (const row of rows) {
    const provider: DistributionProvider = getProvider(row.provider as ProviderId);
    if (provider.tokenPolicy.refresh !== "none") continue;
    const st = provider.tokenStatus(toConnected(row), now);
    if (!st.expiresAt) continue;
    const label = PROVIDER_LABEL[row.provider as ProviderId];
    if (st.state === "expired") {
      const [updated] = await db.update(distributionAccounts).set({ status: "reauth_required", lastReminderAt: now, updatedAt: now }).where(and(eq(distributionAccounts.id, row.id), eq(distributionAccounts.status, "active"))).returning();
      if (updated) {
        await notifyOwner(`🔴 <b>${escapeHtml(label)}</b> tokeni muddati tugadi — post yuborib bo'lmaydi. Qayta ulang: Sozlamalar → Tarqatish kanallari.`);
        await recordAuditSafe(SCHEDULER_ACTOR, { action: "distribution.token_expired", entityType: "distribution_account", entityId: row.id, summary: `${label} tokeni muddati tugadi`, meta: { provider: row.provider } });
        sent += 1;
      }
      continue;
    }
    if (!st.remindAt || now.getTime() < st.remindAt.getTime()) continue;
    if (row.lastReminderAt && now.getTime() - row.lastReminderAt.getTime() < DAY_MS) continue;
    const result = await notifyOwner(`🟡 <b>${escapeHtml(label)}</b> tokeni ${escapeHtml(daysText(st.daysLeft ?? 0))} tugaydi (${escapeHtml(st.expiresAt.toISOString().slice(0, 10))}). Qayta ulang: Sozlamalar → Tarqatish kanallari.`);
    if (result !== "error") {
      await db.update(distributionAccounts).set({ lastReminderAt: now }).where(eq(distributionAccounts.id, row.id));
      if (result === "sent") sent += 1;
    }
  }
  return sent;
}

/** Test yordamchisi. */
export function resetRefreshThrottle(): void {
  lastRefreshAttempt.clear();
}

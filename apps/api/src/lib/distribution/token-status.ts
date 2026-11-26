import type { ConnectedAccount } from "./types.js";

/**
 * Token holati: `ok` / `expiring` / `expired`. Soat inyeksiya qilinadi (test uchun soxta soat).
 * "expired" — token ENDI ishlamaydi va avtomatik tiklab bo'lmaydi (egasi qayta ulashi kerak).
 * Yangilash mumkin bo'lsa (`refreshDue`) holat `ok`/`expiring` bo'lib qoladi — chaqiruvchi avval refresh qiladi.
 */
export type TokenState = "ok" | "expiring" | "expired";

export interface TokenPolicy {
  /** Yangilash usuli: `rotating_refresh_token` (X), `self_exchange` (Threads/Instagram: eski token bilan), `none`. */
  refresh: "none" | "rotating_refresh_token" | "self_exchange";
  /** Muddat tugashiga shuncha qolganda holat `expiring`. */
  warnBeforeMs: number;
  /** Egasiga birinchi eslatma — tugashdan shuncha oldin. */
  remindBeforeMs: number;
  /** Access token tugashiga shuncha qolganda yangilash vaqti (refresh mumkin bo'lsa). */
  refreshLeadMs: number;
  /** Token berilgandan keyin kamida shuncha o'tmaguncha yangilab bo'lmaydi (Threads/Instagram: 24 soat). */
  minRefreshAgeMs?: number;
  /** Ixtiyoriy: platforma muddat bermagan (`accessTokenExpiresAt = null`) token tugamaydi (Instagram Unified Login'dagi tizim foydalanuvchisi tokeni). */
  nonExpiringWhenNoExpiry?: boolean;
}

export interface TokenStatus {
  state: TokenState;
  /** Token (yoki refresh orqali davom ettirilganda refresh token) tugash vaqti; noma'lum bo'lsa null. */
  expiresAt: Date | null;
  /** Hozir avtomatik yangilab bo'ladimi. */
  canRefresh: boolean;
  /** Hozir yangilash kerakmi (refresh mumkin va vaqti kelgan). */
  refreshDue: boolean;
  /** Egasiga eslatma vaqti (tugashdan `remindBeforeMs` oldin); muddat noma'lum yoki refresh bilan yashayotgan bo'lsa null. */
  remindAt: Date | null;
  /** Tugashgacha to'liq kunlar (yuqoriga yaxlitlangan), muddat noma'lum bo'lsa null. */
  daysLeft: number | null;
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export function getTokenStatus(
  account: Pick<ConnectedAccount, "accessTokenExpiresAt" | "refreshToken" | "refreshTokenExpiresAt" | "issuedAt">,
  policy: TokenPolicy,
  now: Date,
): TokenStatus {
  const t = now.getTime();
  const accessExp = account.accessTokenExpiresAt?.getTime() ?? null;
  const refreshExp = account.refreshTokenExpiresAt?.getTime() ?? null;
  const accessExpired = accessExp !== null && accessExp <= t;
  const oldEnough = policy.minRefreshAgeMs === undefined || t - account.issuedAt.getTime() >= policy.minRefreshAgeMs;

  let canRefresh = false;
  if (policy.refresh === "rotating_refresh_token") canRefresh = Boolean(account.refreshToken) && (refreshExp === null || refreshExp > t);
  else if (policy.refresh === "self_exchange") canRefresh = !accessExpired && oldEnough;

  // Refresh bilan davom etganda umr — refresh token muddati (null = noma'lum/cheksiz); aks holda access token muddati.
  const continuesUntil = policy.refresh === "rotating_refresh_token" && canRefresh ? refreshExp : accessExp;

  let state: TokenState = "ok";
  if (continuesUntil !== null) {
    if (continuesUntil <= t) state = "expired";
    else if (continuesUntil - t <= policy.warnBeforeMs) state = "expiring";
  }

  return {
    state,
    expiresAt: continuesUntil === null ? null : new Date(continuesUntil),
    canRefresh,
    refreshDue: canRefresh && accessExp !== null && accessExp - t <= policy.refreshLeadMs,
    remindAt: continuesUntil === null ? null : new Date(continuesUntil - policy.remindBeforeMs),
    daysLeft: continuesUntil === null ? null : Math.max(0, Math.ceil((continuesUntil - t) / DAY_MS)),
  };
}

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { codeChallengeS256, generateCodeVerifier, generateState } from "./pkce.js";
import type { ProviderId } from "./types.js";

/**
 * OAuth `state` va PKCE verifier'ni yaratish/tekshirish uchun kichik sof juftlik. Saqlash VA bir martalik ishlatish —
 * chaqiruvchining vazifasi: yozuvni (masalan DB'da, `expiresAt` bilan) saqlang, callback kelganda `verifyOAuthState`
 * muvaffaqiyatli bo'lsa yozuvni DARHOL o'chiring (consume), shunda state qayta ishlatilmaydi. `codeVerifier` maxfiy:
 * brauzerga bermang va log qilmang (`encryptSecret` bilan saqlash tavsiya).
 */
export interface OAuthStateRecord {
  provider: ProviderId;
  state: string;
  /** PKCE (faqat `withPkce`). */
  codeVerifier?: string;
  expiresAt: Date;
}

export interface CreatedOAuthState {
  record: OAuthStateRecord;
  /** `buildAuthorizationUrl` ga beriladi. */
  state: string;
  codeChallenge?: string;
}

export const OAUTH_STATE_TTL_MS = 10 * 60_000;

export function createOAuthState(opts: {
  provider: ProviderId;
  now: Date;
  ttlMs?: number;
  withPkce?: boolean;
  bytes?: (n: number) => Uint8Array;
}): CreatedOAuthState {
  const bytes = opts.bytes ?? randomBytes;
  const state = generateState(bytes);
  const codeVerifier = opts.withPkce ? generateCodeVerifier(bytes) : undefined;
  return {
    record: { provider: opts.provider, state, codeVerifier, expiresAt: new Date(opts.now.getTime() + (opts.ttlMs ?? OAUTH_STATE_TTL_MS)) },
    state,
    codeChallenge: codeVerifier ? codeChallengeS256(codeVerifier) : undefined,
  };
}

export type OAuthStateCheck = { ok: true; codeVerifier?: string } | { ok: false; reason: "mismatch" | "expired" | "provider" };

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Doimiy vaqtli solishtirish (SHA-256 xeshlari orqali — uzunlik farqi ham sizmaydi) + muddat + provider tekshiruvi. */
export function verifyOAuthState(record: OAuthStateRecord, received: string | null | undefined, provider: ProviderId, now: Date): OAuthStateCheck {
  const match = timingSafeEqual(digest(record.state), digest(received ?? ""));
  if (!match) return { ok: false, reason: "mismatch" };
  if (record.provider !== provider) return { ok: false, reason: "provider" };
  if (now.getTime() >= record.expiresAt.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, codeVerifier: record.codeVerifier };
}

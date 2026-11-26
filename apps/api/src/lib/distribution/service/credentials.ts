import { SECRET_KEEP_PREFIX, type DistributionCredentialField, type DistributionCredentialsPatch } from "@blog/shared";
import { config } from "../../../config.js";
import { db } from "../../../db/index.js";
import { siteSettings } from "../../../db/schema.js";
import { eq } from "drizzle-orm";
import { decryptSecret, encryptSecret, maskSecret } from "../../crypto.js";
import { upsertSiteSetting } from "../../site-settings.js";
import type { ProviderId } from "../types.js";

/**
 * Platforma ilovasi kalitlari (client id / secret). Mavjud sozlamalar mexanizmi bilan bir xil qoidalar: sirlar `encryptSecret`
 * bilan shifrlangan holda `site_settings`da ("settings:distribution"), env bo'sh bo'lmasa env > DB, sir hech qachon qaytmaydi
 * (faqat maska), maskalangan qiymat yuborilsa "o'zgartirma" ma'nosida.
 */

export const OAUTH_PROVIDERS = ["linkedin", "x", "threads", "instagram"] as const satisfies readonly ProviderId[];
export type OAuthProviderId = (typeof OAUTH_PROVIDERS)[number];

const KEY = "settings:distribution";

const ENV: Record<OAuthProviderId, { id: string; secret: string; idValue: () => string; secretValue: () => string }> = {
  linkedin: { id: "DISTRIBUTION_LINKEDIN_CLIENT_ID", secret: "DISTRIBUTION_LINKEDIN_CLIENT_SECRET", idValue: () => config.DISTRIBUTION_LINKEDIN_CLIENT_ID, secretValue: () => config.DISTRIBUTION_LINKEDIN_CLIENT_SECRET },
  x: { id: "DISTRIBUTION_X_CLIENT_ID", secret: "DISTRIBUTION_X_CLIENT_SECRET", idValue: () => config.DISTRIBUTION_X_CLIENT_ID, secretValue: () => config.DISTRIBUTION_X_CLIENT_SECRET },
  threads: { id: "DISTRIBUTION_THREADS_CLIENT_ID", secret: "DISTRIBUTION_THREADS_CLIENT_SECRET", idValue: () => config.DISTRIBUTION_THREADS_CLIENT_ID, secretValue: () => config.DISTRIBUTION_THREADS_CLIENT_SECRET },
  instagram: { id: "DISTRIBUTION_INSTAGRAM_CLIENT_ID", secret: "DISTRIBUTION_INSTAGRAM_CLIENT_SECRET", idValue: () => config.DISTRIBUTION_INSTAGRAM_CLIENT_ID, secretValue: () => config.DISTRIBUTION_INSTAGRAM_CLIENT_SECRET },
};

type Raw = Partial<Record<OAuthProviderId, { clientId?: string; clientSecret?: string }>>;

export function isOAuthProvider(id: string): id is OAuthProviderId {
  return (OAUTH_PROVIDERS as readonly string[]).includes(id);
}

async function loadRaw(): Promise<Raw> {
  const [row] = await db.select().from(siteSettings).where(eq(siteSettings.key, KEY)).limit(1);
  return (row?.value as Raw | undefined) ?? {};
}

export interface ResolvedCredentials {
  clientId: string;
  clientSecret: string;
  /** DB'da shifrlangan Client Secret bor, lekin deshifrlanmaydi (`BETTER_AUTH_SECRET` almashtirilgan) va env'dan ham berilmagan. */
  secretUnreadable?: boolean;
}

/** Saqlangan (shifrlangan) qiymat bor, lekin deshifrlanganda bo'sh — kalit almashtirilgan yoki qiymat buzilgan. */
export function isUnreadableSecret(stored: string | null | undefined): boolean {
  return Boolean(stored) && decryptSecret(stored) === "";
}

export const UNREADABLE_CREDENTIALS_MESSAGE = "Saqlangan Client Secret o'qib bo'lmadi (maxfiy kalit o'zgargan) — Client Secret'ni qaytadan kiriting";

/** env (bo'sh bo'lmasa) > DB. Deshifrlangan qiymat FAQAT server ichida (token almashtirish) ishlatiladi. */
export async function getCredentials(provider: OAuthProviderId): Promise<ResolvedCredentials> {
  const raw = (await loadRaw())[provider] ?? {};
  const env = ENV[provider];
  const secret = env.secretValue() || decryptSecret(raw.clientSecret);
  return {
    clientId: env.idValue() || raw.clientId || "",
    clientSecret: secret,
    ...(!env.secretValue() && isUnreadableSecret(raw.clientSecret) ? { secretUnreadable: true } : {}),
  };
}

/** Tayyor: client id va (X'dan tashqari hammasida majburiy) client secret bor. X — public client bo'lishi mumkin. */
export function credentialsReady(provider: OAuthProviderId, creds: ResolvedCredentials): boolean {
  if (!creds.clientId) return false;
  // X public client bo'lishi mumkin, lekin saqlangan sir BOR-u o'qilmasa — sozlanmagan hisoblanadi (jimgina sirsiz davom etmaydi).
  if (creds.secretUnreadable) return false;
  return provider === "x" ? true : Boolean(creds.clientSecret);
}

export async function getCredentialsAdmin(provider: OAuthProviderId): Promise<{ clientId: DistributionCredentialField; clientSecret: DistributionCredentialField }> {
  const raw = (await loadRaw())[provider] ?? {};
  const env = ENV[provider];
  const idEnv = env.idValue();
  const secretEnv = env.secretValue();
  const dbSecret = decryptSecret(raw.clientSecret);
  return {
    clientId: idEnv
      ? { value: idEnv, source: "env", isSet: true, envVar: env.id }
      : { value: raw.clientId ?? "", source: raw.clientId ? "db" : "none", isSet: Boolean(raw.clientId), envVar: env.id },
    clientSecret: secretEnv
      ? { value: maskSecret(secretEnv), source: "env", isSet: true, envVar: env.secret }
      : { value: dbSecret ? maskSecret(dbSecret) : "", source: dbSecret ? "db" : "none", isSet: Boolean(dbSecret), envVar: env.secret },
  };
}

export class CredentialsValidationError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super("Sozlamalarda xatolik topildi");
    this.name = "CredentialsValidationError";
  }
}

/** `undefined`/maska = o'zgarmaydi; "" = tozalash; boshqa = yangi qiymat. Env'dan qulflangan maydonni o'zgartirishga urinish xato. */
export async function saveCredentials(patch: DistributionCredentialsPatch): Promise<void> {
  const raw = await loadRaw();
  const errors: Record<string, string> = {};
  for (const provider of OAUTH_PROVIDERS) {
    const p = patch[provider];
    if (!p) continue;
    const env = ENV[provider];
    const next = { ...(raw[provider] ?? {}) };
    if (p.clientId !== undefined) {
      if (env.idValue()) {
        if (p.clientId.trim() !== env.idValue()) errors[`${provider}.clientId`] = `env'dan qulflangan (${env.id}) — panelda o'zgartirib bo'lmaydi`;
      } else if (/\s/.test(p.clientId.trim())) errors[`${provider}.clientId`] = "Bo'shliq bo'lmasligi kerak";
      else next.clientId = p.clientId.trim();
    }
    if (p.clientSecret !== undefined && !p.clientSecret.startsWith(SECRET_KEEP_PREFIX)) {
      if (env.secretValue()) errors[`${provider}.clientSecret`] = `env'dan qulflangan (${env.secret}) — panelda o'zgartirib bo'lmaydi`;
      else if (p.clientSecret === "") next.clientSecret = "";
      else if (/\s/.test(p.clientSecret)) errors[`${provider}.clientSecret`] = "Bo'shliq bo'lmasligi kerak";
      else next.clientSecret = encryptSecret(p.clientSecret);
    }
    raw[provider] = next;
  }
  if (Object.keys(errors).length > 0) throw new CredentialsValidationError(errors);
  await upsertSiteSetting(KEY, raw);
}

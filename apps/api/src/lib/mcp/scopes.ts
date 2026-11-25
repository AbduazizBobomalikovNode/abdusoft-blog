import { MCP_GRANTABLE_OAUTH_SCOPES, MCP_GRANTABLE_SCOPE_IDS, MCP_OFFLINE_SCOPE, MCP_SCOPES } from "@blog/shared";

/**
 * Authorization server FAQAT hozir berilishi mumkin bo'lgan ruxsatlarni taniydi (o'qish + `offline_access`).
 * To'liq ruxsatlar modeli `@blog/shared`da qoladi, lekin yozuv vositalari yo'qligida ular berilmaydi.
 */
export const OAUTH_SCOPES: string[] = [...MCP_GRANTABLE_OAUTH_SCOPES];

/** Ruxsat qilinmagan so'rov uchun standart: faqat o'qish + ulanishni saqlash. */
export const DEFAULT_SCOPE_STRING = [...MCP_GRANTABLE_SCOPE_IDS, MCP_OFFLINE_SCOPE].join(" ");

/**
 * `/mcp` 401 javobidagi `scope` — berilishi mumkin bo'lgan BARCHA ruxsatlar + `offline_access`: klient aynan shularni so'raydi,
 * aks holda refresh token berilmaydi.
 */
export const CHALLENGE_SCOPES: string[] = [...MCP_GRANTABLE_OAUTH_SCOPES];

/** Metadata (`scope_descriptions`) uchun inglizcha tavsiflar (faqat berilishi mumkinlari). */
export const SCOPE_DESCRIPTIONS_EN: Record<string, string> = {
  ...Object.fromEntries(MCP_SCOPES.filter((scope) => MCP_GRANTABLE_SCOPE_IDS.includes(scope.id)).map((scope) => [scope.id, scope.english])),
  [MCP_OFFLINE_SCOPE]: "Stay connected: lets the application renew its access without asking you to sign in again.",
};

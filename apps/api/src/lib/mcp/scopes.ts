import { MCP_OFFLINE_SCOPE, MCP_OPENID_SCOPE, MCP_SCOPES, MCP_SCOPE_IDS } from "@blog/shared";

/** Authorization server taniydigan barcha scope'lar. `openid` — ba'zi klientlar yuboradi (e'lon qilinmaydi). */
export const OAUTH_SCOPES: string[] = [MCP_OPENID_SCOPE, MCP_OFFLINE_SCOPE, ...MCP_SCOPE_IDS];

/**
 * `/mcp` 401 javobidagi `scope` — BARCHA ruxsatlar + `offline_access`: klient aynan shularni so'raydi, aks holda
 * tor token oladi va refresh token umuman berilmaydi (u faqat `offline_access` so'ralganda chiqadi).
 */
export const CHALLENGE_SCOPES: string[] = [...MCP_SCOPE_IDS, MCP_OFFLINE_SCOPE];

/** Metadata (`scope_descriptions`) uchun inglizcha tavsiflar. */
export const SCOPE_DESCRIPTIONS_EN: Record<string, string> = {
  ...Object.fromEntries(MCP_SCOPES.map((scope) => [scope.id, scope.english])),
  [MCP_OFFLINE_SCOPE]: "Stay connected: lets the application renew its access without asking you to sign in again.",
};

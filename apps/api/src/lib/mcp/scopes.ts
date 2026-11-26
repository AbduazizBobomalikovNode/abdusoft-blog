import { MCP_OFFLINE_SCOPE, MCP_SCOPES, MCP_SCOPE_IDS, clampToGrantable, grantableOAuthScopes, grantableScopeIds } from "@blog/shared";
import { config } from "../../config.js";

/**
 * Hozir (HAR SO'ROVDA, `config` bo'yicha) berilishi mumkin bo'lgan ruxsatlar: `MCP_WRITE_TOOLS_ENABLED` o'chiq bo'lsa faqat
 * o'qish + `offline_access` (PR #11 bilan bir xil), yoqilgan bo'lsa barcha yozuv ruxsatlari ham. Authorization server
 * to'liq ro'yxatni tanib turadi (`ALL_OAUTH_SCOPES`), lekin berish faqat shu yerda hal qilinadi (ro'yxatdan o'tish,
 * authorize, rozilik, token -> `principal.ts`).
 */
export const writeToolsEnabled = (): boolean => config.MCP_WRITE_TOOLS_ENABLED;

export const ALL_OAUTH_SCOPES: string[] = [...MCP_SCOPE_IDS, MCP_OFFLINE_SCOPE];

/** `social:post` faqat `DISTRIBUTION_ENABLED` ham yoqilganda (yozuv kaliti bilan birga) beriladi. */
export const distributionEnabled = (): boolean => config.DISTRIBUTION_ENABLED;

export const grantableNow = (): string[] => [...grantableOAuthScopes(writeToolsEnabled(), distributionEnabled())];
export const grantableIdsNow = (): string[] => [...grantableScopeIds(writeToolsEnabled(), distributionEnabled())];
export const clampNow = (scopes: readonly string[]): string[] => clampToGrantable(scopes, writeToolsEnabled(), distributionEnabled());

/**
 * Ruxsat so'ralmagan so'rov uchun standart: faqat o'qish + ulanishni saqlash. Yozuv HECH QACHON standart emas — klient
 * yozuv ruxsatlarini aniq so'rashi va foydalanuvchi rozilik sahifasida belgilashi kerak.
 */
export const DEFAULT_SCOPE_STRING = ["blog:read", MCP_OFFLINE_SCOPE].join(" ");

/**
 * `/mcp` 401 javobidagi `scope` — berilishi mumkin bo'lgan BARCHA ruxsatlar + `offline_access`: klient aynan shularni so'raydi,
 * aks holda refresh token berilmaydi.
 */
export const challengeScopes = (): string[] => grantableNow();

/** Metadata (`scope_descriptions`) uchun inglizcha tavsiflar (faqat hozir berilishi mumkinlari). */
export function scopeDescriptionsEn(): Record<string, string> {
  const ids = grantableIdsNow();
  return {
    ...Object.fromEntries(MCP_SCOPES.filter((scope) => ids.includes(scope.id)).map((scope) => [scope.id, scope.english])),
    [MCP_OFFLINE_SCOPE]: "Stay connected: lets the application renew its access without asking you to sign in again.",
  };
}

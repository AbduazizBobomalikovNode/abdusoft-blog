import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { MCP_GRANTABLE_OAUTH_SCOPES, MCP_OFFLINE_SCOPE } from "@blog/shared";
import { config } from "../../config.js";
import { revokeAllConnections } from "./connections.js";
import { MCP_CONSENT_PAGE, MCP_LOGIN_PAGE, MCP_RESOURCE_URL } from "./endpoints.js";
import { isAllowedRedirectUri } from "./redirect-policy.js";
import { OAUTH_SCOPES, SCOPE_DESCRIPTIONS_EN } from "./scopes.js";

type MetadataFetch = typeof fetchClientMetadataResource;

// Faqat testlar uchun: CIMD hujjatini tarmoqsiz taqdim etish. Production'da hech qachon o'rnatilmaydi.
let cimdFetchOverride: MetadataFetch | null = null;
export function setCimdFetchForTests(fn: MetadataFetch | null): void {
  cimdFetchOverride = fn;
}

const cimdFetch: MetadataFetch = (input, init) => (cimdFetchOverride ?? fetchClientMetadataResource)(input, init);

/**
 * MCP avtorizatsiya serveri plagin'lari. Faqat `MCP_ENABLED=true` bo'lganda `lib/auth.ts` ularni ro'yxatga oladi —
 * o'chiq bo'lsa Better Auth avvalgidek (plagin'siz) ishlaydi.
 *
 * - `jwt()` — access token'larni imzolash (JWKS `jwks` jadvalida).
 * - `mcp()` — OAuth 2.1 provider: PKCE (S256), dinamik ro'yxatdan o'tish, rozilik, refresh rotatsiyasi; token `aud`i
 *   `MCP_RESOURCE_URL`ga bog'lanadi.
 * - `cimd()` — Client ID Metadata Document'lar (klient_id = https URL), SSRF-xavfsiz node transporti bilan.
 */
/** Parol o'zgartirilganda yoki "hamma joydan chiqish" bajarilganda barcha ulangan ilovalar ham uziladi (kirish ma'lumoti almashgan = eski ruxsatlar yaroqsiz). */
const CREDENTIAL_CHANGE_PATHS = new Set(["/change-password", "/revoke-sessions", "/revoke-other-sessions"]);

const revokeConnectorsOnCredentialChange: BetterAuthPlugin = {
  id: "mcp-revoke-on-credential-change",
  hooks: {
    after: [
      {
        matcher: (ctx) => CREDENTIAL_CHANGE_PATHS.has(ctx.path ?? ""),
        handler: createAuthMiddleware(async (ctx) => {
          if (ctx.context.returned instanceof Error) return; // muvaffaqiyatsiz urinish
          const userId = ctx.context.session?.user.id ?? ctx.context.newSession?.user.id;
          if (!userId) return;
          try {
            await revokeAllConnections({ userId, role: "admin", via: "system" }, userId);
          } catch (error: unknown) {
            console.error("MCP: parol o'zgarganda ulanishlarni uzib bo'lmadi:", error instanceof Error ? error.message : error);
          }
        }),
      },
    ],
  },
};

export function buildMcpPlugins(): BetterAuthPlugin[] {
  return [
    revokeConnectorsOnCredentialChange,
    jwt(),
    mcp({
      loginPage: MCP_LOGIN_PAGE,
      consentPage: MCP_CONSENT_PAGE,
      resource: MCP_RESOURCE_URL,
      scopes: OAUTH_SCOPES,
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationDefaultScopes: ["blog:read", MCP_OFFLINE_SCOPE],
      clientRegistrationAllowedScopes: OAUTH_SCOPES,
      clientRegistrationDefaultApplicationType: "infer",
      accessTokenExpiresIn: config.MCP_ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenExpiresIn: config.MCP_REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
      // Standart moslashtirish natijasiga qo'shimcha: redirect URI ruxsat ro'yxatidan (Claude + loopback + env) tashqarida bo'lsa
      // — CIMD orqali kelgan klientlar uchun ham — authorize rad etiladi.
      validateRedirectUri: (redirectUri, _registered, defaultResult) => defaultResult && isAllowedRedirectUri(redirectUri),
      // Admin bo'lmagan foydalanuvchi sign-in'dan keyin rozilik bosqichiga EMAS, rad etish sahifasiga yo'naltiriladi
      // (veb `/consent` sahifasi rolni tekshirib tushuntirish ko'rsatadi). `isContinuation`ga ham ishonmaymiz: rol har doim tekshiriladi.
      postLogin: {
        page: MCP_CONSENT_PAGE,
        consentReferenceId: () => undefined,
        shouldRedirect: ({ user }) => (user as { role?: string }).role !== "admin",
      },
      // Better Auth'ning o'zining (xotiradagi) chegarasi — qisqa muddatli portlash uchun; asosiy chegara soatlik va
      // `oauth-guards.ts`dagi `registrationGuard`da (IP bo'yicha va umumiy). Standart 5/daqiqa o'rniga 10/daqiqa:
      // egasi ulanishni bir necha marta qayta urinsa ham bloklanmasin. Faqat prod'da (yoki AUTH_RATE_LIMIT_ENABLED=true) faol.
      rateLimit: { register: { window: 60, max: 10 } },
      advertisedMetadata: { scopes_supported: [...MCP_GRANTABLE_OAUTH_SCOPES] },
      extensions: [{ metadata: () => ({ scope_descriptions: SCOPE_DESCRIPTIONS_EN }) }],
    }),
    cimd({
      fetchClientMetadataResource: cimdFetch,
      metadataProfile: "mcp-2026-07-28",
      // Begona klient_id URL'lari orqali tashqi so'rovlar ko'paytirilmasin (qo'shimcha IP chegarasi — oauth-guards.ts).
      metadataFetchPolicy: { maximumFetchesPerMinute: 30, maximumFetchesPerOriginPerMinute: 10, maximumConcurrentFetches: 4 },
    }),
  ];
}


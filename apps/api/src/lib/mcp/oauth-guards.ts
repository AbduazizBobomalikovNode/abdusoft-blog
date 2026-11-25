import type { Context, Next } from "hono";
import { MCP_OFFLINE_SCOPE, MCP_REQUIRED_SCOPE_ID, parseScopeString } from "@blog/shared";
import { config } from "../../config.js";
import { auth } from "../auth.js";
import { handleAuthRequest } from "../auth-handler.js";
import { recordAuditSafe } from "../audit.js";
import { clientIp } from "../device.js";
import { consumeRateLimit } from "../rate-limit.js";
import { MCP_RESOURCE_URL } from "./endpoints.js";
import { clientExists, trimUnconsentedClients, widenClientScopes } from "./connections.js";
import { isAllowedRedirectUri } from "./redirect-policy.js";
import { DEFAULT_SCOPE_STRING, clampNow, writeToolsEnabled } from "./scopes.js";

const MAX_REGISTRATION_BODY = 16 * 1024;
const MAX_REDIRECT_URIS = 5;

function oauthError(c: Context, status: 400 | 403 | 413 | 429, error: string, description: string) {
  return c.json({ error, error_description: description }, status);
}

/**
 * `POST /api/auth/oauth2/register` (autentifikatsiyasiz):
 * (1) IP bo'yicha tezlik chegarasi (ish beradigan asosiy to'siq) va (2) barcha IP'lar uchun ancha yuqori umumiy chegara —
 *     egasining o'z ulanishi begonalar tufayli bloklanib qolmasligi uchun u katta; baza o'sishi esa (3) ishlatilmagan
 *     klientlar sonini cheklash bilan chegaralanadi (eng eskilari o'chiriladi, yangi urinish RAD ETILMAYDI);
 * (4) redirect URI'lar faqat ruxsat ro'yxatidan (Claude callback'i, loopback, env);
 * (5) faqat `token_endpoint_auth_method: none` (klient sirlari berilmaydi);
 * (6) `scope` HAR DOIM berilishi mumkin ruxsatlarga qisqartiriladi — aks holda Better Auth klient yuborgan/yubormagan
 *     barcha ruxsatlarni saqlab qo'yardi.
 */
export async function registrationGuard(c: Context, next: Next) {
  if (c.req.method !== "POST") return next();

  const windowMs = config.MCP_REGISTRATION_RATE_LIMIT_WINDOW_SECONDS * 1000;
  const perIp = consumeRateLimit(`mcp-register:${clientIp(c)}`, config.MCP_REGISTRATION_RATE_LIMIT_MAX, windowMs);
  const global = perIp.allowed
    ? consumeRateLimit("mcp-register:*", config.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX, windowMs)
    : perIp;
  if (!perIp.allowed || !global.allowed) {
    const retryAfter = Math.max(perIp.retryAfterSeconds, global.retryAfterSeconds);
    c.header("Retry-After", String(retryAfter));
    return oauthError(c, 429, "temporarily_unavailable", "Too many client registrations; retry later.");
  }

  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > MAX_REGISTRATION_BODY) return oauthError(c, 413, "invalid_client_metadata", "Registration request is too large.");

  const text = await c.req.raw.clone().text();
  if (text.length > MAX_REGISTRATION_BODY) return oauthError(c, 413, "invalid_client_metadata", "Registration request is too large.");

  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // Better Auth o'zi 400 qaytaradi
  }
  if (!body) return next();

  const uris = body.redirect_uris;
  if (Array.isArray(uris)) {
    const bad = uris.length > MAX_REDIRECT_URIS || uris.some((uri) => typeof uri !== "string" || !isAllowedRedirectUri(uri));
    if (bad) {
      return oauthError(
        c,
        400,
        "invalid_redirect_uri",
        "This server only accepts Claude's callback (https://claude.ai/api/mcp/auth_callback) and loopback callbacks (http://localhost|127.0.0.1:<port>/callback).",
      );
    }
  }

  const method = body.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") {
    return oauthError(c, 400, "invalid_client_metadata", "Only public clients are accepted: token_endpoint_auth_method must be 'none'.");
  }

  // Ro'yxatdan o'tish ruxsat etildi — jadval o'sishini cheklaymiz (eng eskilari ketadi, egasi bloklanmaydi).
  await trimUnconsentedClients(config.MCP_MAX_UNCONSENTED_CLIENTS - 1).catch((error: unknown) =>
    console.error("MCP: ishlatilmagan klientlarni qisqartirib bo'lmadi:", error instanceof Error ? error.message : error),
  );

  const requested = typeof body.scope === "string" ? clampNow(parseScopeString(body.scope)) : [];
  const forwarded = { ...body, token_endpoint_auth_method: "none", scope: requested.length > 0 ? requested.join(" ") : DEFAULT_SCOPE_STRING };
  const headers = new Headers(c.req.raw.headers);
  headers.delete("content-length");
  return handleAuthRequest(c, new Request(c.req.url, { method: "POST", headers, body: JSON.stringify(forwarded) }));
}

/**
 * `GET /api/auth/oauth2/authorize` — himoya tuzatishlar (faqat MCP yoqilganda):
 *
 * 1. `scope` HAR DOIM berilishi mumkin ruxsatlarga qisqartiriladi (hozir: `blog:read`); `scope` yo'q yoki bo'sh bo'lsa
 *    standart (`blog:read offline_access`) qo'yiladi — "scope yubormagan klient hamma narsani oladi" bo'lmaydi.
 * 2. `offline_access` yo'q bo'lsa qo'shiladi (`MCP_FORCE_OFFLINE_ACCESS=false` — o'chirish): aks holda refresh token
 *    berilmaydi va 15 daqiqada ulanish uziladi.
 * 3. `resource` (RFC 8707) yo'q bo'lsa `MCP_RESOURCE_URL` qo'shiladi: `resource`siz token shaffof bo'lib `/mcp`da 401
 *    bergan bo'lardi. Aniq boshqa `resource` tegilmaydi (AS `invalid_target` bilan rad etadi).
 * 4. `client_id` https URL bo'lsa (Client ID Metadata Document) — begona URL'lar orqali server tashqi so'rovlar
 *    ko'paytirmasligi uchun IP bo'yicha ALOHIDA chegara (`MCP_CIMD_RATE_LIMIT_*`) qo'llanadi.
 * 5. Yozuv kaliti yoqilgan bo'lsa: avval faqat o'qish bilan ro'yxatdan o'tgan klientning ruxsatlar shifti kengaytiriladi
 *    (rozilik EMAS — foydalanuvchi baribir yangi rozilik beradi).
 */
export async function authorizeHook(c: Context, next: Next) {
  if (c.req.method !== "GET") return next();
  const url = new URL(c.req.url);
  let changed = false;

  const clientId = url.searchParams.get("client_id") ?? "";
  if (/^https?:\/\//i.test(clientId)) {
    // Alohida byudjet (ro'yxatdan o'tishdan mustaqil): oddiy qayta ulanishlar `/register` limitiga tegmaydi va aksincha.
    const limit = consumeRateLimit(`mcp-cimd:${clientIp(c)}`, config.MCP_CIMD_RATE_LIMIT_MAX ?? config.MCP_REGISTRATION_RATE_LIMIT_MAX, (config.MCP_CIMD_RATE_LIMIT_WINDOW_SECONDS ?? config.MCP_REGISTRATION_RATE_LIMIT_WINDOW_SECONDS) * 1000);
    if (!limit.allowed) {
      c.header("Retry-After", String(limit.retryAfterSeconds));
      return oauthError(c, 429, "temporarily_unavailable", "Too many client metadata lookups; retry later.");
    }
  }

  const requested = clampNow(parseScopeString(url.searchParams.get("scope")));
  if (config.MCP_FORCE_OFFLINE_ACCESS && !requested.includes(MCP_OFFLINE_SCOPE)) requested.push(MCP_OFFLINE_SCOPE);
  if (!requested.some((scope) => scope !== MCP_OFFLINE_SCOPE)) requested.unshift(...DEFAULT_SCOPE_STRING.split(" ").filter((scope) => scope !== MCP_OFFLINE_SCOPE));
  const scope = requested.join(" ");
  if (scope !== url.searchParams.get("scope")) {
    url.searchParams.set("scope", scope);
    changed = true;
  }
  if (!url.searchParams.has("resource")) {
    url.searchParams.set("resource", MCP_RESOURCE_URL);
    changed = true;
  }
  if (writeToolsEnabled() && clientId) {
    await widenClientScopes(clientId, requested).catch((error: unknown) =>
      console.error("MCP: klient ruxsatlar shiftini kengaytirib bo'lmadi:", error instanceof Error ? error.message : error),
    );
  }

  if (!changed) return next();
  return handleAuthRequest(c, new Request(url, c.req.raw));
}

/**
 * `POST /api/auth/oauth2/consent`: faqat `admin` rozilik bera oladi (rad etish — har kimga mumkin). Roli boshqa
 * foydalanuvchi uchun 403 — authorization code umuman berilmaydi. Muvaffaqiyatli rozilik jurnalga yoziladi.
 */
export async function consentGuard(c: Context, next: Next) {
  if (c.req.method !== "POST") return next();

  const text = await c.req.raw.clone().text();
  let body: { accept?: unknown; oauth_query?: unknown; scope?: unknown } = {};
  try {
    body = (JSON.parse(text) ?? {}) as typeof body;
  } catch {
    // Better Auth o'zi xato qaytaradi
  }

  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const role = (session?.user as { role?: string } | undefined)?.role ?? "user";
  const oauthQuery = new URLSearchParams(typeof body.oauth_query === "string" ? body.oauth_query : "");

  if (session && body.accept !== false && role !== "admin") {
    await recordAuditSafe(
      { userId: session.user.id, role: role === "staff" ? "staff" : "user", via: "mcp" },
      { action: "mcp.authorize.refused", entityType: "mcp", summary: "Ilovaga ruxsat berish rad etildi: faqat admin ulay oladi", meta: { role } },
    );
    return c.json(
      { error: "access_denied", error_description: "Only the blog owner (admin) can connect an application." },
      403,
    );
  }

  // Klient o'chirilgan/yo'q bo'lsa — Better Auth ichida tashqi kalit xatosi (500) o'rniga toza `invalid_client`.
  const queryClientId = oauthQuery.get("client_id");
  if (session && queryClientId && !(await clientExists(queryClientId))) {
    return c.json({ error: "invalid_client", error_description: "This application is not registered (any more). Start the connection again from the application." }, 400);
  }

  // Tanlangan ruxsatlar (qisman rozilik): so'ralganlarning qism to'plami, `blog:read` doim kerak.
  let granted: string[] | null = null;
  if (session && body.accept !== false) {
    const requested = parseScopeString(oauthQuery.get("scope"));
    if (clampNow(requested).length !== requested.length) {
      return c.json({ error: "invalid_scope", error_description: "The request asks for permissions that cannot be granted yet." }, 403);
    }
    if (body.scope !== undefined) {
      const selected = typeof body.scope === "string" ? parseScopeString(body.scope) : null;
      if (!selected || selected.some((scope) => !requested.includes(scope)) || !selected.includes(MCP_REQUIRED_SCOPE_ID)) {
        return c.json(
          { error: "invalid_scope", error_description: `The selection must be part of what was requested and include '${MCP_REQUIRED_SCOPE_ID}'.` },
          400,
        );
      }
      granted = selected;
    }
  }

  await next();

  if (session && body.accept !== false && c.res.status === 200) {
    await recordAuditSafe(
      { userId: session.user.id, role: "admin", via: "mcp" },
      {
        action: "mcp.authorize",
        entityType: "mcp",
        entityId: oauthQuery.get("client_id"),
        summary: "Ilovaga ruxsat berildi",
        meta: {
          clientId: oauthQuery.get("client_id"),
          scopes: granted ?? parseScopeString(oauthQuery.get("scope")),
          requestedScopes: parseScopeString(oauthQuery.get("scope")),
        },
      },
    );
  }
}

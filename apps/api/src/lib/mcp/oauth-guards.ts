import type { Context, Next } from "hono";
import { MCP_OFFLINE_SCOPE, parseScopeString } from "@blog/shared";
import { config } from "../../config.js";
import { auth } from "../auth.js";
import { handleAuthRequest } from "../auth-handler.js";
import { recordAuditSafe } from "../audit.js";
import { clientIp } from "../device.js";
import { consumeRateLimit } from "../rate-limit.js";
import { MCP_RESOURCE_URL } from "./endpoints.js";
import { isAllowedRedirectUri } from "./redirect-policy.js";

const MAX_REGISTRATION_BODY = 16 * 1024;
const MAX_REDIRECT_URIS = 5;

function oauthError(c: Context, status: 400 | 403 | 413 | 429, error: string, description: string) {
  return c.json({ error, error_description: description }, status);
}

/**
 * `POST /api/auth/oauth2/register` (autentifikatsiyasiz): (1) IP bo'yicha va (2) barcha IP'lar bo'yicha umumiy tezlik
 * cheklovi — bitta tarqatilgan hujum bazani to'ldirib yubormasin; (3) redirect URI'lar faqat ruxsat ro'yxatidan
 * (Claude callback'i, loopback, env). Boshqa hamma narsa tanasi Better Auth'ga o'zgarishsiz uzatiladi.
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

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return next(); // Better Auth o'zi 400 qaytaradi
  }
  const uris = (body as { redirect_uris?: unknown } | null)?.redirect_uris;
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
  return next();
}

/**
 * `GET /api/auth/oauth2/authorize` — ikkita himoya tuzatish (faqat MCP yoqilganda):
 *
 * 1. Klient `scope`da `offline_access`ni unutsa, qo'shamiz — aks holda refresh token umuman berilmaydi va qisqa umrli
 *    (default 15 daqiqa) access token tugagach ulanish uziladi. `scope` umuman yuborilmasa tegilmaydi (klientning
 *    ro'yxatdan o'tgan default scope'lari ishlatiladi, ular `offline_access`ni o'z ichiga oladi).
 *    `MCP_FORCE_OFFLINE_ACCESS=false` — o'chirish.
 * 2. Klient `resource` (RFC 8707) yubormasa, `MCP_RESOURCE_URL`ni qo'shamiz: bu AS faqat bitta resurs serverga xizmat
 *    qiladi, `resource`siz token esa shaffof (opaque) bo'lib `/mcp`da 401 bergan bo'lardi (cheksiz 401 sikli).
 *    Aniq boshqa `resource` yuborilsa tegilmaydi (AS uni `invalid_target` bilan rad etadi).
 */
export async function authorizeHook(c: Context, next: Next) {
  if (c.req.method !== "GET") return next();
  const url = new URL(c.req.url);
  let changed = false;

  const scope = url.searchParams.get("scope");
  if (config.MCP_FORCE_OFFLINE_ACCESS && scope !== null && !parseScopeString(scope).includes(MCP_OFFLINE_SCOPE)) {
    url.searchParams.set("scope", `${scope} ${MCP_OFFLINE_SCOPE}`.trim());
    changed = true;
  }
  if (!url.searchParams.has("resource")) {
    url.searchParams.set("resource", MCP_RESOURCE_URL);
    changed = true;
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
  let body: { accept?: unknown; oauth_query?: unknown } = {};
  try {
    body = (JSON.parse(text) ?? {}) as typeof body;
  } catch {
    // Better Auth o'zi xato qaytaradi
  }

  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const role = (session?.user as { role?: string } | undefined)?.role ?? "user";

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

  await next();

  if (session && body.accept !== false && c.res.status === 200) {
    const query = new URLSearchParams(typeof body.oauth_query === "string" ? body.oauth_query : "");
    await recordAuditSafe(
      { userId: session.user.id, role: "admin", via: "mcp" },
      {
        action: "mcp.authorize",
        entityType: "mcp",
        entityId: query.get("client_id"),
        summary: "Ilovaga ruxsat berildi",
        meta: { clientId: query.get("client_id"), scopes: parseScopeString(query.get("scope")) },
      },
    );
  }
}

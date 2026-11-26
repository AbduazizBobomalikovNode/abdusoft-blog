import type { Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireMcpAuth } from "@better-auth/mcp";
import { config } from "../../config.js";
import { connectorRoute } from "../../routes/connector.js";
import { auth } from "../auth.js";
import { handleAuthRequest } from "../auth-handler.js";
import { rateLimitWrites } from "../rate-limit-middleware.js";
import { MCP_ISSUER, MCP_PATH, MCP_RESOURCE_METADATA_URL, MCP_RESOURCE_URL } from "./endpoints.js";
import { authorizeHook, consentGuard, registrationGuard } from "./oauth-guards.js";
import { resolvePrincipal, type PrincipalResult } from "./principal.js";
import { challengeScopes, writeToolsEnabled } from "./scopes.js";
import { handleMcpRequest } from "./server.js";

const MAX_MCP_BODY = 1024 * 1024;

/**
 * So'rov tanasi chegarasi. Odatda 1 MB. Faqat yozuv vositalari yoqilganda `upload_image` (base64) uchun kattaroq chegara
 * (`MCP_MEDIA_MAX_BYTES` * 4/3 + zahira) ruxsat etiladi; boshqa barcha chaqiruvlar autentifikatsiyadan KEYIN `server.ts`da
 * baribir 1 MB bilan cheklanadi (katta tana faqat shu bitta vosita uchun).
 */
export function maxBodyBytes(): number {
  return writeToolsEnabled() ? Math.max(MAX_MCP_BODY, Math.ceil((config.MCP_MEDIA_MAX_BYTES * 4) / 3) + 64 * 1024) : MAX_MCP_BODY;
}

const allowedOrigins = new Set(
  [config.WEB_ORIGIN, ...config.MCP_ALLOWED_ORIGINS.split(",")].map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean),
);

/**
 * `Origin` sarlavhasi bo'lmasa (Claude serveri, Claude Code, curl) — o'tadi. Bor bo'lsa (brauzer) ro'yxatda bo'lishi shart:
 * begona sayt foydalanuvchi brauzeri orqali `/mcp`ga so'rov yubora olmasin (DNS-rebinding/CSRF-ga o'xshash hujumlar).
 */
const originGuard: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header("origin");
  if (origin && !allowedOrigins.has(origin.replace(/\/+$/, ""))) {
    const hint = "Browser requests are accepted only from WEB_ORIGIN and the origins listed in MCP_ALLOWED_ORIGINS. If you are using a browser-based client (for example the MCP Inspector in its direct connection mode), add its origin to MCP_ALLOWED_ORIGINS.";
    console.warn(JSON.stringify({ event: "mcp.origin_blocked", origin: origin.slice(0, 200), hint: "add the origin to MCP_ALLOWED_ORIGINS if it is a browser-based client you trust" }));
    return c.json({ jsonrpc: "2.0", error: { code: -32600, message: "Origin not allowed", data: { hint } }, id: null }, 403);
  }
  return next();
};

/**
 * `/mcp`dagi HAR BIR 2xx bo'lmagan javob uchun bitta tuzilmaviy log qatori: HTTP holat, JSON-RPC metod va id turi (tahlil qilinsa),
 * `MCP-Protocol-Version` va `Accept` sarlavhalari, yuborilgan xato kodi/xabari. Tana, token va argumentlar HECH QACHON yozilmaydi.
 */
const SAFE_METHOD = /^[A-Za-z0-9_./-]{1,80}$/;
export function mcpRejectLogger(): MiddlewareHandler {
  return async (c, next) => {
    // Tana faqat oddiy (<= 1 MB) so'rovlarda, faqat metod/id turini olish uchun o'qiladi (kattalari — yuklash vositasi — o'qilmaydi).
    let bodyText: string | null = null;
    if (c.req.method === "POST" && Number(c.req.header("content-length") ?? "0") <= MAX_MCP_BODY) {
      bodyText = await c.req.raw.clone().text().catch(() => null);
    }
    await next();
    const status = c.res.status;
    if (status >= 200 && status < 300) return;
    let rpcMethod: string | undefined;
    let idType: string | undefined;
    if (bodyText) {
      try {
        const parsed = JSON.parse(bodyText) as unknown;
        const first = Array.isArray(parsed) ? parsed[0] : parsed;
        if (first && typeof first === "object") {
          const m = first as { method?: unknown; id?: unknown };
          if (typeof m.method === "string" && SAFE_METHOD.test(m.method)) rpcMethod = m.method;
          idType = m.id === undefined ? "none" : m.id === null ? "null" : typeof m.id;
        }
        if (Array.isArray(parsed)) idType = `batch(${parsed.length})`;
      } catch {
        rpcMethod = "(unparseable)";
      }
    }
    let errorCode: unknown;
    let errorMessage: string | undefined;
    try {
      const body = (await c.res.clone().json()) as { error?: { code?: unknown; message?: unknown } };
      errorCode = body.error?.code;
      if (typeof body.error?.message === "string") errorMessage = body.error.message.slice(0, 160);
    } catch {
      // javob JSON emas (masalan bo'sh tana)
    }
    if (config.NODE_ENV === "test" && !process.env.MCP_LOG_REJECTS_IN_TEST) return;
    console.warn(
      JSON.stringify({
        event: "mcp.rejected",
        status,
        httpMethod: c.req.method,
        rpcMethod,
        idType,
        protocolVersion: (c.req.header("mcp-protocol-version") ?? "").slice(0, 40) || null,
        accept: (c.req.header("accept") ?? "").slice(0, 120) || null,
        errorCode,
        errorMessage,
      }),
    );
  };
}

function jsonRpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function deny(result: Extract<PrincipalResult, { ok: false }>): Response {
  if (result.status === 403) return jsonRpcError(403, -32001, result.message);
  return jsonRpcError(401, -32001, result.message, {
    "www-authenticate": `Bearer error="invalid_token", error_description="${result.message}", resource_metadata="${MCP_RESOURCE_METADATA_URL}"`,
  });
}

function buildGuarded(scopes: string[]) {
  return requireMcpAuth(
    auth,
    async (req, claims) => {
      const resolved = await resolvePrincipal(claims);
      if (!resolved.ok) return deny(resolved);
      return handleMcpRequest(req, resolved.principal);
    },
    // Challenge BARCHA berilishi mumkin ruxsatlar + offline_access'ni e'lon qiladi — aks holda klient tor token oladi va refresh token berilmaydi.
    { resource: MCP_RESOURCE_URL, issuer: MCP_ISSUER, challengeScopes: scopes },
  );
}

// `MCP_WRITE_TOOLS_ENABLED` holatiga qarab (o'zgarsa qayta quriladi): challenge'dagi ruxsatlar joriy holatni aks ettiradi.
let guardedFor = "";
let guardedHandler = buildGuarded(challengeScopes());
function guarded(req: Request): Promise<Response> {
  const key = challengeScopes().join(" ");
  if (key !== guardedFor) {
    guardedHandler = buildGuarded(challengeScopes());
    guardedFor = key;
  }
  return guardedHandler(req);
}

/** Ildizdagi (issuer yo'lisiz) alias'lar — ba'zi klientlar shularni ham tekshiradi. Haqiqiy hujjatlar plagin tomonidan beriladi. */
const WELL_KNOWN_ALIASES: Record<string, string> = {
  "/.well-known/oauth-authorization-server": "/.well-known/oauth-authorization-server/api/auth",
};

/**
 * Better Auth `/api/auth/*`dan OLDIN ulanadi (xavfsizlik qo'riqchilari: ro'yxatdan o'tish cheklovi, admin-only rozilik,
 * `offline_access`). Faqat `MCP_ENABLED=true` bo'lganda chaqiriladi.
 */
export function mountMcpPreAuth(app: Hono): void {
  app.use("/api/auth/oauth2/register", registrationGuard);
  app.use("/api/auth/oauth2/authorize", authorizeHook);
  app.use("/api/auth/oauth2/consent", consentGuard);
}

/** `/.well-known/*`, `/mcp`, veb sahifalar uchun yordamchi marshrutlar. Faqat `MCP_ENABLED=true` bo'lganda. */
export function mountMcp(app: Hono): void {
  app.on(["GET", "HEAD"], "/.well-known/*", (c) => {
    const alias = WELL_KNOWN_ALIASES[new URL(c.req.url).pathname];
    if (!alias) return handleAuthRequest(c);
    const url = new URL(c.req.url);
    url.pathname = alias;
    return handleAuthRequest(c, new Request(url, c.req.raw));
  });

  app.use(MCP_PATH, mcpRejectLogger());
  app.post(
    MCP_PATH,
    originGuard,
    rateLimitWrites({ name: "mcp", limit: config.MCP_RATE_LIMIT_MAX, windowSeconds: config.MCP_RATE_LIMIT_WINDOW_SECONDS }),
    (c, next) =>
      bodyLimit({
        maxSize: maxBodyBytes(),
        onError: (ctx) => ctx.json({ jsonrpc: "2.0", error: { code: -32600, message: "Request too large" }, id: null }, 413),
      })(c, next),
    (c) => guarded(c.req.raw),
  );
  // Stateless server: GET (SSE oqimi) va DELETE (sessiya tugatish) yo'q.
  app.on(["GET", "DELETE"], MCP_PATH, (c) =>
    c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless, use POST." }, id: null }, 405, {
      Allow: "POST",
    }),
  );

  app.route("/connector", connectorRoute);
}

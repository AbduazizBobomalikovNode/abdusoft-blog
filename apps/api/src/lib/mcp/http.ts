import type { Hono } from "hono";
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
import { CHALLENGE_SCOPES } from "./scopes.js";
import { handleMcpRequest } from "./server.js";

const MAX_MCP_BODY = 1024 * 1024;

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

const guarded = requireMcpAuth(
  auth,
  async (req, claims) => {
    const resolved = await resolvePrincipal(claims);
    if (!resolved.ok) return deny(resolved);
    return handleMcpRequest(req, resolved.principal);
  },
  // Challenge BARCHA ruxsatlar + offline_access'ni e'lon qiladi — aks holda klient tor token oladi va refresh token berilmaydi.
  { resource: MCP_RESOURCE_URL, issuer: MCP_ISSUER, challengeScopes: CHALLENGE_SCOPES },
);

/** Ildizdagi (issuer yo'lisiz) alias'lar — ba'zi klientlar shularni ham tekshiradi. Haqiqiy hujjatlar plagin tomonidan beriladi. */
const WELL_KNOWN_ALIASES: Record<string, string> = {
  "/.well-known/oauth-authorization-server": "/.well-known/oauth-authorization-server/api/auth",
  "/.well-known/openid-configuration": "/api/auth/.well-known/openid-configuration",
  "/.well-known/openid-configuration/api/auth": "/api/auth/.well-known/openid-configuration",
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

  app.post(
    MCP_PATH,
    rateLimitWrites({ name: "mcp", limit: config.MCP_RATE_LIMIT_MAX, windowSeconds: config.MCP_RATE_LIMIT_WINDOW_SECONDS }),
    bodyLimit({
      maxSize: MAX_MCP_BODY,
      onError: (c) => c.json({ jsonrpc: "2.0", error: { code: -32600, message: "Request too large" }, id: null }, 413),
    }),
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

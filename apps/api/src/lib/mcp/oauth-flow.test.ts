import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { MCP_SCOPE_IDS } from "@blog/shared";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD, type TestUser } from "../../test/auth-test-helpers.js";
import {
  API,
  ISSUER,
  MCP_URL,
  WEB,
  authorize,
  callTool,
  connect,
  exchangeCode,
  jwtPayload,
  mcpCall,
  register,
  registerClient,
  tokenRequest,
} from "../../test/mcp-harness.js";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
});

let app: Hono;
let admin: TestUser;
let creds: { email: string; password: string };
let db: typeof import("../../db/index.js").db;
let authSchema: typeof import("../../db/auth-schema.js");
let authInstance: typeof import("../auth.js").auth;

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  ({ db } = await import("../../db/index.js"));
  authSchema = await import("../../db/auth-schema.js");
  ({ auth: authInstance } = await import("../auth.js"));
  admin = await createTestUser({ role: "admin", name: "Owner" });
  creds = { email: admin.email, password: TEST_USER_PASSWORD };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("authorization code + PKCE flow", () => {
  it("goes login page -> consent page -> redirect, with a form-encoded token request and a resource-bound JWT", async () => {
    const clientId = await registerClient(app);
    const a = await authorize(app, { clientId, ...creds });
    expect(a.steps).toEqual(["login-page", "consent-page", "redirect_uri"]);
    // Login va rozilik sahifalari VEB origin'da
    expect(a.loginUrl).toMatch(new RegExp(`^${WEB}/login\\?`));
    expect(a.consentUrl).toMatch(new RegExp(`^${WEB}/consent\\?`));
    expect(a.error).toBeUndefined();

    const tok = await exchangeCode(app, a);
    expect(tok.status).toBe(200);
    expect(tok.body.token_type).toBe("Bearer");
    expect(tok.body.expires_in).toBe(900);
    expect(tok.body.refresh_token).toBeTruthy();
    expect(tok.body.scope.split(" ").sort()).toEqual([...MCP_SCOPE_IDS, "offline_access"].sort());

    const claims = jwtPayload(tok.body.access_token);
    expect(claims.iss).toBe(ISSUER);
    expect([claims.aud].flat()).toEqual([MCP_URL]);
    expect(claims.azp).toBe(clientId);
    expect(claims.sub).toBe(admin.id);
    expect(claims.exp - claims.iat).toBe(900);
  });

  it("rejects a PKCE verifier mismatch and a replayed code", async () => {
    const clientId = await registerClient(app);
    const a = await authorize(app, { clientId, ...creds });
    const wrong = await tokenRequest(app, {
      grant_type: "authorization_code",
      code: a.code,
      redirect_uri: a.redirectUri,
      client_id: clientId,
      code_verifier: "x".repeat(50),
      resource: MCP_URL,
    });
    expect(wrong.status).toBe(400);
    const ok = await exchangeCode(app, a);
    // Kod PKCE xatosida sarflanmaydi (1.7.23+); to'g'ri verifier bilan ishlaydi, ikkinchi marta esa yo'q.
    expect(ok.status).toBe(200);
    const again = await exchangeCode(app, a);
    expect(again.status).toBe(400);
  });

  it("issues a refresh token even if the client forgot offline_access (the authorize hook adds it)", async () => {
    const { tokens } = await connect(app, creds, { scope: "blog:read" });
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.scope.split(" ").sort()).toEqual(["blog:read", "offline_access"]);
  });

  it("denied consent redirects with access_denied and issues no code", async () => {
    const clientId = await registerClient(app);
    const a = await authorize(app, { clientId, ...creds, approve: false });
    expect(a.error).toBe("access_denied");
    expect(a.code).toBe("");
  });

  it("answers the token endpoint for a dead refresh token with invalid_grant", async () => {
    const { clientId } = await connect(app, creds);
    const res = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: "does-not-exist", client_id: clientId, resource: MCP_URL });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
  });

  it("only accepts Claude/loopback redirect URIs at authorize time (port of a loopback client is ignored)", async () => {
    const reg = await register(app, {
      client_name: "Claude Code",
      redirect_uris: ["http://127.0.0.1:54321/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    const { client_id: clientId } = (await reg.json()) as { client_id: string };
    const moved = await authorize(app, { clientId, ...creds, redirectUri: "http://127.0.0.1:60001/callback", scope: "blog:read" });
    expect(moved.steps.at(-1)).toBe("redirect_uri");
    expect(moved.code).toBeTruthy();
    // Boshqa yo'l — rad
    await expect(authorize(app, { clientId, ...creds, redirectUri: "http://127.0.0.1:60001/steal", scope: "blog:read" })).rejects.toThrow();
  });
});

describe("refresh token rotation", () => {
  it("rotates the refresh token, keeps the audience, and answers invalid_grant once the reuse window has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { clientId, tokens } = await connect(app, creds);
    const first = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: clientId, resource: MCP_URL });
    expect(first.status).toBe(200);
    expect(first.body.refresh_token).toBeTruthy();
    expect(first.body.refresh_token).not.toBe(tokens.refresh_token);
    expect([jwtPayload(first.body.access_token).aud].flat()).toEqual([MCP_URL]);
    expect((await mcpCall(app, first.body.access_token, "tools/list")).status).toBe(200);

    // Qayta urinish (tarmoq xatosi) 30 soniya ichida o'sha javobni qaytaradi — keyin invalid_grant.
    vi.setSystemTime(Date.now() + 31_000);
    const replay = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: clientId, resource: MCP_URL });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
  });
});

describe("permissions (scopes)", () => {
  it("a connection without blog:read gets insufficient_scope naming the missing scope; whoami still works", async () => {
    const { tokens } = await connect(app, creds, { scope: "posts:write" });
    const denied = await callTool(app, tokens.access_token, "list_posts");
    expect(denied.isError).toBe(true);
    expect(denied.json.error).toMatchObject({ code: "insufficient_scope", requiredScope: "blog:read" });
    expect(denied.json.error.message).toContain("blog:read");
    expect(denied.json.error.hint).toMatch(/reconnect/i);

    const who = await callTool(app, tokens.access_token, "whoami");
    expect(who.isError).toBe(false);
    expect(who.json.grantedScopes.map((s: { id: string }) => s.id)).toEqual(["posts:write"]);
    expect(who.json.tools.find((t: { name: string }) => t.name === "list_posts")).toMatchObject({ available: false, requiredScope: "blog:read" });
  });

  it("records the denied attempt in the audit log without content", async () => {
    const { tokens } = await connect(app, creds, { scope: "media:upload" });
    await callTool(app, tokens.access_token, "get_site_stats");
    const log = await app.request(`${API}/admin/audit?action=mcp.denied&limit=100`, { headers: { cookie: admin.cookie } });
    const body = (await log.json()) as { items: Array<{ via: string; meta: Record<string, unknown>; entityType: string }> };
    expect(body.items.some((i) => i.via === "mcp" && i.entityType === "mcp" && i.meta.requiredScope === "blog:read" && i.meta.tool === "get_site_stats")).toBe(true);
  });
});

describe("only the owner (admin) may connect and use the connector", () => {
  for (const role of ["staff", "user"] as const) {
    it(`refuses a ${role} at the consent step (403 access_denied, no code) and audits it`, async () => {
      const other = await createTestUser({ role });
      const clientId = await registerClient(app);
      const a = await authorize(app, { clientId, email: other.email, password: TEST_USER_PASSWORD, stopAtConsent: true });
      expect(a.steps).toEqual(["login-page", "consent-page"]);

      const consent = await a.browser.req(`${API}/api/auth/oauth2/consent`, {
        method: "POST",
        origin: WEB,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accept: true, oauth_query: new URL(a.consentUrl!).search.slice(1) }),
      });
      expect(consent.status).toBe(403);
      expect(await consent.json()).toMatchObject({ error: "access_denied" });

      // Rad etish har kimga ruxsat — hech narsa yaratmaydi
      const deny = await a.browser.req(`${API}/api/auth/oauth2/consent`, {
        method: "POST",
        origin: WEB,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accept: false, oauth_query: new URL(a.consentUrl!).search.slice(1) }),
      });
      expect(deny.status).toBe(200);
      expect(await db.select().from(authSchema.oauthConsent).where(eq(authSchema.oauthConsent.userId, other.id))).toHaveLength(0);

      const log = await app.request(`${API}/admin/audit?action=mcp.authorize.refused&limit=100`, { headers: { cookie: admin.cookie } });
      const body = (await log.json()) as { items: Array<{ actor: { id: string } | null }> };
      expect(body.items.some((i) => i.actor?.id === other.id)).toBe(true);
    });

    it(`the consent info endpoint tells the web page a ${role} is not allowed`, async () => {
      const other = await createTestUser({ role });
      const clientId = await registerClient(app);
      const a = await authorize(app, { clientId, email: other.email, password: TEST_USER_PASSWORD, stopAtConsent: true });
      const info = await a.browser.req(`${API}/connector/consent?oauth_query=${encodeURIComponent(new URL(a.consentUrl!).search.slice(1))}`, { origin: WEB });
      expect(info.status).toBe(200);
      expect(await info.json()).toMatchObject({ allowed: false, reason: "not_admin", user: { role }, client: { id: clientId, name: "Claude", redirectHost: "claude.ai" } });
    });
  }

  it("the consent info endpoint is allowed for the admin, lists the signed scopes, and rejects unsigned or foreign queries", async () => {
    const clientId = await registerClient(app);
    const a = await authorize(app, { clientId, ...creds, scope: "blog:read posts:write offline_access", stopAtConsent: true });
    const query = new URL(a.consentUrl!).search.slice(1);
    const ok = await a.browser.req(`${API}/connector/consent?oauth_query=${encodeURIComponent(query)}`, { origin: WEB });
    expect(await ok.json()).toMatchObject({ allowed: true, reason: null, scopes: ["blog:read", "posts:write", "offline_access"] });

    const forged = query.replace("blog%3Aread", "blog%3Aread+posts%3Adelete").replace(/scope=blog%3Aread\+posts%3Awrite/, "scope=posts%3Adelete");
    const bad = await a.browser.req(`${API}/connector/consent?oauth_query=${encodeURIComponent(forged)}`, { origin: WEB });
    expect(bad.status).toBe(400);
    const none = await a.browser.req(`${API}/connector/consent`, { origin: WEB });
    expect(none.status).toBe(400);
    expect((await app.request(`${API}/connector/consent?oauth_query=${encodeURIComponent(query)}`)).status).toBe(401);
  });

  it("re-checks the role on every /mcp request: demoting the admin takes effect immediately", async () => {
    const owner = await createTestUser({ role: "admin" });
    const { tokens } = await connect(app, { email: owner.email, password: TEST_USER_PASSWORD });
    expect((await mcpCall(app, tokens.access_token, "tools/list")).status).toBe(200);

    await db.update(authSchema.user).set({ role: "staff" }).where(eq(authSchema.user.id, owner.id));
    const staffNow = await mcpCall(app, tokens.access_token, "tools/list");
    expect(staffNow.status).toBe(403);
    expect(JSON.stringify(staffNow.body)).toContain("admin role required");
    // Refresh qilingan token ham o'tmaydi
    await db.update(authSchema.user).set({ role: "user" }).where(eq(authSchema.user.id, owner.id));
    expect((await mcpCall(app, tokens.access_token, "tools/call", { name: "whoami", arguments: {} })).status).toBe(403);

    await db.update(authSchema.user).set({ role: "admin" }).where(eq(authSchema.user.id, owner.id));
    expect((await mcpCall(app, tokens.access_token, "tools/list")).status).toBe(200);
  });
});

describe("token validation at /mcp", () => {
  async function sign(payload: Record<string, unknown>) {
    const api = authInstance.api as unknown as { signJWT: (input: { body: { payload: Record<string, unknown> } }) => Promise<{ token: string }> };
    return (await api.signJWT({ body: { payload } })).token;
  }

  it("accepts a control token and rejects expired, wrong audience, wrong issuer and missing client tokens with 401 + challenge", async () => {
    const { clientId } = await connect(app, creds);
    const now = Math.floor(Date.now() / 1000);
    const base = { sub: admin.id, azp: clientId, scope: "blog:read", iss: ISSUER, aud: MCP_URL, iat: now, exp: now + 60 };

    // Nazorat: AS kaliti bilan imzolangan to'g'ri token qabul qilinadi — pastdagi rad etishlar shu sabab ma'noli.
    const control = await mcpCall(app, await sign(base), "tools/list");
    expect(control.status).toBe(200);

    for (const override of [{ aud: `${API}/other` }, { iss: "http://evil.example" }, { exp: now - 10 }, { azp: undefined }]) {
      const res = await mcpCall(app, await sign({ ...base, ...override }), "tools/list");
      expect(res.status).toBe(401);
      expect(res.www).toContain("resource_metadata=");
    }
  });

  it("a real access token stops working after it expires (15 minutes by default)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { tokens } = await connect(app, creds);
    expect((await mcpCall(app, tokens.access_token, "tools/list")).status).toBe(200);
    vi.setSystemTime(Date.now() + 901_000);
    const expired = await mcpCall(app, tokens.access_token, "tools/list");
    expect(expired.status).toBe(401);
    expect(expired.www).toContain("resource_metadata=");
  });

  it("a client that never sends `resource` still gets an audience-bound token (the authorize hook adds it) and refreshes fine", async () => {
    const clientId = await registerClient(app);
    const a = await authorize(app, { clientId, ...creds, resource: null });
    const tok = await exchangeCode(app, a, null);
    expect(tok.status).toBe(200);
    expect([jwtPayload(tok.body.access_token).aud].flat()).toEqual([MCP_URL]);
    expect((await mcpCall(app, tok.body.access_token, "tools/list")).status).toBe(200);

    const refreshed = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: tok.body.refresh_token, client_id: clientId });
    expect(refreshed.status).toBe(200);
    expect([jwtPayload(refreshed.body.access_token).aud].flat()).toEqual([MCP_URL]);
    expect((await mcpCall(app, refreshed.body.access_token, "tools/list")).status).toBe(200);
  });

  it("refuses an authorization request for a different resource (invalid_target) and rejects opaque tokens at /mcp", async () => {
    const clientId = await registerClient(app);
    const refused = await authorize(app, { clientId, ...creds, resource: `${API}/other` });
    expect(refused.code).toBe("");
    expect(refused.error).toBe("invalid_target");
    expect((await mcpCall(app, "opaque-token-value", "tools/list")).status).toBe(401);
  });

  it("works when the client sends only 'Accept: application/json'", async () => {
    const { tokens } = await connect(app, creds);
    const res = await mcpCall(app, tokens.access_token, "tools/list", {}, { accept: "application/json" });
    expect(res.status).toBe(200);
  });
});

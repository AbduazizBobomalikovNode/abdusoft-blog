import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import sharp from "sharp";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD, type TestUser } from "../../test/auth-test-helpers.js";
import {
  ALL_BLOG_SCOPES,
  API,
  CLAUDE_REDIRECT,
  MCP_URL,
  WEB,
  authorize,
  callTool,
  connect,
  exchangeCode,
  mcpCall,
  register,
  registerClient,
  tokenRequest,
  type Json,
} from "../../test/mcp-harness.js";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_WRITE_TOOLS_ENABLED = "true";
  process.env.TRUST_PROXY = "true";
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "4";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
  process.env.MCP_CIMD_RATE_LIMIT_MAX = "50";
  process.env.MCP_ALLOWED_ORIGINS = "https://trusted.example";
});

let app: Hono;
let admin: TestUser;
let db: typeof import("../../db/index.js").db;
let auth: typeof import("../../db/auth-schema.js");
let config: typeof import("../../config.js").config;
const creds = () => ({ email: admin.email, password: TEST_USER_PASSWORD });
const mutableConfig = () => config as unknown as { MCP_WRITE_TOOLS_ENABLED: boolean };

// Har bir test o'z IP'sidan ro'yxatdan o'tadi (ro'yxatdan o'tish chegarasi 4/soat).
let ipSeq = 0;
const newClient = (name = "Claude") => registerClient(app, CLAUDE_REDIRECT, name, `203.0.113.${(ipSeq += 1)}`);

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  ({ db } = await import("../../db/index.js"));
  auth = await import("../../db/auth-schema.js");
  ({ config } = await import("../../config.js"));
  admin = await createTestUser({ role: "admin" });
});

afterEach(() => {
  mutableConfig().MCP_WRITE_TOOLS_ENABLED = true;
});

describe("write permissions are grantable when the switch is on", () => {
  it("advertises them in discovery and the 401 challenge", async () => {
    const meta = (await (await app.request(`${API}/.well-known/oauth-authorization-server/api/auth`)).json()) as Json;
    expect(meta.scopes_supported).toEqual(expect.arrayContaining(["blog:read", "posts:write", "posts:publish", "posts:delete", "offline_access"]));
    expect(Object.keys(meta.scope_descriptions)).toEqual(expect.arrayContaining(["posts:write", "comments:moderate"]));
    const prm = (await (await app.request(`${API}/.well-known/oauth-protected-resource/mcp`)).json()) as Json;
    expect(prm.scopes_supported).toContain("channels:send");
    const ch = await mcpCall(app, undefined, "initialize");
    expect(ch.www).toContain("posts:write");
  });

  it("an approval without a selection grants everything that was requested", async () => {
    const { tokens } = await connect(app, creds(), { clientId: await newClient() });
    expect(tokens.scope.split(" ").sort()).toEqual([...ALL_BLOG_SCOPES.split(" ")].sort());
  });
});

describe("partial consent is honoured end to end", () => {
  it("grants only the selected permissions to the token, the consent row and the tools", async () => {
    const clientId = await newClient("Qisman");
    const { tokens } = await connect(app, creds(), { clientId, consentScope: "blog:read posts:write offline_access" });
    expect(tokens.scope.split(" ").sort()).toEqual(["blog:read", "offline_access", "posts:write"]);
    const [consent] = await db.select().from(auth.oauthConsent).where(eq(auth.oauthConsent.clientId, clientId));
    expect([...consent!.scopes].sort()).toEqual(["blog:read", "offline_access", "posts:write"]);
    const who = await callTool(app, tokens.access_token, "whoami");
    expect(who.json.grantedScopes.map((s: Json) => s.id).sort()).toEqual(["blog:read", "posts:write"]);
    const ok = await callTool(app, tokens.access_token, "create_post_draft", { title: "Qisman", content_markdown: "## A\n\nmatn" });
    expect(ok.isError).toBe(false);
    const denied = await callTool(app, tokens.access_token, "trash_post", { id: ok.json.post.id, expected_updated_at: ok.json.post.updatedAt });
    expect(denied.json.error).toMatchObject({ code: "insufficient_scope", requiredScope: "posts:delete" });
    // the audit record of the approval names what was granted, not what was asked
    const schema = await import("../../db/schema.js");
    const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "mcp.authorize"));
    const mine = rows.find((r) => r.entityId === clientId)!;
    expect((mine.meta as Json).scopes.sort()).toEqual(["blog:read", "offline_access", "posts:write"]);
    expect((mine.meta as Json).requestedScopes.length).toBeGreaterThan(3);
  });

  it("refuses selections that are not part of the request or that drop read access", async () => {
    const clientId = await newClient();
    const a = await authorize(app, { clientId, email: admin.email, password: TEST_USER_PASSWORD, scope: "blog:read posts:write offline_access", stopAtConsent: true });
    const raw = new URL(a.consentUrl!).search.slice(1);
    const post = (scope: unknown) =>
      a.browser.req(`${API}/api/auth/oauth2/consent`, { method: "POST", origin: WEB, headers: { "content-type": "application/json" }, body: JSON.stringify({ accept: true, oauth_query: raw, scope }) });
    expect((await post("blog:read posts:delete")).status).toBe(400);
    expect((await post("posts:write offline_access")).status).toBe(400); // blog:read shart
    expect((await post(["blog:read"])).status).toBe(400);
    expect((await post("")).status).toBe(400);
    expect((await post("blog:read offline_access")).status).toBe(200);
  });
});

describe("adding permissions always needs a fresh consent; nobody gains power silently", () => {
  it("a read-only approval does not authorize write scopes later: the consent page comes again", async () => {
    const clientId = await newClient("Faqat o'qish");
    const first = await connect(app, creds(), { clientId, scope: "blog:read offline_access" });
    expect(first.tokens.scope.split(" ").sort()).toEqual(["blog:read", "offline_access"]);
    expect(first.authorize.steps).toContain("consent-page");

    // Same client, same browser session, now asks for more: must not skip consent.
    const again = await authorize(app, { clientId, ...creds(), scope: ALL_BLOG_SCOPES, browser: first.authorize.browser, stopAtConsent: true });
    expect(again.steps).toContain("consent-page");
    expect(again.consentUrl).toContain("posts%3Awrite");

    // Re-asking for what was already approved (read only) is not prompted again.
    const same = await authorize(app, { clientId, ...creds(), scope: "blog:read offline_access", browser: first.authorize.browser });
    expect(same.steps).not.toContain("consent-page");

    // After approving, the new token carries the new scopes; the OLD token never gains them.
    const upgraded = await authorize(app, { clientId, ...creds(), scope: ALL_BLOG_SCOPES, browser: first.authorize.browser });
    const tok = await exchangeCode(app, upgraded);
    expect(tok.body.scope.split(" ")).toContain("posts:publish");
    const oldWho = await callTool(app, first.tokens.access_token, "whoami");
    expect(oldWho.json.grantedScopes.map((s: Json) => s.id)).toEqual(["blog:read"]);
  });

  it("a refresh token cannot be widened to more scopes", async () => {
    const clientId = await newClient();
    const { tokens } = await connect(app, creds(), { clientId, scope: "blog:read offline_access", consentScope: "blog:read offline_access" });
    const r = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: clientId, scope: "blog:read posts:write posts:publish", resource: MCP_URL });
    expect(r.status).toBe(400);
    const ok = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: clientId, resource: MCP_URL });
    expect(ok.status).toBe(200);
    expect(ok.body.scope.split(" ").sort()).toEqual(["blog:read", "offline_access"]);
  });

  it("effective scopes = token AND consent AND the switch", async () => {
    const clientId = await newClient();
    const { tokens } = await connect(app, creds(), { clientId });
    const t = tokens.access_token;
    expect((await callTool(app, t, "whoami")).json.grantedScopes.length).toBe(7);

    // Consent narrowed in the database (the token still names everything): the intersection wins.
    await db.update(auth.oauthConsent).set({ scopes: ["blog:read", "offline_access"] }).where(eq(auth.oauthConsent.clientId, clientId));
    const narrowed = await callTool(app, t, "create_post_draft", { title: "x" });
    expect(narrowed.json.error).toMatchObject({ code: "insufficient_scope", requiredScope: "posts:write" });
    await db.update(auth.oauthConsent).set({ scopes: ALL_BLOG_SCOPES.split(" ") }).where(eq(auth.oauthConsent.clientId, clientId));
    expect((await callTool(app, t, "create_post_draft", { title: "x" })).isError).toBe(false);

    // Switch off at runtime: write tools disappear, write scopes stop counting, read keeps working.
    mutableConfig().MCP_WRITE_TOOLS_ENABLED = false;
    const names = ((await mcpCall(app, t, "tools/list")).body.result.tools as Json[]).map((x) => x.name);
    expect(names).toHaveLength(12);
    const who = await callTool(app, t, "whoami");
    expect(who.json.grantedScopes.map((s: Json) => s.id)).toEqual(["blog:read"]);
    expect(who.json.server.mode).toBe("read-only");
    const gone = await mcpCall(app, t, "tools/call", { name: "publish_post", arguments: {} });
    expect(gone.body.result?.isError === true || gone.body.error !== undefined).toBe(true);
    expect((await callTool(app, t, "list_posts")).isError).toBe(false);
  });

  it("with the switch off, reconnecting a connection that was approved for writes asks for read only again", async () => {
    mutableConfig().MCP_WRITE_TOOLS_ENABLED = false;
    const clientId = await newClient();
    const a = await authorize(app, { clientId, ...creds(), scope: ALL_BLOG_SCOPES, stopAtConsent: true });
    expect(a.consentUrl).toContain("scope=blog%3Aread+offline_access");
  });
});

describe("connected applications list", () => {
  it("shows the permissions that were granted and whether the write switch is currently on", async () => {
    const clientId = await newClient("Ro'yxat");
    await connect(app, creds(), { clientId, consentScope: "blog:read posts:write offline_access" });
    const get = () => app.request(`${API}/admin/connections`, { headers: { cookie: admin.cookie } });
    const on = (await (await get()).json()) as Json;
    expect(on.writeToolsEnabled).toBe(true);
    const row = on.items.find((c: Json) => c.clientId === clientId);
    expect([...row.scopes].sort()).toEqual(["blog:read", "offline_access", "posts:write"]);
    mutableConfig().MCP_WRITE_TOOLS_ENABLED = false;
    const off = (await (await get()).json()) as Json;
    expect(off.writeToolsEnabled).toBe(false);
    expect(off.items.find((c: Json) => c.clientId === clientId).scopes).toContain("posts:write"); // berilgan, lekin faol emas
  });
});

describe("clients registered before the switch was turned on can ask for the new permissions", () => {
  it("widens the client's ceiling (not its consent) on authorize", async () => {
    const clientId = await newClient("Eski");
    await db.update(auth.oauthClient).set({ scopes: ["blog:read", "offline_access"] }).where(eq(auth.oauthClient.clientId, clientId));
    const a = await authorize(app, { clientId, ...creds(), scope: ALL_BLOG_SCOPES, stopAtConsent: true });
    expect(a.steps).toEqual(["login-page", "consent-page"]);
    const [client] = await db.select().from(auth.oauthClient).where(eq(auth.oauthClient.clientId, clientId));
    expect(client!.scopes).toEqual(expect.arrayContaining(["blog:read", "posts:write", "posts:delete"]));
    const consents = await db.select().from(auth.oauthConsent).where(eq(auth.oauthConsent.clientId, clientId));
    expect(consents).toHaveLength(0);
  });
});

describe("security review follow-ups", () => {
  it("consent for a client that no longer exists answers a clean invalid_client 400 (accept and deny)", async () => {
    const clientId = await newClient("Yo'qoladi");
    const a = await authorize(app, { clientId, ...creds(), scope: "blog:read offline_access", stopAtConsent: true });
    const raw = new URL(a.consentUrl!).search.slice(1);
    await db.delete(auth.oauthClient).where(eq(auth.oauthClient.clientId, clientId));
    for (const accept of [true, false]) {
      const res = await a.browser.req(`${API}/api/auth/oauth2/consent`, { method: "POST", origin: WEB, headers: { "content-type": "application/json" }, body: JSON.stringify({ accept, oauth_query: raw, scope: "blog:read offline_access" }) });
      expect(res.status).toBe(400);
      expect(((await res.json()) as Json).error).toBe("invalid_client");
    }
  });

  it("a browser origin that is not allowed gets 403 with a hint naming MCP_ALLOWED_ORIGINS", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await app.request(MCP_URL, { method: "POST", headers: { "content-type": "application/json", origin: "https://inspector.example" }, body: "{}" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Json;
    expect(body.error.data.hint).toContain("MCP_ALLOWED_ORIGINS");
    expect(body.error.data.hint).toMatch(/Inspector/);
    expect(warn.mock.calls.flat().join(" ")).toContain("MCP_ALLOWED_ORIGINS");
    warn.mockRestore();
  });

  it("client-metadata-document lookups have their own budget: exhausting /register does not throttle them", async () => {
    const ip = "198.51.100.77";
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await register(app, { client_name: `R${i}`, redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: "none" }, ip)).status);
    }
    expect(statuses).toContain(429);
    const { setCimdFetchForTests } = await import("./plugins.js");
    setCimdFetchForTests(async () => new Response("nope", { status: 404 }));
    for (let i = 0; i < 8; i += 1) {
      const res = await app.request(`${API}/api/auth/oauth2/authorize?${new URLSearchParams({ response_type: "code", client_id: `https://c${i}.example.test/meta.json`, redirect_uri: CLAUDE_REDIRECT, code_challenge: "x".repeat(43), code_challenge_method: "S256", scope: "blog:read" })}`, {
        headers: { "x-forwarded-for": ip, "sec-fetch-mode": "navigate" },
      });
      expect(res.status, `lookup ${i}`).not.toBe(429);
    }
    setCimdFetchForTests(null);
  });
});

describe("request body limits", () => {
  it("allows a large body only for upload_image; every other call stays at 1 MB", async () => {
    const { tokens } = await connect(app, creds(), { clientId: await newClient() });
    const t = tokens.access_token;
    const noise = Buffer.alloc(900 * 900 * 3);
    for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 2654435761) >>> 24;
    const png = await sharp(noise, { raw: { width: 900, height: 900, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    expect(png.length).toBeGreaterThan(1_100_000);
    expect(png.length).toBeLessThan(config.MCP_MEDIA_MAX_BYTES);
    const up = await callTool(app, t, "upload_image", { data_base64: png.toString("base64"), alt: "Shovqin" });
    expect(up.isError, up.text).toBe(false);
    expect(up.json.media.width).toBe(900);

    const big = await app.request(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${t}`, accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_post_draft", arguments: { title: "x", content_markdown: "a".repeat(1_100_000) } } }),
    });
    expect(big.status).toBe(413);
    const tooBig = await app.request(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
      body: JSON.stringify({ pad: "x".repeat(config.MCP_MEDIA_MAX_BYTES * 2) }),
    });
    expect(tooBig.status).toBe(413);
  });
});

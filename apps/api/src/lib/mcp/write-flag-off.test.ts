import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD, type TestUser } from "../../test/auth-test-helpers.js";
import { ALL_BLOG_SCOPES, API, authorize, callTool, connect, mcpCall, registerClient, type Json } from "../../test/mcp-harness.js";

// MCP yoqilgan, yozuv kaliti O'RNATILMAGAN (standart: o'chiq) — server PR #11 bilan bir xil bo'lishi kerak.
vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  delete process.env.MCP_WRITE_TOOLS_ENABLED;
  delete process.env.MCP_PURGE_ENABLED;
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
});

let app: Hono;
let admin: TestUser;
const READ_TOOLS = [
  "whoami", "list_posts", "get_post", "list_tags", "list_comments", "get_site_stats", "get_post_stats",
  "list_post_revisions", "get_post_revision", "list_trash", "list_audit_log", "list_media",
];

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  admin = await createTestUser({ role: "admin" });
});

describe("MCP_WRITE_TOOLS_ENABLED off (default) behaves exactly like the read-only connector", () => {
  it("lists only the 12 read tools; write tools do not exist", async () => {
    const { tokens } = await connect(app, { email: admin.email, password: TEST_USER_PASSWORD });
    const tools = (await mcpCall(app, tokens.access_token, "tools/list")).body.result.tools as Json[];
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
    for (const name of ["create_post_draft", "publish_post", "send_to_channel", "purge_post", "upload_image"]) {
      const r = await mcpCall(app, tokens.access_token, "tools/call", { name, arguments: {} });
      expect(JSON.stringify(r.body), name).toMatch(/not found|Unknown|error/i);
      expect(r.body.result?.isError === true || r.body.error !== undefined, name).toBe(true);
    }
  });

  it("asking for every scope still yields read access only (consent, token, metadata)", async () => {
    const { tokens, authorize: a } = await connect(app, { email: admin.email, password: TEST_USER_PASSWORD }, { scope: ALL_BLOG_SCOPES });
    expect(tokens.scope.split(" ").sort()).toEqual(["blog:read", "offline_access"]);
    expect(a.consentUrl).toContain("scope=blog%3Aread+offline_access");
    const who = await callTool(app, tokens.access_token, "whoami");
    expect(who.json.server.mode).toBe("read-only");
    expect(who.json.grantedScopes.map((s: Json) => s.id)).toEqual(["blog:read"]);

    const meta = (await (await app.request(`${API}/.well-known/oauth-authorization-server/api/auth`)).json()) as Json;
    expect([...meta.scopes_supported].sort()).toEqual(["blog:read", "offline_access"]);
    const prm = (await (await app.request(`${API}/.well-known/oauth-protected-resource/mcp`)).json()) as Json;
    expect(prm.scopes_supported).toEqual(["blog:read"]);
    const challenge = await mcpCall(app, undefined, "initialize");
    expect(challenge.www).toContain('scope="blog:read offline_access"');
  });

  it("a consent POST that tries to grant a write scope is refused", async () => {
    const clientId = await registerClient(app);
    const a = await authorize(app, { clientId, email: admin.email, password: TEST_USER_PASSWORD, scope: "blog:read posts:write", stopAtConsent: true });
    const raw = new URL(a.consentUrl!).search.slice(1);
    const res = await a.browser.req(`${API}/api/auth/oauth2/consent`, {
      method: "POST",
      origin: "http://localhost:3000",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accept: true, oauth_query: raw, scope: "blog:read posts:write" }),
    });
    expect([400, 403]).toContain(res.status);
  });
});

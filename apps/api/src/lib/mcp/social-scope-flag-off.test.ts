import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD, type TestUser } from "../../test/auth-test-helpers.js";
import { ALL_BLOG_SCOPES, API, authorize, callTool, connect, mcpCall, type Json } from "../../test/mcp-harness.js";

// MCP + yozuv vositalari YOQILGAN, DISTRIBUTION_ENABLED o'chiq: `social:post` umuman mavjud emas (ro'yxatlar `main` bilan bir xil).
vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_WRITE_TOOLS_ENABLED = "true";
  delete process.env.DISTRIBUTION_ENABLED;
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
});

let app: Hono;
let admin: TestUser;
const creds = () => ({ email: admin.email, password: TEST_USER_PASSWORD });

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  admin = await createTestUser({ role: "admin" });
});

describe("distribution flag off: the social permission does not exist anywhere", () => {
  it("discovery, scope descriptions and the 401 challenge list exactly the pre-distribution permissions", async () => {
    const expected = ["blog:read", "posts:write", "media:upload", "posts:publish", "channels:send", "comments:moderate", "posts:delete", "offline_access"];
    const meta = (await (await app.request(`${API}/.well-known/oauth-authorization-server/api/auth`)).json()) as Json;
    expect([...meta.scopes_supported].sort()).toEqual([...expected].sort());
    expect(Object.keys(meta.scope_descriptions).sort()).toEqual([...expected].sort());
    const prm = (await (await app.request(`${API}/.well-known/oauth-protected-resource/mcp`)).json()) as Json;
    expect([...prm.scopes_supported].sort()).toEqual(expected.filter((id) => id !== "offline_access").sort());
    const ch = await mcpCall(app, undefined, "initialize");
    expect(ch.www).not.toContain("social");
  });

  it("asking for social:post is clamped away: the consent page is never asked for it and the token never carries it", async () => {
    const a = await authorize(app, { clientId: (await connect(app, creds(), { scope: ALL_BLOG_SCOPES })).clientId, ...creds(), scope: `${ALL_BLOG_SCOPES} social:post`, stopAtConsent: true });
    // yangi rozilik talab qilinmadi (so'rov oldingi bilan bir xil bo'lib qoldi) yoki sahifa social:post'siz ochildi
    if (a.consentUrl) expect(a.consentUrl).not.toContain("social");
    const { tokens } = await connect(app, creds(), { scope: `${ALL_BLOG_SCOPES} social:post` });
    expect(tokens.scope.split(" ")).not.toContain("social:post");
    expect(tokens.scope.split(" ").sort()).toEqual(ALL_BLOG_SCOPES.split(" ").sort());
  });

  it("tools/list has no distribution tool; whoami lists no social permission and no social limit", async () => {
    const { tokens } = await connect(app, creds(), { scope: ALL_BLOG_SCOPES });
    const tools = (await mcpCall(app, tokens.access_token, "tools/list")).body.result.tools as Json[];
    expect(tools.map((t) => t.name).filter((n) => /distribution/.test(n))).toEqual([]);
    const who = (await callTool(app, tokens.access_token, "whoami")).json as Json;
    expect(who.grantedScopes.map((g: Json) => g.id)).not.toContain("social:post");
    expect(Object.keys(who.server.writeLimits).sort()).toEqual(["channelSendsPerDay", "createsPerHour", "destructivePerDay", "editsPerHour", "moderationPerHour", "publishesPerDay", "uploadsPerHour"]);
  });
});

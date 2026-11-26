import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD, type TestUser } from "../../test/auth-test-helpers.js";
import { ALL_BLOG_SCOPES, authorize, callTool, connect, exchangeCode, registerClient, type Json } from "../../test/mcp-harness.js";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_WRITE_TOOLS_ENABLED = "true";
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
});

let app: Hono;
let admin: TestUser;
const creds = () => ({ email: admin.email, password: TEST_USER_PASSWORD });
const NEW = "channels:prepare staff:manage settings:manage";

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  admin = await createTestUser({ role: "admin" });
});

describe("the new permissions force a fresh consent and are never granted silently", () => {
  it("an owner who approved every PREVIOUS permission is asked again for channels:prepare, staff:manage and settings:manage", async () => {
    const clientId = await registerClient(app, undefined, "Eski ruxsatlar");
    const first = await connect(app, creds(), { clientId, scope: ALL_BLOG_SCOPES });
    expect(first.authorize.steps).toContain("consent-page");
    expect(first.tokens.scope.split(" ")).not.toContain("staff:manage");

    const again = await authorize(app, { clientId, ...creds(), scope: `${ALL_BLOG_SCOPES} ${NEW}`, browser: first.authorize.browser, stopAtConsent: true });
    expect(again.steps).toContain("consent-page");
    for (const scope of NEW.split(" ")) expect(decodeURIComponent(again.consentUrl!)).toContain(scope);

    // Re-asking for the old set only does not prompt again.
    const same = await authorize(app, { clientId, ...creds(), scope: ALL_BLOG_SCOPES, browser: first.authorize.browser });
    expect(same.steps).not.toContain("consent-page");
  });

  it("the old token never gains the new tools; the new token has exactly what was ticked", async () => {
    const clientId = await registerClient(app, undefined, "Qisman");
    const first = await connect(app, creds(), { clientId, scope: ALL_BLOG_SCOPES });
    const upgraded = await authorize(app, { clientId, ...creds(), scope: `${ALL_BLOG_SCOPES} ${NEW}`, browser: first.authorize.browser, consentScope: `blog:read channels:prepare offline_access` });
    const tok = await exchangeCode(app, upgraded);
    expect(tok.body.scope.split(" ").sort()).toEqual(["blog:read", "channels:prepare", "offline_access"]);
    const oldWho = await callTool(app, first.tokens.access_token, "whoami");
    expect(oldWho.json.grantedScopes.map((s: Json) => s.id)).not.toContain("channels:prepare");
    expect((await callTool(app, first.tokens.access_token, "list_staff")).json.error.code).toBe("insufficient_scope");
    expect((await callTool(app, tok.body.access_token, "list_staff")).json.error.requiredScope).toBe("staff:manage");
    expect((await callTool(app, tok.body.access_token, "list_channel_versions", { id: "00000000-0000-4000-8000-000000000000" })).json.error.code).toBe("not_found");
  });
});

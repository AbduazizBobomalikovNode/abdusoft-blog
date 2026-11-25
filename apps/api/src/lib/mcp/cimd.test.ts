import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD, type TestUser } from "../../test/auth-test-helpers.js";
import { CLAUDE_REDIRECT, MCP_URL, authorize, exchangeCode, mcpCall } from "../../test/mcp-harness.js";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
});

const GOOD = "https://client.example.test/good.json";
const EVIL = "https://client.example.test/evil.json";

let app: Hono;
let admin: TestUser;
let setCimdFetchForTests: typeof import("./plugins.js").setCimdFetchForTests;

const doc = (id: string, redirect: string) => ({
  client_id: id,
  client_name: "Claude (metadata document)",
  redirect_uris: [redirect],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
});

beforeAll(async () => {
  await migrateTestDb();
  ({ setCimdFetchForTests } = await import("./plugins.js"));
  ({ app } = await import("../../app.js"));
  admin = await createTestUser({ role: "admin" });
  setCimdFetchForTests(async (input) => {
    const url = String(input);
    const body = url === GOOD ? doc(GOOD, CLAUDE_REDIRECT) : url === EVIL ? doc(EVIL, "https://evil.example/cb") : null;
    if (!body) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": "max-age=60" } });
  });
});

afterAll(() => setCimdFetchForTests(null));

describe("client ID metadata documents", () => {
  it("supports a client_id that is an https URL (Claude's published metadata document)", async () => {
    const a = await authorize(app, { clientId: GOOD, email: admin.email, password: TEST_USER_PASSWORD, scope: "blog:read offline_access" });
    expect(a.steps).toEqual(["login-page", "consent-page", "redirect_uri"]);
    const tok = await exchangeCode(app, a);
    expect(tok.status).toBe(200);
    expect(tok.body.refresh_token).toBeTruthy();
    expect((await mcpCall(app, tok.body.access_token, "tools/list")).status).toBe(200);
    expect(MCP_URL).toContain("/mcp");
  });

  it("refuses a metadata document whose redirect URI is outside the allow-list", async () => {
    await expect(
      authorize(app, { clientId: EVIL, redirectUri: "https://evil.example/cb", email: admin.email, password: TEST_USER_PASSWORD, scope: "blog:read" }),
    ).rejects.toThrow();
  });
});

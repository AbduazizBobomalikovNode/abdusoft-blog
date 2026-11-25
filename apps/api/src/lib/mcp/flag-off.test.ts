import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { MAIN_AUTH_API_KEYS, MAIN_ROUTE_TABLE } from "../../test/main-route-table.js";

// MCP_ENABLED o'rnatilmagan — bayroq o'chiq. API `main`dagi bilan aynan bir xil bo'lishi kerak.
vi.hoisted(() => {
  delete process.env.MCP_ENABLED;
});

let app: Hono;

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
});

describe("MCP_ENABLED off — no new surface", () => {
  it("has exactly the route table of main", () => {
    expect(app.routes.map((r) => `${r.method} ${r.path}`)).toEqual([...MAIN_ROUTE_TABLE]);
  });

  it.each([
    ["GET", "/.well-known/oauth-authorization-server/api/auth"],
    ["GET", "/.well-known/oauth-authorization-server"],
    ["GET", "/.well-known/oauth-protected-resource"],
    ["GET", "/.well-known/oauth-protected-resource/mcp"],
    ["GET", "/.well-known/openid-configuration"],
    ["POST", "/mcp"],
    ["GET", "/mcp"],
    ["GET", "/api/auth/jwks"],
    ["GET", "/api/auth/.well-known/oauth-authorization-server"],
    ["POST", "/api/auth/oauth2/register"],
    ["POST", "/api/auth/oauth2/token"],
    ["GET", "/api/auth/oauth2/authorize"],
    ["POST", "/api/auth/oauth2/consent"],
    ["GET", "/admin/connections"],
    ["GET", "/connector/consent"],
  ])("%s %s is not served", async (method, path) => {
    const res = await app.request(path, {
      method,
      headers: method === "POST" ? { "content-type": "application/json" } : {},
      body: method === "POST" ? "{}" : undefined,
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("answers the existing auth endpoints exactly as main did", async () => {
    const ok = await app.request("/api/auth/ok");
    expect([ok.status, await ok.json()]).toEqual([200, { ok: true }]);

    const session = await app.request("/api/auth/get-session");
    expect([session.status, await session.json()]).toEqual([200, null]);

    const signUp = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(signUp.status).toBe(400);
    expect(await signUp.json()).toEqual({
      message:
        "[body.name] Invalid input: expected string, received undefined; [body.email] Invalid input: expected string, received undefined; [body.password] Invalid input: expected string, received undefined",
      code: "VALIDATION_ERROR",
    });
  });

  it("registers no plugin endpoints on the auth instance", async () => {
    const { auth } = await import("../auth.js");
    expect(Object.keys(auth.api).sort()).toEqual([...MAIN_AUTH_API_KEYS]);
  });
});

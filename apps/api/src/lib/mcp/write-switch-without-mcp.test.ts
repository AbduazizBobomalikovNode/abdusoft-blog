import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { MAIN_AUTH_API_KEYS, MAIN_ROUTE_TABLE } from "../../test/main-route-table.js";

// Yozuv va butunlay o'chirish kalitlari yoqilgan, lekin MCP_ENABLED yo'q: hech narsa o'zgarmasligi kerak (asosiy bayroq hal qiladi).
vi.hoisted(() => {
  delete process.env.MCP_ENABLED;
  process.env.MCP_WRITE_TOOLS_ENABLED = "true";
  process.env.MCP_PURGE_ENABLED = "true";
});

let app: Hono;
beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
});

describe("write switches without MCP_ENABLED", () => {
  it("the route table and the auth API are exactly those of main; /mcp does not exist", async () => {
    expect(app.routes.map((r) => `${r.method} ${r.path}`)).toEqual([...MAIN_ROUTE_TABLE]);
    const { auth } = await import("../auth.js");
    expect(Object.keys(auth.api).sort()).toEqual([...MAIN_AUTH_API_KEYS]);
    for (const [method, path] of [["POST", "/mcp"], ["GET", "/.well-known/oauth-protected-resource/mcp"], ["POST", "/api/auth/oauth2/consent"], ["GET", "/admin/connections"]] as const) {
      const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });
});

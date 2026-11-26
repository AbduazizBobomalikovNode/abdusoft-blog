import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD } from "../../test/auth-test-helpers.js";
import { ALL_BLOG_SCOPES, callTool, connect, mcpCall, type Json } from "../../test/mcp-harness.js";

// MCP va yozuv vositalari YOQILGAN, lekin DISTRIBUTION_ENABLED o'rnatilmagan: ro'yxat bayroqdan oldingi bilan bir xil.
vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_WRITE_TOOLS_ENABLED = "true";
  delete process.env.DISTRIBUTION_ENABLED;
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
});

let app: Hono;
let token: string;

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  const admin = await createTestUser({ role: "admin" });
  token = (await connect(app, { email: admin.email, password: TEST_USER_PASSWORD }, { scope: ALL_BLOG_SCOPES })).tokens.access_token;
});

describe("DISTRIBUTION_ENABLED off", () => {
  it("registers no distribution tool and cannot call one", async () => {
    const tools = (await mcpCall(app, token, "tools/list")).body.result.tools as Json[];
    expect(tools.map((t) => t.name).filter((n) => /distribution/.test(n))).toEqual([]);
    const r = await callTool(app, token, "send_distribution", {});
    expect(r.isError || r.raw.error !== undefined).toBe(true);
  });
});

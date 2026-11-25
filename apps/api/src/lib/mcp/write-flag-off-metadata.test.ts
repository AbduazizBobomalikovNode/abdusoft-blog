import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD } from "../../test/auth-test-helpers.js";
import { connect, mcpCall, type Json } from "../../test/mcp-harness.js";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  delete process.env.MCP_WRITE_TOOLS_ENABLED;
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
});

let tools: Record<string, Json>;

beforeAll(async () => {
  await migrateTestDb();
  const { app } = (await import("../../app.js")) as { app: Hono };
  const admin = await createTestUser({ role: "admin" });
  const { tokens } = await connect(app, { email: admin.email, password: TEST_USER_PASSWORD });
  const list = (await mcpCall(app, tokens.access_token, "tools/list")).body.result.tools as Json[];
  tools = Object.fromEntries(list.map((t) => [t.name, t]));
});

describe("with the write switch off the read tools advertise the same metadata as before write tools existed", () => {
  it("get_post and get_post_revision: include has the visible default 'both' and only the original three forms", () => {
    for (const name of ["get_post", "get_post_revision"]) {
      const include = tools[name]!.inputSchema.properties.include;
      expect(include.default, name).toBe("both");
      expect(include.enum, name).toEqual(["both", "text", "document"]);
    }
  });

  it("no description mentions Markdown output or edit tools that do not exist", () => {
    expect(tools.get_post!.description).not.toMatch(/Markdown/);
    expect(tools.get_post_revision!.description).toMatch(/restoring is not available yet/);
    expect(Object.keys(tools)).toHaveLength(12);
  });
});

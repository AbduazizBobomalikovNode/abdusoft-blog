import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD, type TestUser } from "../../test/auth-test-helpers.js";
import { API, callTool, connect } from "../../test/mcp-harness.js";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_RESULT_MAX_CHARS = "3000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
});

let app: Hono;
let admin: TestUser;
let token: string;

async function api(path: string, body: unknown, method = "POST") {
  return app.request(`${API}${path}`, { method, headers: { cookie: admin.cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
}

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  admin = await createTestUser({ role: "admin" });
  ({ tokens: { access_token: token } } = await connect(app, { email: admin.email, password: TEST_USER_PASSWORD }).then((c) => ({ tokens: c.tokens })));
});

describe("result size cap (MCP_RESULT_MAX_CHARS=3000)", () => {
  it("shrinks a very long post (drops the document, then truncates the text) and says so", async () => {
    const created = (await (await api("/admin/posts", { title: "Uzun post" })).json()) as { id: string };
    const paragraphs = Array.from({ length: 80 }, (_, i) => ({
      type: "paragraph",
      content: [{ type: "text", text: `Uzun abzats ${i}: ${"so'z ".repeat(40)}` }],
    }));
    expect((await api(`/admin/posts/${created.id}`, { contentJson: { type: "doc", content: paragraphs } }, "PATCH")).status).toBe(200);

    const r = await callTool(app, token, "get_post", { id: created.id });
    expect(r.isError).toBe(false);
    expect(r.text.length).toBeLessThanOrEqual(3000);
    expect(r.json.post.id).toBe(created.id);
    expect(r.json).not.toHaveProperty("document");
    expect(r.json.content.length).toBeGreaterThan(200);
    expect(r.json.truncated.reasons.join(" ")).toMatch(/document.*omitted/);
    expect(r.json.truncated.reasons.join(" ")).toMatch(/content.*truncated/);
    expect(r.json.post.updatedAt).toBeTruthy();
  });

  it("cuts long lists and points to a smaller limit / next page", async () => {
    for (let i = 0; i < 12; i += 1) {
      await api("/admin/posts", { title: `Ro'yxat posti ${i} ${"uzun-sarlavha ".repeat(8)}` });
    }
    const r = await callTool(app, token, "list_posts", { limit: 50 });
    expect(r.text.length).toBeLessThanOrEqual(3000);
    expect(r.json.items.length).toBeLessThan(12);
    expect(r.json.total).toBeGreaterThanOrEqual(12);
    expect(r.json.truncated.hint).toMatch(/smaller 'limit'/);
    // Sahifalash ishlaydi: kichik limit bilan hammasi sig'adi va hasMore/nextPage beriladi
    const small = await callTool(app, token, "list_posts", { limit: 3, page: 2 });
    expect(small.json).toMatchObject({ page: 2, limit: 3, hasMore: true, nextPage: 3 });
  });
});

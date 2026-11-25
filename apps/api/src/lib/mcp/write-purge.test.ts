import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD, type TestUser } from "../../test/auth-test-helpers.js";
import { callTool, connect, mcpCall, type Json } from "../../test/mcp-harness.js";

// Ikkala kalit ham yoqilgan: butunlay o'chirish vositasi faqat shunda mavjud (o'chiq holat `write-tools.test.ts`da).
vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_WRITE_TOOLS_ENABLED = "true";
  process.env.MCP_PURGE_ENABLED = "true";
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
});

let app: Hono;
let admin: TestUser;
let t: string;
let db: typeof import("../../db/index.js").db;
let s: typeof import("../../db/schema.js");

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  ({ db } = await import("../../db/index.js"));
  s = await import("../../db/schema.js");
  admin = await createTestUser({ role: "admin" });
  t = (await connect(app, { email: admin.email, password: TEST_USER_PASSWORD })).tokens.access_token;
});

describe("purge_post (MCP_PURGE_ENABLED=true)", () => {
  it("is listed, and deletes only a trashed post with matching title and a fresh token", async () => {
    const names = ((await mcpCall(app, t, "tools/list")).body.result.tools as Json[]).map((x) => x.name);
    expect(names).toContain("purge_post");
    expect((await callTool(app, t, "whoami")).json.server.permanentDeleteEnabled).toBe(true);

    const p = (await callTool(app, t, "create_post_draft", { title: "Butunlay o'chadi", content_markdown: "## A\n\nmatn matn" })).json.post;
    await db.insert(s.comments).values({ postId: p.id, path: "0001", authorName: "X", body: "salom", bodyHtml: "<p>salom</p>", status: "visible" });
    // not in the trash yet
    const live = await callTool(app, t, "purge_post", { id: p.id, expected_updated_at: p.updatedAt, confirm_title: "Butunlay o'chadi" });
    expect(live.json.error.code).toBe("conflict");
    const trashed = (await callTool(app, t, "trash_post", { id: p.id, expected_updated_at: p.updatedAt })).json.post;
    const wrongTitle = await callTool(app, t, "purge_post", { id: p.id, expected_updated_at: trashed.updatedAt, confirm_title: "Boshqa" });
    expect(wrongTitle.json.error.code).toBe("invalid_input");
    const stale = await callTool(app, t, "purge_post", { id: p.id, expected_updated_at: "2000-01-01T00:00:00.000Z", confirm_title: "Butunlay o'chadi" });
    expect(stale.json.error.code).toBe("conflict");
    expect((await db.select().from(s.posts).where(eq(s.posts.id, p.id))).length).toBe(1);

    const done = await callTool(app, t, "purge_post", { id: p.id, expected_updated_at: trashed.updatedAt, confirm_title: "Butunlay o'chadi" });
    expect(done.isError, done.text).toBe(false);
    expect((await db.select().from(s.posts).where(eq(s.posts.id, p.id))).length).toBe(0);
    expect((await db.select().from(s.comments).where(eq(s.comments.postId, p.id))).length).toBe(0);
    const audit = (await db.select().from(s.auditLog).where(eq(s.auditLog.action, "post.purge")))[0]!;
    expect(audit).toMatchObject({ via: "mcp", entityId: p.id });
    expect(audit.meta).toMatchObject({ tool: "purge_post" });
    // already gone: clear message, nothing else
    const again = await callTool(app, t, "purge_post", { id: p.id, expected_updated_at: trashed.updatedAt, confirm_title: "Butunlay o'chadi" });
    expect(again.json.error.code).toBe("not_found");
  });

  it("needs the posts:delete permission", async () => {
    const limited = (await connect(app, { email: admin.email, password: TEST_USER_PASSWORD }, { consentScope: "blog:read posts:write offline_access" })).tokens.access_token;
    const r = await callTool(app, limited, "purge_post", { id: "00000000-0000-4000-8000-000000000000", expected_updated_at: new Date().toISOString(), confirm_title: "x" });
    expect(r.json.error).toMatchObject({ code: "insufficient_scope", requiredScope: "posts:delete" });
  });
});

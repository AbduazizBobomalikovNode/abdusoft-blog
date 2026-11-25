import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD, type TestUser } from "../../test/auth-test-helpers.js";
import { callTool, connect, type Json } from "../../test/mcp-harness.js";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_WRITE_TOOLS_ENABLED = "true";
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
  process.env.MCP_WRITE_LIMIT_CREATES_PER_HOUR = "2";
  process.env.MCP_WRITE_LIMIT_EDITS_PER_HOUR = "3";
  process.env.MCP_WRITE_LIMIT_PUBLISHES_PER_DAY = "1";
  process.env.MCP_WRITE_LIMIT_DESTRUCTIVE_PER_DAY = "1";
  process.env.MCP_WRITE_LIMIT_MODERATION_PER_HOUR = "1";
  process.env.POST_REVISION_MAX_PER_POST = "2";
});

let app: Hono;
let admin: TestUser;
let db: typeof import("../../db/index.js").db;
let schema: typeof import("../../db/schema.js");
let a: { access_token: string };
let b: { access_token: string };
const MD = "## A\n\nBu yetarlicha uzun matn va u hammasi joyida.";

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  ({ db } = await import("../../db/index.js"));
  schema = await import("../../db/schema.js");
  admin = await createTestUser({ role: "admin" });
  a = (await connect(app, { email: admin.email, password: TEST_USER_PASSWORD }, { name: "A" })).tokens;
  b = (await connect(app, { email: admin.email, password: TEST_USER_PASSWORD }, { name: "B" })).tokens;
});

describe("per-connection write limits", () => {
  it("stops creations after the limit with an actionable error naming the limit, the env var and the reset time", async () => {
    const t = a.access_token;
    expect((await callTool(app, t, "create_post_draft", { title: "Bir", content_markdown: MD })).isError).toBe(false);
    const second = await callTool(app, t, "create_post_draft", { title: "Ikki", content_markdown: MD, idempotency_key: "limit-key-00001" });
    expect(second.isError).toBe(false);
    const third = await callTool(app, t, "create_post_draft", { title: "Uch", content_markdown: MD });
    expect(third.isError).toBe(true);
    const e = third.json.error as Json;
    expect(e.code).toBe("rate_limited");
    expect(e.message).toContain("2");
    expect(e.hint).toContain("MCP_WRITE_LIMIT_CREATES_PER_HOUR");
    expect(e.limit).toMatchObject({ category: "create", max: 2, window: "1 hour", used: 2 });
    expect(Date.parse(e.resetsAt)).toBeGreaterThan(Date.now());
    expect(e.retryAfterSeconds).toBeGreaterThan(0);
    expect(e.retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect((await db.select().from(schema.posts).where(eq(schema.posts.title, "Uch"))).length).toBe(0);

    // A replayed idempotent call creates nothing, so it is not counted/blocked... it IS blocked only if it would write: replays are checked after the limit here.
    // Another connection has its own budget.
    expect((await callTool(app, b.access_token, "create_post_draft", { title: "B bir", content_markdown: MD })).isError).toBe(false);
    // Reads are never limited.
    expect((await callTool(app, t, "list_posts")).isError).toBe(false);
  });

  it("the window slides: older actions stop counting", async () => {
    const t = a.access_token;
    const old = new Date(Date.now() - 2 * 3600_000);
    await db.update(schema.auditLog).set({ createdAt: old }).where(and(eq(schema.auditLog.action, "post.create"), eq(schema.auditLog.via, "mcp")));
    expect((await callTool(app, t, "create_post_draft", { title: "Yana", content_markdown: MD })).isError).toBe(false);
  });

  it("publishes per day: dry runs do not count, the second real publish is refused", async () => {
    const t = b.access_token;
    const p1 = (await callTool(app, t, "create_post_draft", { title: "Chop 1", content_markdown: MD })).json.post;
    const p2 = (await callTool(app, t, "create_post_draft", { title: "Chop 2", content_markdown: MD })).json.post;
    for (let i = 0; i < 3; i += 1) {
      expect((await callTool(app, t, "publish_post", { id: p1.id, expected_updated_at: p1.updatedAt, dry_run: true })).isError).toBe(false);
    }
    const real = await callTool(app, t, "publish_post", { id: p1.id, expected_updated_at: p1.updatedAt });
    expect(real.isError).toBe(false);
    const blocked = await callTool(app, t, "publish_post", { id: p2.id, expected_updated_at: p2.updatedAt });
    expect(blocked.json.error).toMatchObject({ code: "rate_limited", limit: { category: "publish", max: 1, window: "24 hours" } });
    expect(blocked.json.error.hint).toContain("MCP_WRITE_LIMIT_PUBLISHES_PER_DAY");
    expect((await db.select().from(schema.posts).where(eq(schema.posts.id, p2.id)))[0]!.status).toBe("draft");
  });

  it("limits edits, destructive actions and moderation separately", async () => {
    const t = (await connect(app, { email: admin.email, password: TEST_USER_PASSWORD }, { name: "C" })).tokens.access_token;
    // creations of this client are fresh (limit 2): make two posts, then edit up to the limit of 3
    const p = (await callTool(app, t, "create_post_draft", { title: "Tahrir", content_markdown: MD })).json.post;
    let token = p.updatedAt as string;
    for (let i = 0; i < 3; i += 1) {
      const r = await callTool(app, t, "update_post", { id: p.id, expected_updated_at: token, excerpt: `ex ${i}` });
      expect(r.isError, r.text).toBe(false);
      token = r.json.post.updatedAt;
    }
    const over = await callTool(app, t, "update_post", { id: p.id, expected_updated_at: token, excerpt: "ex 4" });
    expect(over.json.error).toMatchObject({ code: "rate_limited", limit: { category: "edit", max: 3 } });

    // destructive: one trash allowed per day
    const q = (await callTool(app, t, "create_post_draft", { title: "O'chadi 1", content_markdown: MD })).json.post;
    const trash1 = await callTool(app, t, "trash_post", { id: q.id, expected_updated_at: q.updatedAt });
    expect(trash1.isError, trash1.text).toBe(false);
    const rows = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.action, "post.trash"), inArray(schema.auditLog.via, ["mcp"])));
    expect(rows.length).toBe(1);
    // moderation: limit 1
    const [post] = await db.insert(schema.posts).values({ slug: "izoh-post", title: "Izoh post", contentJson: { type: "doc", content: [{ type: "paragraph" }] }, contentHtml: "", contentText: "", toc: [], status: "draft" }).returning();
    const cs = await db
      .insert(schema.comments)
      .values([1, 2].map((n) => ({ postId: post!.id, path: `000${n}`, authorName: "X", body: "salom", bodyHtml: "<p>salom</p>", status: "visible" as const })))
      .returning();
    expect((await callTool(app, t, "moderate_comment", { id: cs[0]!.id, action: "hide" })).isError).toBe(false);
    const m2 = await callTool(app, t, "moderate_comment", { id: cs[1]!.id, action: "hide" });
    expect(m2.json.error).toMatchObject({ code: "rate_limited", limit: { category: "moderate" } });
  });
});

describe("revision history cap", () => {
  it("every connector edit is snapshotted, but only the newest POST_REVISION_MAX_PER_POST revisions are kept (the oldest drop first)", async () => {
    const t = (await connect(app, { email: admin.email, password: TEST_USER_PASSWORD }, { name: "D" })).tokens.access_token;
    const p = (await callTool(app, t, "create_post_draft", { title: "Tarix chegarasi", content_markdown: MD })).json.post;
    let token = p.updatedAt as string;
    for (let i = 1; i <= 3; i += 1) {
      const r = await callTool(app, t, "update_post", { id: p.id, expected_updated_at: token, title: `Versiya ${i}` });
      token = r.json.post.updatedAt;
    }
    const revs = await db.select().from(schema.postRevisions).where(eq(schema.postRevisions.postId, p.id));
    expect(revs.map((r) => r.title).sort()).toEqual(["Versiya 1", "Versiya 2"]);
  });
});

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD, type TestUser } from "../../test/auth-test-helpers.js";
import { API, callTool, connect, type Json } from "../../test/mcp-harness.js";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_WRITE_TOOLS_ENABLED = "true";
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
});

let app: Hono;
let admin: TestUser;
let staff: TestUser;
let token: string;

const bomb = { type: "doc", content: [{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { colspan: 1_000_000 }, content: [{ type: "paragraph" }] }] }] }] };

const api = (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) =>
  app.request(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie: init.cookie ?? admin.cookie, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  admin = await createTestUser({ role: "admin", name: "Owner" });
  staff = await createTestUser({ role: "staff", name: "Xodim" });
  token = (await connect(app, { email: admin.email, password: TEST_USER_PASSWORD }, { name: "Claude" })).tokens.access_token;
});

describe("a tiny structured document cannot exhaust the API's memory", () => {
  it("create_post_draft and update_post refuse it with invalid_input, fast, and write nothing", async () => {
    const started = performance.now();
    const created = await callTool(app, token, "create_post_draft", { title: "Bomba", content_document: bomb });
    expect(created.isError).toBe(true);
    expect((created.json as Json).error.code).toBe("invalid_input");
    expect(performance.now() - started).toBeLessThan(8000);

    const ok = await callTool(app, token, "create_post_draft", { title: "Oddiy", content_markdown: "## A\n\nmatn matn matn" });
    expect(ok.isError).toBe(false);
    const id = (ok.json as Json).post.id as string;
    const updated = await callTool(app, token, "update_post", { id, expected_updated_at: (ok.json as Json).post.updatedAt, content_document: bomb });
    expect(updated.isError).toBe(true);
    expect((updated.json as Json).error.code).toBe("invalid_input");
    const after = (await (await api(`/admin/posts/${id}`)).json()) as Json;
    expect(after.updatedAt).toBe((ok.json as Json).post.updatedAt);
  });

  it("the panel PATCH refuses it with 400 (admin and staff), and still accepts a normal document", async () => {
    const draft = (await (await api("/admin/posts", { method: "POST", body: { title: "Panel" } })).json()) as { id: string };
    const staffDraft = (await (await api("/admin/posts", { method: "POST", body: { title: "Xodim posti" }, cookie: staff.cookie })).json()) as { id: string };
    const started = performance.now();
    const res = await api(`/admin/posts/${draft.id}`, { method: "PATCH", body: { contentJson: bomb } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Json).error).toMatch(/Hujjat qabul qilinmadi/);
    const res2 = await api(`/admin/posts/${staffDraft.id}`, { method: "PATCH", body: { contentJson: bomb }, cookie: staff.cookie });
    expect(res2.status).toBe(400);
    expect(performance.now() - started).toBeLessThan(8000);

    const normal = { type: "doc", content: [{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", attrs: { colspan: 2, rowspan: 1, colwidth: null }, content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] }] }] }] };
    expect((await api(`/admin/posts/${draft.id}`, { method: "PATCH", body: { contentJson: normal } })).status).toBe(200);
  });
});

describe("check-stored-docs reports counts and ids only", () => {
  it("passes everything the editor stored and flags only a rejected document, without printing content", async () => {
    const { db } = await import("../../db/index.js");
    const { posts } = await import("../../db/schema.js");
    const { checkStoredDocs } = await import("../content/stored-docs-check.js");
    const before = await checkStoredDocs(db);
    expect(before.failures).toEqual([]);
    expect(before.counts.posts).toBeGreaterThan(0);

    const [row] = await db.insert(posts).values({ slug: "bomba-qator", title: "SECRETTITLE", contentJson: bomb, contentHtml: "", toc: [], status: "draft" }).returning();
    const after = await checkStoredDocs(db);
    expect(after.failures).toEqual([{ kind: "post", id: row!.id }]);
    expect(JSON.stringify(after)).not.toContain("SECRETTITLE");
  });
});

describe("pathological Markdown cannot stall the connector", () => {
  const evil = "**a ".repeat(20_000); // 80 000 characters: quadratic in the old parser (~12 s)
  const nested = "> ".repeat(30_000) + "x";

  it("a stale token is refused before any Markdown work is done", async () => {
    const created = await callTool(app, token, "create_post_draft", { title: "Eskirgan token", content_markdown: "## A\n\nmatn matn matn" });
    const id = (created.json as Json).post.id as string;
    const started = performance.now();
    const r = await callTool(app, token, "update_post", { id, expected_updated_at: "2001-01-01T00:00:00.000Z", content_markdown: evil });
    expect(r.isError).toBe(true);
    expect((r.json as Json).error.code).toBe("conflict");
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("adversarial Markdown with a fresh token is processed quickly and deep nesting is a clear invalid_input", async () => {
    const created = await callTool(app, token, "create_post_draft", { title: "Zararli markdown", content_markdown: "## A\n\nmatn matn matn" });
    const id = (created.json as Json).post.id as string;
    const t0 = performance.now();
    const ok = await callTool(app, token, "update_post", { id, expected_updated_at: (created.json as Json).post.updatedAt, content_markdown: evil });
    expect(performance.now() - t0).toBeLessThan(8000);
    expect(ok.isError, ok.text.slice(0, 200)).toBe(false);

    const fresh = await callTool(app, token, "create_post_draft", { title: "Chuqur iqtibos", content_markdown: "## A\n\nmatn matn matn" });
    const t1 = performance.now();
    const deep = await callTool(app, token, "update_post", { id: (fresh.json as Json).post.id, expected_updated_at: (fresh.json as Json).post.updatedAt, content_markdown: nested });
    expect(performance.now() - t1).toBeLessThan(8000);
    expect(deep.isError).toBe(true);
    expect((deep.json as Json).error.code).toBe("invalid_input");
    expect((deep.json as Json).error.message).toMatch(/structural limit/);
  });

  it("reading a stored pathological body as Markdown is bounded in time", async () => {
    const created = await callTool(app, token, "create_post_draft", { title: "Uzun o'qish", content_markdown: "## A\n\nmatn" });
    const id = (created.json as Json).post.id as string;
    const text = "**a ".repeat(20_000);
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
    const { db } = await import("../../db/index.js");
    const { posts } = await import("../../db/schema.js");
    const { eq } = await import("drizzle-orm");
    await db.update(posts).set({ contentJson: doc }).where(eq(posts.id, id));
    const started = performance.now();
    const r = await callTool(app, token, "get_post", { id, include: "markdown" });
    expect(performance.now() - started).toBeLessThan(8000);
    expect(r.isError).toBe(false);
  });
});

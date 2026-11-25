import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD, type TestUser } from "../../test/auth-test-helpers.js";
import { API, callTool, connect, mcpCall, type Json } from "../../test/mcp-harness.js";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
  process.env.POST_REVISION_INTERVAL_MINUTES = "0";
  process.env.SITE_NAME = "Abdusoft blog";
});

let app: Hono;
let admin: TestUser;
let token: string;
let db: typeof import("../../db/index.js").db;
let schema: typeof import("../../db/schema.js");

const TITLE_A = "Sun'iy intellekt va agentlar: o'zbekcha qo'llanma";
const WORD_A = "agentlarnoyobsozA";
const TRASH_MARK = "chiqindiNOMAnoyob9";
const BODY_COMMENT = "Rahmat, juda foydali maqola! Ko'rinishi yoqdi.";

const text = (t: string, marks?: Json[]) => ({ type: "text", text: t, ...(marks ? { marks } : {}) });
const para = (t: string) => ({ type: "paragraph", content: [text(t)] });
const docA = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [text("Kirish")] },
    para(`Bu maqola ${WORD_A} haqida. G'oya, o'zgarish, ma'no.`),
    { type: "bulletList", content: [{ type: "listItem", content: [para("Birinchi band")] }, { type: "listItem", content: [para("Ikkinchi band")] }] },
    { type: "codeBlock", attrs: { language: "typescript" }, content: [text("const x = 1;")] },
  ],
};

async function api(path: string, init: { method?: string; body?: unknown } = {}) {
  return app.request(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie: admin.cookie, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

async function makePost(title: string, slug: string, content: unknown, opts: { publish?: boolean; tag?: string } = {}) {
  const created = (await (await api("/admin/posts", { method: "POST", body: { title } })).json()) as { id: string };
  const patched = await api(`/admin/posts/${created.id}`, {
    method: "PATCH",
    body: { slug, excerpt: `Qisqacha: ${title}`, contentJson: content, ...(opts.tag ? { tagSlugs: [opts.tag] } : {}) },
  });
  expect(patched.status).toBe(200);
  if (opts.publish) expect((await api(`/admin/posts/${created.id}/publish`, { method: "POST" })).status).toBe(200);
  return created.id;
}

let postA: string;
let postB: string;
let postTrashed: string;

// Ko'p post/izoh yaratadi va to'liq OAuth oqimidan o'tadi — parallel yuklanishda 20 soniyadan oshishi mumkin.
beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  ({ db } = await import("../../db/index.js"));
  schema = await import("../../db/schema.js");
  admin = await createTestUser({ role: "admin", name: "Owner" });

  await db.insert(schema.tags).values({ slug: "ai-agentlar", name: "AI agentlar", description: "Agentlar haqida" });
  postA = await makePost(TITLE_A, "sun-iy-intellekt-agentlar", docA, { publish: true, tag: "ai-agentlar" });
  // Qayta tahrir — revision hosil qiladi
  await api(`/admin/posts/${postA}`, { method: "PATCH", body: { title: `${TITLE_A} (tahrir)` } });
  await api(`/admin/posts/${postA}`, { method: "PATCH", body: { title: TITLE_A } });
  postB = await makePost("Qoralama post", "qoralama-post", { type: "doc", content: [para("Hali tugallanmagan matn")] });
  postTrashed = await makePost(`Chiqindi ${TRASH_MARK}`, "chiqindi-post", { type: "doc", content: [para(`Matn ${TRASH_MARK}`)] }, { publish: true });

  await db.insert(schema.comments).values([
    { postId: postA, path: "0001", authorName: "Mehmon", body: BODY_COMMENT, bodyHtml: `<p>${BODY_COMMENT}</p>`, status: "pending" },
    { postId: postA, path: "0002", authorName: "Dilnoza", body: "Ajoyib!", bodyHtml: "<p>Ajoyib!</p>", status: "visible" },
    { postId: postTrashed, path: "0001", authorName: "Boshqa", body: `Izoh ${TRASH_MARK}`, bodyHtml: "<p>x</p>", status: "pending" },
  ]);
  await db.insert(schema.media).values({ key: "k/1.webp", url: "/uploads/1.webp", mime: "image/webp", size: 1234, width: 800, height: 600, alt: "Rasm tavsifi", createdBy: admin.id });
  await db.insert(schema.postViewsDaily).values([
    { postId: postA, day: new Date().toISOString().slice(0, 10), views: 11 },
    { postId: postTrashed, day: new Date().toISOString().slice(0, 10), views: 99 },
  ]);
  await db.execute(sql`update posts set views_count = 11 where id = ${postA}`);

  // Chiqindi qutisiga olish (to'g'ri yo'l orqali): chop etilgan post avval arxivlanadi
  expect((await api(`/admin/posts/${postTrashed}/archive`, { method: "POST" })).status).toBe(200);
  expect((await api(`/admin/posts/${postTrashed}`, { method: "DELETE" })).status).toBe(200);

  ({ tokens: { access_token: token } } = await connect(app, { email: admin.email, password: TEST_USER_PASSWORD }).then((c) => ({ tokens: c.tokens })));
}, 120_000);

const call = (name: string, args: Record<string, unknown> = {}) => callTool(app, token, name, args);

describe("tools/list", () => {
  it("lists every read tool with title, description, strict input schema and annotations", async () => {
    const res = await mcpCall(app, token, "tools/list");
    expect(res.status).toBe(200);
    const tools = res.body.result.tools as Json[];
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["get_post", "get_post_revision", "get_post_stats", "get_site_stats", "list_audit_log", "list_comments", "list_media", "list_post_revisions", "list_posts", "list_tags", "list_trash", "whoami"].sort(),
    );
    for (const tool of tools) {
      expect(tool.name.length).toBeLessThanOrEqual(64);
      expect(tool.title).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(tool.annotations.title).toBe(tool.title);
    }
    const listPosts = tools.find((t) => t.name === "list_posts")!;
    expect(listPosts.inputSchema.properties.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 50 });
    expect(listPosts.inputSchema.properties.status.enum).toContain("published");
    const getPost = tools.find((t) => t.name === "get_post")!;
    expect(Object.keys(getPost.inputSchema.properties)).toEqual(["id", "slug", "include"]);
  });

  it("answers invalid arguments with an actionable tool error, not a transport failure", async () => {
    const res = await mcpCall(app, token, "tools/call", { name: "list_posts", arguments: { limit: 999 } });
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toMatch(/limit/);
  });
});

describe("whoami", () => {
  it("reports the site, the owner, granted scopes, tool availability and limits", async () => {
    const r = await call("whoami");
    expect(r.isError).toBe(false);
    expect(r.json.site.name).toBe("Abdusoft blog");
    expect(r.json.user).toMatchObject({ id: admin.id, email: admin.email, role: "admin" });
    expect(r.json.client.name).toBe("Claude");
    expect(r.json.grantedScopes).toHaveLength(7);
    expect(r.json.tools).toHaveLength(12);
    expect(r.json.tools.every((t: Json) => t.available)).toBe(true);
    expect(r.json.limits).toMatchObject({ resultMaxChars: 100000, maxPageSize: 50, accessTokenTtlSeconds: 900 });
    expect(r.json.server.mode).toBe("read-only");
  });
});

describe("list_posts", () => {
  it("returns compact rows for non-trashed posts only, Uzbek text untouched", async () => {
    const r = await call("list_posts");
    const titles = r.json.items.map((p: Json) => p.title);
    expect(titles).toContain(TITLE_A);
    expect(titles).toContain("Qoralama post");
    expect(titles.some((t: string) => t.includes(TRASH_MARK))).toBe(false);
    expect(r.json.total).toBe(2);
    expect(r.json.totals).toMatchObject({ draft: 1, published: 1, all: 2 });
    const a = r.json.items.find((p: Json) => p.id === postA);
    expect(a).toMatchObject({ slug: "sun-iy-intellekt-agentlar", status: "published", tags: [{ slug: "ai-agentlar", name: "AI agentlar" }] });
    expect(a.counts).toMatchObject({ views: 11 });
    expect(a).not.toHaveProperty("contentJson");
  });

  it("filters by status and by search words (apostrophes included)", async () => {
    expect((await call("list_posts", { status: "draft" })).json.items.map((p: Json) => p.id)).toEqual([postB]);
    expect((await call("list_posts", { status: "published" })).json.items.map((p: Json) => p.id)).toEqual([postA]);
    expect((await call("list_posts", { query: WORD_A })).json.items.map((p: Json) => p.id)).toEqual([postA]);
    expect((await call("list_posts", { query: "Sun'iy" })).json.items.map((p: Json) => p.id)).toEqual([postA]);
    expect((await call("list_posts", { query: TRASH_MARK })).json.items).toEqual([]);
  });

  it("paginates with page/limit, hasMore and nextPage", async () => {
    const p1 = await call("list_posts", { limit: 1, page: 1 });
    expect(p1.json).toMatchObject({ page: 1, limit: 1, total: 2, hasMore: true, nextPage: 2 });
    const p2 = await call("list_posts", { limit: 1, page: 2 });
    expect(p2.json).toMatchObject({ page: 2, hasMore: false, nextPage: null });
    expect(p1.json.items[0].id).not.toBe(p2.json.items[0].id);
  });
});

describe("get_post", () => {
  it("returns metadata, settings, tags, review, channel state, the updatedAt token and the content in both forms", async () => {
    const r = await call("get_post", { id: postA });
    expect(r.isError).toBe(false);
    const { post } = r.json;
    expect(post).toMatchObject({ id: postA, slug: "sun-iy-intellekt-agentlar", title: TITLE_A, status: "published", tags: [{ slug: "ai-agentlar" }] });
    expect(post.settings).toMatchObject({ commentsEnabled: true });
    expect(post.review).toMatchObject({ note: null });
    expect(post.channel).toHaveProperty("plan");
    expect(post.channel).toHaveProperty("telegram");
    const [row] = await db.select().from(schema.posts).where(eq(schema.posts.id, postA));
    expect(post.updatedAt).toBe(row!.updatedAt.toISOString());

    expect(r.json.contentFormat).toBe("plain_text+tiptap_json");
    expect(r.json.contentNote).toMatch(/NOT Markdown/);
    expect(r.json.content).toBe(`## Kirish\n\nBu maqola ${WORD_A} haqida. G'oya, o'zgarish, ma'no.\n\n- Birinchi band\n- Ikkinchi band\n\nconst x = 1;`);
    expect(r.json.document).toEqual(docA);
  });

  it("finds a post by slug and can return text or document only", async () => {
    const bySlug = await call("get_post", { slug: "qoralama-post", include: "text" });
    expect(bySlug.json.post.id).toBe(postB);
    expect(bySlug.json.content).toBe("Hali tugallanmagan matn");
    expect(bySlug.json).not.toHaveProperty("document");
    const docOnly = await call("get_post", { id: postB, include: "document" });
    expect(docOnly.json).not.toHaveProperty("content");
    expect(docOnly.json.document.type).toBe("doc");
  });

  it("answers not_found with a hint for unknown, trashed and slug-less requests", async () => {
    const unknown = await call("get_post", { id: "00000000-0000-0000-0000-000000000000" });
    expect(unknown.isError).toBe(true);
    expect(unknown.json.error).toMatchObject({ code: "not_found" });
    expect(unknown.json.error.hint).toMatch(/list_posts/);
    expect((await call("get_post", { id: postTrashed })).json.error.code).toBe("not_found");
    expect((await call("get_post", { slug: "chiqindi-post" })).json.error.code).toBe("not_found");
    const none = await call("get_post", {});
    expect(none.json.error.code).toBe("invalid_request");
  });
});

describe("list_tags / list_comments", () => {
  it("lists tags with published post counts", async () => {
    const r = await call("list_tags");
    expect(r.json.items).toEqual([expect.objectContaining({ slug: "ai-agentlar", name: "AI agentlar", postsCount: 1 })]);
  });

  it("lists pending comments by default (never those of trashed posts), with counts and compact items", async () => {
    const r = await call("list_comments");
    expect(r.json.items).toHaveLength(1);
    expect(r.json.items[0]).toMatchObject({ postId: postA, postTitle: TITLE_A, authorName: "Mehmon", status: "pending", body: BODY_COMMENT });
    expect(r.json.items[0]).not.toHaveProperty("bodyHtml");
    expect(r.json.items[0]).not.toHaveProperty("ipHashShort");
    expect(r.json.counts).toMatchObject({ pending: 1, visible: 1, all: 2 });
    const all = await call("list_comments", { status: "all" });
    expect(all.json.items.map((c: Json) => c.authorName).sort()).toEqual(["Dilnoza", "Mehmon"]);
    expect((await call("list_comments", { query: "foydali" })).json.items).toHaveLength(1);
    expect((await call("list_comments", { query: "Ajoyib" })).json.items).toHaveLength(0);
    expect((await call("list_comments", { status: "all", query: "Ajoyib" })).json.items).toHaveLength(1);
    expect((await call("list_comments", { from: "2030-01-02", to: "2030-01-01" })).json.error.code).toBe("invalid_request");
  });
});

describe("statistics", () => {
  it("returns site-wide and per-post statistics", async () => {
    const site = await call("get_site_stats", { range: "7d" });
    expect(site.json).toMatchObject({ range: "7d", pendingComments: 1 });
    expect(site.json.totals).toMatchObject({ views: 11, publishedPosts: 1 });
    expect(site.json.topPosts.map((p: Json) => p.slug)).toEqual(["sun-iy-intellekt-agentlar"]);

    const post = await call("get_post_stats", { slug: "sun-iy-intellekt-agentlar", range: "30d" });
    expect(post.json.post).toMatchObject({ id: postA, title: TITLE_A });
    expect(post.json.allTime.views).toBe(11);
    expect((await call("get_post_stats", { id: postTrashed })).json.error.code).toBe("not_found");
  });
});

describe("revisions", () => {
  it("lists a post's revisions and reads one with its content", async () => {
    const list = await call("list_post_revisions", { id: postA });
    expect(list.json.items.length).toBeGreaterThanOrEqual(2);
    expect(list.json.items[0]).toMatchObject({ via: "web" });
    expect(list.json.items[0]).not.toHaveProperty("contentJson");

    const rev = await call("get_post_revision", { id: postA, revision_id: list.json.items[0].id });
    expect(rev.isError).toBe(false);
    expect(rev.json.revision.title).toBeTruthy();
    expect(rev.json.content).toContain("Kirish");
    expect(rev.json.document.type).toBe("doc");

    const missing = await call("get_post_revision", { id: postA, revision_id: "00000000-0000-0000-0000-000000000000" });
    expect(missing.json.error).toMatchObject({ code: "not_found" });
    expect(missing.json.error.hint).toMatch(/list_post_revisions/);
    expect((await call("list_post_revisions", { id: postTrashed })).json.error.code).toBe("not_found");
  });
});

describe("list_trash, list_media, list_audit_log", () => {
  it("lists trashed posts (and only here)", async () => {
    const r = await call("list_trash");
    expect(r.json.total).toBe(1);
    expect(r.json.items[0]).toMatchObject({ id: postTrashed, slug: "chiqindi-post" });
    expect(r.json.items[0].deletedBy).toMatchObject({ id: admin.id });
  });

  it("lists media without internal storage keys", async () => {
    const r = await call("list_media");
    expect(r.json.items).toEqual([expect.objectContaining({ url: "/uploads/1.webp", mime: "image/webp", size: 1234, width: 800, height: 600, alt: "Rasm tavsifi" })]);
    expect(r.json.items[0]).not.toHaveProperty("key");
  });

  it("lists audit entries with filters; MCP reads show up as via=mcp", async () => {
    const web = await call("list_audit_log", { via: "web", action: "post.publish" });
    expect(web.json.items.length).toBeGreaterThanOrEqual(2);
    expect(web.json.items.every((i: Json) => i.via === "web" && i.action === "post.publish")).toBe(true);

    const mcp = await call("list_audit_log", { via: "mcp", entity_type: "mcp" });
    expect(mcp.json.items.some((i: Json) => i.action === "mcp.read" && i.via === "mcp")).toBe(true);
    expect((await call("list_audit_log", { from: "not-a-date" })).json.error.code).toBe("invalid_request");
    expect((await call("list_audit_log", { limit: 2 })).json).toMatchObject({ limit: 2, hasMore: true, nextPage: 2 });
  });
});

describe("trashed posts never leak", () => {
  it("does not appear in any tool except list_trash (and the audit trail of its own deletion)", async () => {
    const outputs: string[] = [];
    const revisions = await call("list_post_revisions", { id: postA });
    for (const [name, args] of [
      ["whoami", {}],
      ["list_posts", { status: "all", limit: 50 }],
      ["list_posts", { query: TRASH_MARK }],
      ["list_tags", {}],
      ["list_comments", { status: "all", limit: 50 }],
      ["get_site_stats", { range: "all" }],
      ["list_media", {}],
      ["list_post_revisions", { id: postA }],
      ["get_post_revision", { id: postA, revision_id: revisions.json.items[0].id }],
      ["get_post", { id: postA }],
    ] as Array<[string, Record<string, unknown>]>) {
      outputs.push((await call(name, args)).text);
    }
    expect(outputs.join("\n")).not.toContain(TRASH_MARK);
    expect((await call("list_trash")).text).toContain(TRASH_MARK);
  });
});

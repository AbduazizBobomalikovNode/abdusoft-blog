import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { AuditListResponseSchema, type AuditLogItem } from "@blog/shared";
import { migrateTestDb } from "../test/migrate-test-db.js";
import { createTestUser, type TestUser } from "../test/auth-test-helpers.js";

// `app` faqat migratsiyadan KEYIN dinamik import qilinadi (admin-roles.test.ts'dagi izohga qarang).
let app: Hono;
let db: typeof import("../db/index.js").db;
let schema: typeof import("../db/schema.js");

let admin: TestUser;
let staff: TestUser;

async function req(path: string, cookie: string | null, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(cookie ? { cookie } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
}
const get = (path: string, cookie: string | null) => req(path, cookie);
const post = (path: string, cookie: string | null, body?: unknown) =>
  req(path, cookie, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined });
const patch = (path: string, cookie: string | null, body: unknown) =>
  req(path, cookie, { method: "PATCH", body: JSON.stringify(body) });
const put = (path: string, cookie: string | null, body: unknown) =>
  req(path, cookie, { method: "PUT", body: JSON.stringify(body) });
const del = (path: string, cookie: string | null) => req(path, cookie, { method: "DELETE" });

async function createPost(cookie: string, title = "Audit sinov posti"): Promise<{ id: string; slug: string }> {
  const res = await post("/admin/posts", cookie, { title });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; slug: string };
}

async function auditRows(entityId: string) {
  return db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.entityId, entityId))
    .orderBy(schema.auditLog.createdAt, schema.auditLog.id);
}

async function auditList(query: string): Promise<{ items: AuditLogItem[]; total: number; hasMore: boolean }> {
  const res = await get(`/admin/audit?${query}`, admin.cookie);
  expect(res.status).toBe(200);
  const parsed = AuditListResponseSchema.parse(await res.json());
  return parsed;
}

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../app.js"));
  ({ db } = await import("../db/index.js"));
  schema = await import("../db/schema.js");
  admin = await createTestUser({ role: "admin", name: "Admin" });
  staff = await createTestUser({ role: "staff", name: "Xodim" });
});

describe("audit rows for post actions", () => {
  it("writes one row per mutation with the right actor, role and via", async () => {
    const created = await createPost(staff.cookie);
    expect((await patch(`/admin/posts/${created.id}`, staff.cookie, { title: "Yangi nom" })).status).toBe(200);
    expect((await post(`/admin/posts/${created.id}/submit`, staff.cookie)).status).toBe(200);
    expect((await post(`/admin/posts/${created.id}/request-changes`, admin.cookie, { note: "Tuzating" })).status).toBe(200);
    expect((await post(`/admin/posts/${created.id}/submit`, staff.cookie)).status).toBe(200);
    expect((await post(`/admin/posts/${created.id}/approve`, admin.cookie)).status).toBe(200);
    expect((await post(`/admin/posts/${created.id}/unpublish`, admin.cookie)).status).toBe(200);
    expect(
      (await post(`/admin/posts/${created.id}/schedule`, admin.cookie, { scheduledAt: new Date(Date.now() + 3_600_000).toISOString() })).status,
    ).toBe(200);
    expect((await post(`/admin/posts/${created.id}/publish`, admin.cookie)).status).toBe(200);
    expect((await post(`/admin/posts/${created.id}/archive`, admin.cookie)).status).toBe(200);

    const rows = await auditRows(created.id);
    expect(rows.map((row) => row.action)).toEqual([
      "post.create",
      "post.update",
      "post.submit",
      "post.request_changes",
      "post.submit",
      "post.approve",
      "post.unpublish",
      "post.schedule",
      "post.publish",
      "post.archive",
    ]);

    const byAction = (action: string) => rows.find((row) => row.action === action)!;
    expect(byAction("post.create")).toMatchObject({ actorUserId: staff.id, actorRole: "staff", via: "web", entityType: "post" });
    expect(byAction("post.request_changes")).toMatchObject({ actorUserId: admin.id, actorRole: "admin", via: "web" });
    expect(byAction("post.approve").meta).toMatchObject({ from: "in_review", to: "published" });
    expect(byAction("post.archive").meta).toMatchObject({ from: "published", to: "archived" });
    expect(byAction("post.update").meta).toMatchObject({ fields: ["title"] });
    for (const row of rows) {
      expect(row.summary.length).toBeGreaterThan(0);
      // To'liq kontent jurnalga tushmaydi.
      expect(JSON.stringify(row.meta)).not.toContain("contentJson\":{");
    }
  });

  it("records the hard delete (draft) with the post label even though the row is gone", async () => {
    const created = await createPost(admin.cookie, "O'chiriladigan");
    expect((await del(`/admin/posts/${created.id}`, admin.cookie)).status).toBe(200);
    const rows = await auditRows(created.id);
    expect(rows.map((row) => row.action)).toEqual(["post.create", "post.delete"]);
    expect(rows[1]?.summary).toContain("O'chiriladigan");
  });

  it("does not write an audit row for rejected requests", async () => {
    const created = await createPost(staff.cookie);
    expect((await post(`/admin/posts/${created.id}/publish`, staff.cookie)).status).toBe(403);
    expect((await patch(`/admin/posts/${created.id}`, staff.cookie, { pinned: true })).status).toBe(403);
    expect((await auditRows(created.id)).map((row) => row.action)).toEqual(["post.create"]);
  });

  it("coalesces an autosave burst into one row and keeps different actors apart", async () => {
    const created = await createPost(staff.cookie);
    for (let i = 0; i < 12; i++) {
      const res = await patch(`/admin/posts/${created.id}`, staff.cookie, {
        contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `Matn ${i}` }] }] },
      });
      expect(res.status).toBe(200);
    }
    let updates = (await auditRows(created.id)).filter((row) => row.action === "post.update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.meta).toMatchObject({ fields: ["contentJson"], count: 12 });

    // Admin shu postni tahrirlasa — alohida yozuv.
    expect((await patch(`/admin/posts/${created.id}`, admin.cookie, { title: "Admin tahriri" })).status).toBe(200);
    updates = (await auditRows(created.id)).filter((row) => row.action === "post.update");
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({ actorUserId: admin.id });
  });
});

describe("audit rows for other admin mutations", () => {
  it("tags: create / update / delete", async () => {
    const created = await post("/admin/tags", admin.cookie, { name: "Audit teg" });
    expect(created.status).toBe(201);
    const tag = (await created.json()) as { id: string };
    expect((await patch(`/admin/tags/${tag.id}`, admin.cookie, { name: "Audit teg 2" })).status).toBe(200);
    expect((await del(`/admin/tags/${tag.id}`, admin.cookie)).status).toBe(200);
    expect((await auditRows(tag.id)).map((row) => row.action)).toEqual(["tag.create", "tag.update", "tag.delete"]);
  });

  it("comments: status, delete, ban removal", async () => {
    const created = await createPost(admin.cookie);
    const [comment] = await db
      .insert(schema.comments)
      .values({ postId: created.id, path: "0001", authorName: "Mehmon", body: "Salom", bodyHtml: "<p>Salom</p>" })
      .returning();
    expect((await patch(`/admin/comments/${comment!.id}`, admin.cookie, { status: "hidden" })).status).toBe(200);
    expect((await del(`/admin/comments/${comment!.id}`, admin.cookie)).status).toBe(200);
    expect((await auditRows(comment!.id)).map((row) => row.action)).toEqual(["comment.status", "comment.delete"]);

    const [ban] = await db.insert(schema.bannedDevices).values({ deviceHash: "abc" }).returning();
    expect((await del(`/admin/bans/${ban!.id}`, admin.cookie)).status).toBe(200);
    expect((await auditRows(ban!.id)).map((row) => row.action)).toEqual(["ban.remove"]);
  });

  it("settings: only section names are recorded, never secret values", async () => {
    const secret = "tg-super-secret-token-value-123";
    const res = await put("/admin/settings", admin.cookie, {
      telegraph: { accessToken: secret },
      general: { siteName: "Audit sayti" },
    });
    expect(res.status).toBe(200);
    const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "settings.update"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.meta).toEqual({ sections: ["telegraph", "general"] });
    const dump = JSON.stringify(await db.select().from(schema.auditLog));
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain("Audit sayti");
  });

  it("channel choice clear is recorded", async () => {
    const created = await createPost(admin.cookie);
    expect((await del(`/admin/posts/${created.id}/channel/choice`, admin.cookie)).status).toBe(200);
    expect((await auditRows(created.id)).map((row) => row.action)).toContain("post.channel_choice_clear");
  });
});

describe("GET /admin/audit", () => {
  it("is admin only", async () => {
    expect((await get("/admin/audit", null)).status).toBe(401);
    expect((await get("/admin/audit", staff.cookie)).status).toBe(403);
    expect((await get("/admin/audit", admin.cookie)).status).toBe(200);
  });

  it("filters by entity, actor, via, action and date range; newest first", async () => {
    const created = await createPost(staff.cookie, "Filtr posti");
    await post(`/admin/posts/${created.id}/publish`, admin.cookie);

    const byEntity = await auditList(`entityType=post&entityId=${created.id}`);
    expect(byEntity.items.map((item) => item.action)).toEqual(["post.publish", "post.create"]);
    expect(byEntity.total).toBe(2);
    expect(byEntity.items[0]?.actor).toEqual({ id: admin.id, name: "Admin" });

    const byActor = await auditList(`entityId=${created.id}&actor=${staff.id}`);
    expect(byActor.items.map((item) => item.action)).toEqual(["post.create"]);

    const byAction = await auditList(`action=post.publish&entityId=${created.id}`);
    expect(byAction.total).toBe(1);

    expect((await auditList(`entityId=${created.id}&via=web`)).total).toBe(2);
    expect((await auditList(`entityId=${created.id}&via=mcp`)).total).toBe(0);

    const today = new Date().toISOString().slice(0, 10);
    expect((await auditList(`entityId=${created.id}&from=${today}&to=${today}`)).total).toBe(2);
    expect((await auditList(`entityId=${created.id}&to=2000-01-01`)).total).toBe(0);
    expect((await auditList(`entityId=${created.id}&from=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).total).toBe(0);
  });

  it("paginates like the other admin lists", async () => {
    const first = await auditList("limit=3&page=1");
    expect(first.items).toHaveLength(3);
    expect(first.hasMore).toBe(true);
    const second = await auditList("limit=3&page=2");
    expect(second.items.map((item) => item.id)).not.toEqual(first.items.map((item) => item.id));
  });

  it("rejects malformed query parameters", async () => {
    expect((await get("/admin/audit?via=carrier-pigeon", admin.cookie)).status).toBe(400);
    expect((await get("/admin/audit?from=not-a-date", admin.cookie)).status).toBe(400);
    expect((await get("/admin/audit?limit=0", admin.cookie)).status).toBe(400);
  });
});

describe("audit is written in the same transaction as the change", () => {
  it("rolls the post change back when the audit insert fails", async () => {
    const created = await createPost(admin.cookie);
    await db.execute(sql`ALTER TABLE audit_log ADD CONSTRAINT audit_force_fail CHECK (action <> 'post.publish') NOT VALID`);
    try {
      const res = await post(`/admin/posts/${created.id}/publish`, admin.cookie);
      expect(res.status).toBe(500);
    } finally {
      await db.execute(sql`ALTER TABLE audit_log DROP CONSTRAINT audit_force_fail`);
    }
    const [row] = await db.select().from(schema.posts).where(eq(schema.posts.id, created.id));
    expect(row?.status).toBe("draft");
    expect(row?.publishedAt).toBeNull();
  });
});

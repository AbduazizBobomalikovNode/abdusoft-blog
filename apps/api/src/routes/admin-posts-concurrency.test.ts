import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { PostConflictResponseSchema } from "@blog/shared";
import { migrateTestDb } from "../test/migrate-test-db.js";
import { createTestUser, type TestUser } from "../test/auth-test-helpers.js";

let app: Hono;
let db: typeof import("../db/index.js").db;
let schema: typeof import("../db/schema.js");
let svc: typeof import("../lib/posts/index.js");
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
const del = (path: string, cookie: string | null, body?: unknown) =>
  req(path, cookie, { method: "DELETE", body: body !== undefined ? JSON.stringify(body) : undefined });
async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function createDraft(cookie = admin.cookie, title = "Konkurensiya sinovi") {
  const res = await post("/admin/posts", cookie, { title });
  expect(res.status).toBe(201);
  return json<{ id: string; slug: string }>(res);
}
async function currentUpdatedAt(id: string, cookie = admin.cookie): Promise<string> {
  return (await json<{ updatedAt: string }>(await get(`/admin/posts/${id}`, cookie))).updatedAt;
}
async function row(id: string) {
  const [r] = await db.select().from(schema.posts).where(eq(schema.posts.id, id));
  return r!;
}
const STALE = "2001-01-01T00:00:00.000Z";

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../app.js"));
  ({ db } = await import("../db/index.js"));
  schema = await import("../db/schema.js");
  svc = await import("../lib/posts/index.js");
  admin = await createTestUser({ role: "admin", name: "Admin" });
  staff = await createTestUser({ role: "staff", name: "Xodim" });
});

describe("PATCH /admin/posts/:id without expectedUpdatedAt behaves exactly as before", () => {
  it("last write wins, response is just { updatedAt }", async () => {
    const { id } = await createDraft();
    const first = await patch(`/admin/posts/${id}`, admin.cookie, { title: "Birinchi" });
    expect(first.status).toBe(200);
    expect(Object.keys((await first.json()) as object)).toEqual(["updatedAt"]);
    expect((await patch(`/admin/posts/${id}`, admin.cookie, { title: "Ikkinchi" })).status).toBe(200);
    expect((await row(id)).title).toBe("Ikkinchi");
  });
});

describe("PATCH with expectedUpdatedAt", () => {
  it("succeeds repeatedly when the client echoes the value it last received (no false conflicts)", async () => {
    const { id } = await createDraft();
    let token = await currentUpdatedAt(id);
    for (let i = 0; i < 15; i++) {
      const res = await patch(`/admin/posts/${id}`, admin.cookie, { title: `Tahrir ${i}`, expectedUpdatedAt: token });
      expect(res.status).toBe(200);
      token = (await json<{ updatedAt: string }>(res)).updatedAt;
    }
    expect((await row(id)).title).toBe("Tahrir 14");
  });

  it("returns 409 with the current updatedAt, who changed it and via what — and changes nothing", async () => {
    const { id } = await createDraft();
    const stale = await currentUpdatedAt(id);
    // Boshqa kanal (mcp) postni o'zgartiradi.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await svc.updatePost(svc.actorFromAdminUser({ id: admin.id, role: "admin" }, "mcp"), id, { title: "Yordamchi yozdi" });
    const revisionsBefore = await db.select().from(schema.postRevisions).where(eq(schema.postRevisions.postId, id));
    const auditBefore = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, id));

    const res = await patch(`/admin/posts/${id}`, admin.cookie, { title: "Inson yozdi", expectedUpdatedAt: stale });
    expect(res.status).toBe(409);
    const body = PostConflictResponseSchema.parse(await res.json());
    expect(body.error.length).toBeGreaterThan(0);
    expect(body.updatedAt).toBe(await currentUpdatedAt(id));
    expect(body.updatedAt).not.toBe(stale);
    expect(body.updatedBy).toEqual({ id: admin.id, name: "Admin" });
    expect(body.via).toBe("mcp");

    expect((await row(id)).title).toBe("Yordamchi yozdi");
    expect(await db.select().from(schema.postRevisions).where(eq(schema.postRevisions.postId, id))).toHaveLength(revisionsBefore.length);
    expect(await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, id))).toHaveLength(auditBefore.length);
  });

  it("two concurrent writers with the same token: exactly one wins", async () => {
    const { id } = await createDraft();
    const token = await currentUpdatedAt(id);
    const [a, b] = await Promise.all([
      patch(`/admin/posts/${id}`, admin.cookie, { title: "A", expectedUpdatedAt: token }),
      patch(`/admin/posts/${id}`, admin.cookie, { title: "B", expectedUpdatedAt: token }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it("is accepted for staff (it is a parameter, not an editable field) and rejects garbage with 400", async () => {
    const { id } = await createDraft(staff.cookie);
    const token = await currentUpdatedAt(id, staff.cookie);
    expect((await patch(`/admin/posts/${id}`, staff.cookie, { title: "Xodim", expectedUpdatedAt: token })).status).toBe(200);
    expect((await patch(`/admin/posts/${id}`, staff.cookie, { title: "Xodim 2", expectedUpdatedAt: STALE })).status).toBe(409);
    expect((await patch(`/admin/posts/${id}`, staff.cookie, { title: "x", expectedUpdatedAt: "kecha" })).status).toBe(400);
  });

  it("staff still cannot learn about posts they may not touch (403 before 409)", async () => {
    const { id } = await createDraft(admin.cookie);
    const res = await patch(`/admin/posts/${id}`, staff.cookie, { title: "x", expectedUpdatedAt: STALE });
    expect(res.status).toBe(403);
  });
});

describe("timestamp round trip is lossless (PGlite)", () => {
  // Postgres `timestamptz` — mikrosekund; JS `Date` — millisekund. Mijoz GET qilgan qiymatni aynan qaytarsa, hech qachon soxta konflikt bo'lmasin.
  const microsecondValues = ["2026-03-01 12:00:00.123456+00", "2026-03-01 12:00:00.123999+00", "2026-03-01 12:00:00.000001+00", "2026-03-01 12:00:00.999999+00", "2026-03-01 12:00:00+00"];

  it.each(microsecondValues)("a row whose updated_at is %s", async (stored) => {
    const { id } = await createDraft();
    await db.execute(sql`update posts set updated_at = ${stored}::timestamptz where id = ${id}`);

    const echoed = await currentUpdatedAt(id);
    expect(echoed).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // 1) PATCH
    const patched = await patch(`/admin/posts/${id}`, admin.cookie, { title: "Mikro", expectedUpdatedAt: echoed });
    expect(patched.status).toBe(200);

    // 2) ro'yxatdan olingan qiymat bilan holat o'tishi
    await db.execute(sql`update posts set updated_at = ${stored}::timestamptz where id = ${id}`);
    const list = await json<{ items: { id: string; updatedAt: string }[] }>(await get("/admin/posts?limit=100", admin.cookie));
    const fromList = list.items.find((item) => item.id === id)!.updatedAt;
    expect(fromList).toBe(echoed);
    const published = await post(`/admin/posts/${id}/publish`, admin.cookie, { expectedUpdatedAt: fromList });
    expect(published.status).toBe(200);

    // 3) javobdagi updatedAt keyingi so'rov uchun to'g'ri token
    const summary = await json<{ updatedAt: string }>(published);
    const unpublished = await post(`/admin/posts/${id}/unpublish`, admin.cookie, { expectedUpdatedAt: summary.updatedAt });
    expect(unpublished.status).toBe(200);
  });

  it("an offset spelling of the same instant is not a conflict, a 1 ms difference is", async () => {
    const { id } = await createDraft();
    await db.execute(sql`update posts set updated_at = '2026-03-01 12:00:00.123456+00'::timestamptz where id = ${id}`);
    expect((await patch(`/admin/posts/${id}`, admin.cookie, { title: "Offset", expectedUpdatedAt: "2026-03-01T17:00:00.123+05:00" })).status).toBe(200);

    await db.execute(sql`update posts set updated_at = '2026-03-01 12:00:00.123456+00'::timestamptz where id = ${id}`);
    const off = await patch(`/admin/posts/${id}`, admin.cookie, { title: "Bir ms", expectedUpdatedAt: "2026-03-01T12:00:00.124Z" });
    expect(off.status).toBe(409);
  });

  it("a freshly created post round-trips immediately", async () => {
    const { id } = await createDraft();
    const token = await currentUpdatedAt(id);
    expect((await patch(`/admin/posts/${id}`, admin.cookie, { title: "Yangi", expectedUpdatedAt: token })).status).toBe(200);
  });
});

describe("state transitions accept expectedUpdatedAt", () => {
  it("publish / unpublish / archive / schedule: stale -> 409 and unchanged, fresh -> 200", async () => {
    const { id } = await createDraft();
    const cases: [string, unknown, string][] = [
      [`/admin/posts/${id}/publish`, {}, "published"],
      [`/admin/posts/${id}/unpublish`, {}, "draft"],
      [`/admin/posts/${id}/schedule`, { scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }, "scheduled"],
      [`/admin/posts/${id}/archive`, {}, "archived"],
    ];
    for (const [path, body, status] of cases) {
      const before = (await row(id)).status;
      const stale = await post(path, admin.cookie, { ...(body as object), expectedUpdatedAt: STALE });
      expect(stale.status).toBe(409);
      PostConflictResponseSchema.parse(await stale.json());
      expect((await row(id)).status).toBe(before);

      const fresh = await post(path, admin.cookie, { ...(body as object), expectedUpdatedAt: await currentUpdatedAt(id) });
      expect(fresh.status).toBe(200);
      expect((await row(id)).status).toBe(status);
    }
  });

  it("publish keeps working without a body and with sendToChannel-only bodies", async () => {
    const a = await createDraft();
    expect((await post(`/admin/posts/${a.id}/publish`, admin.cookie)).status).toBe(200);
    const b = await createDraft();
    expect((await post(`/admin/posts/${b.id}/publish`, admin.cookie, {})).status).toBe(200);
  });

  it("submit / request-changes / approve", async () => {
    const { id } = await createDraft(staff.cookie);
    expect((await post(`/admin/posts/${id}/submit`, staff.cookie, { expectedUpdatedAt: STALE })).status).toBe(409);
    expect((await row(id)).status).toBe("draft");
    expect((await post(`/admin/posts/${id}/submit`, staff.cookie, { expectedUpdatedAt: await currentUpdatedAt(id, staff.cookie) })).status).toBe(200);

    expect((await post(`/admin/posts/${id}/request-changes`, admin.cookie, { note: "x", expectedUpdatedAt: STALE })).status).toBe(409);
    expect((await row(id)).status).toBe("in_review");
    expect((await post(`/admin/posts/${id}/approve`, admin.cookie, { expectedUpdatedAt: STALE })).status).toBe(409);
    expect((await row(id)).status).toBe("in_review");
    expect((await post(`/admin/posts/${id}/approve`, admin.cookie, { expectedUpdatedAt: await currentUpdatedAt(id) })).status).toBe(200);
    expect((await row(id)).status).toBe("published");
  });

  it("trash / restore from trash / permanent delete (body or query)", async () => {
    const { id } = await createDraft();
    expect((await del(`/admin/posts/${id}`, admin.cookie, { expectedUpdatedAt: STALE })).status).toBe(409);
    expect((await row(id)).deletedAt).toBeNull();
    const token = await currentUpdatedAt(id);
    expect((await del(`/admin/posts/${id}?expectedUpdatedAt=${encodeURIComponent(STALE)}`, admin.cookie)).status).toBe(409);
    expect((await del(`/admin/posts/${id}`, admin.cookie, { expectedUpdatedAt: token })).status).toBe(200);

    expect((await post(`/admin/posts/trash/${id}/restore`, admin.cookie, { expectedUpdatedAt: STALE })).status).toBe(409);
    const trashed = await row(id);
    expect(trashed.deletedAt).not.toBeNull();
    const restored = await post(`/admin/posts/trash/${id}/restore`, admin.cookie, { expectedUpdatedAt: trashed.updatedAt.toISOString() });
    expect(restored.status).toBe(200);

    await del(`/admin/posts/${id}`, admin.cookie);
    expect((await del(`/admin/posts/trash/${id}`, admin.cookie, { expectedUpdatedAt: STALE })).status).toBe(409);
    expect(await db.select().from(schema.posts).where(eq(schema.posts.id, id))).toHaveLength(1);
    const latest = (await row(id)).updatedAt.toISOString();
    expect((await del(`/admin/posts/trash/${id}?expectedUpdatedAt=${encodeURIComponent(latest)}`, admin.cookie)).status).toBe(200);
  });

  it("restoring a revision honours expectedUpdatedAt", async () => {
    const { id } = await createDraft();
    await patch(`/admin/posts/${id}`, admin.cookie, { title: "Birinchi" });
    await post(`/admin/posts/${id}/publish`, admin.cookie);
    const revisions = await json<{ items: { id: string }[] }>(await get(`/admin/posts/${id}/revisions`, admin.cookie));
    const rid = revisions.items[0]!.id;
    expect((await post(`/admin/posts/${id}/revisions/${rid}/restore`, admin.cookie, { expectedUpdatedAt: STALE })).status).toBe(409);
    const ok = await post(`/admin/posts/${id}/revisions/${rid}/restore`, admin.cookie, { expectedUpdatedAt: await currentUpdatedAt(id) });
    expect(ok.status).toBe(200);
  });

  it("a malformed token is a 400 on every transition", async () => {
    const { id } = await createDraft();
    for (const path of ["publish", "unpublish", "archive"]) {
      expect((await post(`/admin/posts/${id}/${path}`, admin.cookie, { expectedUpdatedAt: "kecha" })).status).toBe(400);
    }
    expect((await del(`/admin/posts/${id}?expectedUpdatedAt=kecha`, admin.cookie)).status).toBe(400);
  });
});

describe("fields the admin UI relies on for the conflict token and the 'changed by' line", () => {
  it("submit returns the new updatedAt, usable as the next expectedUpdatedAt", async () => {
    const { id } = await createDraft(staff.cookie);
    const submitted = await json<{ status: string; updatedAt?: string }>(await post(`/admin/posts/${id}/submit`, staff.cookie));
    expect(submitted.status).toBe("in_review");
    expect(submitted.updatedAt).toBe(await currentUpdatedAt(id, staff.cookie));
    const approved = await post(`/admin/posts/${id}/approve`, admin.cookie, { expectedUpdatedAt: submitted.updatedAt });
    expect(approved.status).toBe(200);
  });

  it("the post detail exposes updatedVia (null for rows that never recorded it)", async () => {
    const { id } = await createDraft();
    await patch(`/admin/posts/${id}`, admin.cookie, { title: "Veb orqali" });
    expect((await json<{ updatedVia: string | null }>(await get(`/admin/posts/${id}`, admin.cookie))).updatedVia).toBe("web");
    await db.update(schema.posts).set({ updatedVia: null }).where(eq(schema.posts.id, id));
    expect((await json<{ updatedVia: string | null }>(await get(`/admin/posts/${id}`, admin.cookie))).updatedVia).toBeNull();
  });
});

describe("PATCH overwrite flag (used by the editor's 'overwrite with mine')", () => {
  const revisions = async (id: string) =>
    db.select().from(schema.postRevisions).where(eq(schema.postRevisions.postId, id)).orderBy(schema.postRevisions.seq);

  it("takes a snapshot of the current state with reason 'overwrite' even for the same actor inside the snapshot window", async () => {
    const { id } = await createDraft();
    expect((await patch(`/admin/posts/${id}`, admin.cookie, { title: "Bir" })).status).toBe(200);
    const afterFirst = (await revisions(id)).length;
    expect((await patch(`/admin/posts/${id}`, admin.cookie, { title: "Ikki" })).status).toBe(200);
    expect((await revisions(id)).length).toBe(afterFirst); // oddiy tahrir — bir oynada birlashadi

    expect((await patch(`/admin/posts/${id}`, admin.cookie, { title: "Uch", overwrite: true })).status).toBe(200);
    const all = await revisions(id);
    expect(all.length).toBe(afterFirst + 1);
    expect(all.at(-1)).toMatchObject({ title: "Ikki", reason: "overwrite" });
  });

  it("is rate limited: repeated overwrite requests do not flush history (at most one forced snapshot per actor per window)", async () => {
    const { id } = await createDraft();
    await patch(`/admin/posts/${id}`, admin.cookie, { title: "A" });
    for (let i = 0; i < 6; i++) {
      expect((await patch(`/admin/posts/${id}`, admin.cookie, { title: `B${i}`, overwrite: true })).status).toBe(200);
    }
    const forced = (await revisions(id)).filter((r) => r.reason === "overwrite");
    expect(forced).toHaveLength(1);
  });

  it("is ignored when expectedUpdatedAt is sent (that is a normal checked save, not an overwrite)", async () => {
    const { id } = await createDraft();
    await patch(`/admin/posts/${id}`, admin.cookie, { title: "A" });
    const before = (await revisions(id)).length;
    const token = await currentUpdatedAt(id);
    expect((await patch(`/admin/posts/${id}`, admin.cookie, { title: "B", overwrite: true, expectedUpdatedAt: token })).status).toBe(200);
    expect((await revisions(id)).length).toBe(before);
  });

  it("is not an editable field: staff may send it on their own draft, and it never reaches the audit fields", async () => {
    const mine = await createDraft(staff.cookie);
    expect((await patch(`/admin/posts/${mine.id}`, staff.cookie, { title: "Xodim", overwrite: true })).status).toBe(200);
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, mine.id));
    expect(JSON.stringify(audit.map((row) => row.meta))).not.toContain("overwrite");
  });
});

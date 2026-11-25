import { beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { PostRevisionListResponseSchema, PostRevisionSchema } from "@blog/shared";
import { migrateTestDb } from "../test/migrate-test-db.js";
import { createTestUser, type TestUser } from "../test/auth-test-helpers.js";

let app: Hono;
let admin: TestUser;
let staff: TestUser;
let otherStaff: TestUser;

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

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

async function createPost(cookie: string): Promise<{ id: string; slug: string }> {
  const res = await post("/admin/posts", cookie, { title: "Tarix posti" });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; slug: string };
}

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../app.js"));
  admin = await createTestUser({ role: "admin", name: "Admin" });
  staff = await createTestUser({ role: "staff", name: "Xodim" });
  otherStaff = await createTestUser({ role: "staff", name: "Boshqa xodim" });
});

describe("revision endpoints", () => {
  it("lists revisions without content, returns one with content, and restores it", async () => {
    const created = await createPost(admin.cookie);
    expect((await patch(`/admin/posts/${created.id}`, admin.cookie, { contentJson: doc("Birinchi variant"), title: "V1" })).status).toBe(200);
    // Boshqa aktyor (xodim emas — admin) bir xil kanal: birlashadi; shu sabab publish orqali ikkinchi surat.
    expect((await post(`/admin/posts/${created.id}/publish`, admin.cookie)).status).toBe(200);
    expect((await patch(`/admin/posts/${created.id}`, admin.cookie, { contentJson: doc("Ikkinchi variant"), title: "V2" })).status).toBe(200);

    const listRes = await get(`/admin/posts/${created.id}/revisions`, admin.cookie);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { items: Record<string, unknown>[] };
    const list = PostRevisionListResponseSchema.parse(listBody);
    expect(list.items.map((item) => item.reason)).toEqual(["publish", "update"]);
    for (const item of listBody.items) expect(item).not.toHaveProperty("contentJson");
    expect(list.items[0]?.createdBy).toEqual({ id: admin.id, name: "Admin" });

    const detailRes = await get(`/admin/posts/${created.id}/revisions/${list.items[0]!.id}`, admin.cookie);
    expect(detailRes.status).toBe(200);
    const detail = PostRevisionSchema.parse(await detailRes.json());
    expect(JSON.stringify(detail.contentJson)).toContain("Birinchi variant");
    expect(detail.title).toBe("V1");

    const restoreRes = await post(`/admin/posts/${created.id}/revisions/${list.items[0]!.id}/restore`, admin.cookie);
    expect(restoreRes.status).toBe(200);
    expect(typeof ((await restoreRes.json()) as { updatedAt: string }).updatedAt).toBe("string");

    const current = (await (await get(`/admin/posts/${created.id}`, admin.cookie)).json()) as { title: string; status: string };
    expect(current).toMatchObject({ title: "V1", status: "published" });
    const after = (await (await get(`/admin/posts/${created.id}/revisions`, admin.cookie)).json()) as { items: { reason: string }[] };
    expect(after.items[0]?.reason).toBe("restore-revision");
  });

  it("restore keeps a published post's slug unless restoreSlug is true", async () => {
    const created = await createPost(admin.cookie);
    await patch(`/admin/posts/${created.id}`, admin.cookie, { slug: "http-eski-slug" });
    await post(`/admin/posts/${created.id}/publish`, admin.cookie);
    await patch(`/admin/posts/${created.id}`, admin.cookie, { slug: "http-yangi-slug" });
    const list = (await (await get(`/admin/posts/${created.id}/revisions`, admin.cookie)).json()) as { items: { id: string; slug: string }[] };
    const old = list.items.find((item) => item.slug === "http-eski-slug")!;

    const kept = await post(`/admin/posts/${created.id}/revisions/${old.id}/restore`, admin.cookie);
    expect(kept.status).toBe(200);
    expect(await kept.json()).toMatchObject({ slug: "http-yangi-slug", slugRestored: false });

    const restored = await post(`/admin/posts/${created.id}/revisions/${old.id}/restore`, admin.cookie, { restoreSlug: true });
    expect(await restored.json()).toMatchObject({ slug: "http-eski-slug", slugRestored: true });
    expect((await post(`/admin/posts/${created.id}/revisions/${old.id}/restore`, admin.cookie, { restoreSlug: "ha" })).status).toBe(400);
  });

  it("returns 404 for malformed or unknown ids", async () => {
    const created = await createPost(admin.cookie);
    expect((await get("/admin/posts/not-a-uuid/revisions", admin.cookie)).status).toBe(404);
    expect((await get(`/admin/posts/${created.id}/revisions/not-a-uuid`, admin.cookie)).status).toBe(404);
    expect((await get(`/admin/posts/${created.id}/revisions/00000000-0000-4000-8000-000000000000`, admin.cookie)).status).toBe(404);
    expect((await post(`/admin/posts/${created.id}/revisions/00000000-0000-4000-8000-000000000000/restore`, admin.cookie)).status).toBe(404);
    expect((await get("/admin/posts/00000000-0000-4000-8000-000000000000/revisions", admin.cookie)).status).toBe(404);
  });

  it("requires a session and applies staff ownership", async () => {
    const created = await createPost(staff.cookie);
    await patch(`/admin/posts/${created.id}`, staff.cookie, { title: "Xodim V1" });
    await patch(`/admin/posts/${created.id}`, admin.cookie, { title: "Admin V2" });
    const rows = (await (await get(`/admin/posts/${created.id}/revisions`, staff.cookie)).json()) as { items: { id: string }[] };
    expect(rows.items.length).toBeGreaterThan(0);
    const rid = rows.items[0]!.id;

    expect((await get(`/admin/posts/${created.id}/revisions`, null)).status).toBe(401);
    expect((await get(`/admin/posts/${created.id}/revisions`, otherStaff.cookie)).status).toBe(403);
    expect((await get(`/admin/posts/${created.id}/revisions/${rid}`, otherStaff.cookie)).status).toBe(403);
    expect((await post(`/admin/posts/${created.id}/revisions/${rid}/restore`, otherStaff.cookie)).status).toBe(403);
    expect((await post(`/admin/posts/${created.id}/revisions/${rid}/restore`, staff.cookie)).status).toBe(200);
  });
});

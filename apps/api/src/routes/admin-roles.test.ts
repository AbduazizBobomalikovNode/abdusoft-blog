import { beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../test/migrate-test-db.js";
import { createTestUser, type TestUser } from "../test/auth-test-helpers.js";

// MUHIM: `../app.js` import qilinganda `lib/auth.ts` MODUL YUKLASH vaqtida
// (top-level await) DB'dan sozlamalarni o'qiydi — bu migratsiyadan OLDIN
// bo'lib qolmasligi uchun `app` faqat `migrateTestDb()`dan KEYIN, dinamik
// import bilan yuklanadi.
let app: Hono;

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

function getJson(path: string, cookie: string | null) {
  return req(path, cookie);
}
function postJson(path: string, cookie: string | null, body?: unknown) {
  return req(path, cookie, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined });
}
function patchJson(path: string, cookie: string | null, body: unknown) {
  return req(path, cookie, { method: "PATCH", body: JSON.stringify(body) });
}
function del(path: string, cookie: string | null) {
  return req(path, cookie, { method: "DELETE" });
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function createDraftAs(cookie: string): Promise<{ id: string; slug: string }> {
  const res = await postJson("/admin/posts", cookie, { title: "Test post" });
  expect(res.status).toBe(201);
  return json<{ id: string; slug: string }>(res);
}

let admin: TestUser;
let staffA: TestUser;
let staffB: TestUser;
let plainUser: TestUser;

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../app.js"));
  admin = await createTestUser({ role: "admin", name: "Admin" });
  staffA = await createTestUser({ role: "staff", name: "Xodim A" });
  staffB = await createTestUser({ role: "staff", name: "Xodim B" });
  plainUser = await createTestUser({ role: "user", name: "Oddiy foydalanuvchi" });
});

describe("GET /admin/me", () => {
  it("admin and staff pass, plain user and anonymous do not", async () => {
    expect((await getJson("/admin/me", admin.cookie)).status).toBe(200);
    expect((await getJson("/admin/me", staffA.cookie)).status).toBe(200);
    expect((await getJson("/admin/me", plainUser.cookie)).status).toBe(403);
    expect((await getJson("/admin/me", null)).status).toBe(401);
  });
});

describe("role guard matrix — staff gets 403 on admin-only routes", () => {
  it.each([
    ["GET", "/admin/comments"],
    ["GET", "/admin/bans"],
    ["GET", "/admin/stats/overview"],
    ["GET", "/admin/stats/summary"],
    ["GET", "/admin/site"],
    ["GET", "/admin/settings"],
    ["GET", "/admin/telegram/status"],
    ["GET", "/admin/staff"],
    ["POST", "/admin/tags"],
  ] as const)("%s %s -> 403 for staff", async (method, path) => {
    const res = await req(path, staffA.cookie, { method, body: method === "POST" ? JSON.stringify({ name: "x" }) : undefined });
    expect(res.status).toBe(403);
  });

  it("staff cannot create/update/delete tags, only list them", async () => {
    expect((await getJson("/admin/tags", staffA.cookie)).status).toBe(200);
    expect((await postJson("/admin/tags", staffA.cookie, { name: "Yangi teg" })).status).toBe(403);
  });

  it("staff cannot publish/unpublish/archive/schedule/delete or approve/request-changes a post", async () => {
    const post = await createDraftAs(staffA.cookie);
    expect((await postJson(`/admin/posts/${post.id}/publish`, staffA.cookie)).status).toBe(403);
    expect((await postJson(`/admin/posts/${post.id}/unpublish`, staffA.cookie)).status).toBe(403);
    expect((await postJson(`/admin/posts/${post.id}/archive`, staffA.cookie)).status).toBe(403);
    expect((await postJson(`/admin/posts/${post.id}/schedule`, staffA.cookie, { scheduledAt: new Date().toISOString() })).status).toBe(403);
    expect((await postJson(`/admin/posts/${post.id}/approve`, staffA.cookie)).status).toBe(403);
    expect((await postJson(`/admin/posts/${post.id}/request-changes`, staffA.cookie, { note: "x" })).status).toBe(403);
    expect((await del(`/admin/posts/${post.id}`, staffA.cookie)).status).toBe(403);
  });

  it("plain 'user' role (GitHub sign-in alone) is blocked from every admin route staff can reach too", async () => {
    expect((await getJson("/admin/posts", plainUser.cookie)).status).toBe(403);
    expect((await getJson("/admin/media", plainUser.cookie)).status).toBe(403);
    expect((await getJson("/admin/tags", plainUser.cookie)).status).toBe(403);
  });
});

describe("staff post ownership — cannot touch another user's posts", () => {
  it("staff B cannot GET, preview, or PATCH staff A's post", async () => {
    const post = await createDraftAs(staffA.cookie);

    expect((await getJson(`/admin/posts/${post.id}`, staffB.cookie)).status).toBe(403);
    expect((await getJson(`/admin/posts/${post.id}/preview`, staffB.cookie)).status).toBe(403);
    expect((await patchJson(`/admin/posts/${post.id}`, staffB.cookie, { title: "Hack" })).status).toBe(403);
  });

  it("staff's post list only contains their own posts", async () => {
    const postA = await createDraftAs(staffA.cookie);
    await createDraftAs(staffB.cookie);

    const res = await getJson("/admin/posts?limit=100", staffA.cookie);
    expect(res.status).toBe(200);
    const body = await json<{ items: { id: string }[] }>(res);
    const ids: string[] = body.items.map((item) => item.id);
    expect(ids).toContain(postA.id);
    expect(ids.every((id) => id !== undefined)).toBe(true);

    const resB = await getJson("/admin/posts?limit=100", staffB.cookie);
    const bodyB = await json<{ items: { id: string }[] }>(resB);
    const idsB: string[] = bodyB.items.map((item) => item.id);
    expect(idsB).not.toContain(postA.id);
  });

  it("admin can see and edit any staff post (created_by/updated_by are stamped)", async () => {
    const post = await createDraftAs(staffA.cookie);
    const res = await getJson(`/admin/posts/${post.id}`, admin.cookie);
    expect(res.status).toBe(200);
    const body = await json<{ createdBy: { id: string } | null }>(res);
    expect(body.createdBy?.id).toBe(staffA.id);
  });
});

describe("staff cannot patch settings/pinned/scheduledAt (own-post field restriction)", () => {
  it("rejects a PATCH containing 'settings'", async () => {
    const post = await createDraftAs(staffA.cookie);
    const res = await patchJson(`/admin/posts/${post.id}`, staffA.cookie, { settings: { commentsEnabled: false } });
    expect(res.status).toBe(403);
  });

  it("rejects a PATCH containing 'pinned'", async () => {
    const post = await createDraftAs(staffA.cookie);
    const res = await patchJson(`/admin/posts/${post.id}`, staffA.cookie, { pinned: true });
    expect(res.status).toBe(403);
  });

  it("rejects a PATCH containing 'scheduledAt'", async () => {
    const post = await createDraftAs(staffA.cookie);
    const res = await patchJson(`/admin/posts/${post.id}`, staffA.cookie, { scheduledAt: new Date().toISOString() });
    expect(res.status).toBe(403);
  });

  it("allows a PATCH touching only the whitelisted fields", async () => {
    const post = await createDraftAs(staffA.cookie);
    const res = await patchJson(`/admin/posts/${post.id}`, staffA.cookie, {
      title: "Yangilangan sarlavha",
      excerpt: "qisqacha",
    });
    expect(res.status).toBe(200);
  });
});

describe("review workflow — submit / approve / request-changes", () => {
  it("staff cannot edit a post once it is in_review", async () => {
    const post = await createDraftAs(staffA.cookie);
    const submitRes = await postJson(`/admin/posts/${post.id}/submit`, staffA.cookie);
    expect(submitRes.status).toBe(200);
    const submitBody = await json<{ status: string }>(submitRes);
    expect(submitBody.status).toBe("in_review");

    const patchRes = await patchJson(`/admin/posts/${post.id}`, staffA.cookie, { title: "Yangi" });
    expect(patchRes.status).toBe(409);
  });

  it("staff B cannot submit staff A's post (ownership enforced on submit too)", async () => {
    const post = await createDraftAs(staffA.cookie);
    const res = await postJson(`/admin/posts/${post.id}/submit`, staffB.cookie);
    expect(res.status).toBe(403);
  });

  it("admin approving an in_review post publishes it via the existing publish path", async () => {
    const post = await createDraftAs(staffA.cookie);
    await postJson(`/admin/posts/${post.id}/submit`, staffA.cookie);

    const approveRes = await postJson(`/admin/posts/${post.id}/approve`, admin.cookie);
    expect(approveRes.status).toBe(200);
    const approveBody = await json<{ status: string }>(approveRes);
    expect(approveBody.status).toBe("published");

    // Idempotent — bosilgandan keyin yana bosilsa (allaqachon published) 409 qaytaradi, xato tashlamaydi.
    const secondApprove = await postJson(`/admin/posts/${post.id}/approve`, admin.cookie);
    expect(secondApprove.status).toBe(409);
  });

  it("admin requesting changes moves the post to changes_requested with a visible note, then staff can edit and resubmit", async () => {
    const post = await createDraftAs(staffA.cookie);
    await postJson(`/admin/posts/${post.id}/submit`, staffA.cookie);

    const requestRes = await postJson(`/admin/posts/${post.id}/request-changes`, admin.cookie, {
      note: "Sarlavhani qisqartiring",
    });
    expect(requestRes.status).toBe(200);
    const requestBody = await json<{ status: string }>(requestRes);
    expect(requestBody.status).toBe("changes_requested");

    const getRes = await getJson(`/admin/posts/${post.id}`, staffA.cookie);
    const getBody = await json<{ reviewNote: string | null; status: string }>(getRes);
    expect(getBody.reviewNote).toBe("Sarlavhani qisqartiring");
    expect(getBody.status).toBe("changes_requested");

    // Xodim endi tahrirlashi va qayta yuborishi mumkin.
    const patchRes = await patchJson(`/admin/posts/${post.id}`, staffA.cookie, { title: "Qisqa sarlavha" });
    expect(patchRes.status).toBe(200);

    const resubmitRes = await postJson(`/admin/posts/${post.id}/submit`, staffA.cookie);
    expect(resubmitRes.status).toBe(200);
    const resubmitBody = await json<{ status: string }>(resubmitRes);
    expect(resubmitBody.status).toBe("in_review");
  });
});

describe("admin's own direct publish flow is unchanged (no review needed)", () => {
  it("admin can publish their own post directly without submit/approve", async () => {
    const post = await createDraftAs(admin.cookie);
    const res = await postJson(`/admin/posts/${post.id}/publish`, admin.cookie);
    expect(res.status).toBe(200);
    const body = await json<{ status: string }>(res);
    expect(body.status).toBe("published");
  });
});

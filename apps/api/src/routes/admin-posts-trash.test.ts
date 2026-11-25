import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { TrashListResponseSchema } from "@blog/shared";
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
const get = (path: string, cookie: string | null = null) => req(path, cookie);
const post = (path: string, cookie: string | null, body?: unknown) =>
  req(path, cookie, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined });
const patch = (path: string, cookie: string | null, body: unknown) =>
  req(path, cookie, { method: "PATCH", body: JSON.stringify(body) });
const del = (path: string, cookie: string | null) => req(path, cookie, { method: "DELETE" });
async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
let counter = 0;

/** Chop etilgan, tegli, izohli, ko'rishli, reaksiyali to'liq post. */
async function createPublished(opts: { tag?: string; text?: string } = {}) {
  counter += 1;
  const res = await post("/admin/posts", admin.cookie, { title: `Chiqindi sinovi ${counter}` });
  const created = await json<{ id: string; slug: string }>(res);
  const uniqueWord = opts.text ?? `noyobsozlar${counter}x`;
  const patched = await patch(`/admin/posts/${created.id}`, admin.cookie, {
    slug: `trash-test-${counter}`,
    contentJson: doc(`Salom ${uniqueWord} dunyo`),
    ...(opts.tag ? { tagSlugs: [opts.tag] } : {}),
  });
  expect(patched.status).toBe(200);
  expect((await post(`/admin/posts/${created.id}/publish`, admin.cookie)).status).toBe(200);
  return { id: created.id, slug: `trash-test-${counter}`, word: uniqueWord };
}

async function row(id: string) {
  const [r] = await db.select().from(schema.posts).where(eq(schema.posts.id, id));
  return r!;
}

async function setDeleted(id: string, deleted: boolean) {
  await db.execute(sql`update posts set deleted_at = ${deleted ? sql`now()` : sql`null`} where id = ${id}`);
}

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../app.js"));
  ({ db } = await import("../db/index.js"));
  schema = await import("../db/schema.js");
  admin = await createTestUser({ role: "admin", name: "Admin" });
  staff = await createTestUser({ role: "staff", name: "Xodim" });
});

describe("DELETE /admin/posts/:id moves the post to the trash", () => {
  it("keeps the old preconditions and response, keeps the row and everything attached to it", async () => {
    const created = await json<{ id: string }>(await post("/admin/posts", admin.cookie, { title: "Savatga" }));
    await db.insert(schema.tags).values({ slug: "trash-tag", name: "Trash" }).onConflictDoNothing();
    await patch(`/admin/posts/${created.id}`, admin.cookie, { tagSlugs: ["trash-tag"] });
    await db.insert(schema.comments).values({ postId: created.id, path: "0001", authorName: "A", body: "x", bodyHtml: "<p>x</p>" });

    const res = await del(`/admin/posts/${created.id}`, admin.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const [row] = await db.select().from(schema.posts).where(eq(schema.posts.id, created.id));
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(row?.deletedBy).toBe(admin.id);
    expect(row?.status).toBe("draft");
    expect(await db.select().from(schema.postTags).where(eq(schema.postTags.postId, created.id))).toHaveLength(1);
    expect(await db.select().from(schema.comments).where(eq(schema.comments.postId, created.id))).toHaveLength(1);
  });

  it("is still rejected for published posts (409), staff (403), unknown (404) and already-trashed posts (404)", async () => {
    const published = await createPublished();
    const conflict = await del(`/admin/posts/${published.id}`, admin.cookie);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: "Chop etilgan postni o'chirish uchun avval uni qoralamaga qaytaring yoki arxivlang",
    });

    const draft = await json<{ id: string }>(await post("/admin/posts", staff.cookie, { title: "Xodim posti" }));
    expect((await del(`/admin/posts/${draft.id}`, staff.cookie)).status).toBe(403);
    expect((await del("/admin/posts/00000000-0000-4000-8000-000000000000", admin.cookie)).status).toBe(404);

    expect((await del(`/admin/posts/${draft.id}`, admin.cookie)).status).toBe(200);
    expect((await del(`/admin/posts/${draft.id}`, admin.cookie)).status).toBe(404);
  });

  it("an archived post can be trashed and comes back as archived", async () => {
    const published = await createPublished();
    expect((await post(`/admin/posts/${published.id}/archive`, admin.cookie)).status).toBe(200);
    expect((await del(`/admin/posts/${published.id}`, admin.cookie)).status).toBe(200);

    const restored = await post(`/admin/posts/trash/${published.id}/restore`, admin.cookie);
    expect(restored.status).toBe(200);
    expect(await json(restored)).toMatchObject({ id: published.id, status: "archived" });
    expect((await get(`/admin/posts/${published.id}`, admin.cookie)).status).toBe(200);
  });

  it("restore returns a draft as a draft and republishing works", async () => {
    const draft = await json<{ id: string }>(await post("/admin/posts", admin.cookie, { title: "Qaytadi" }));
    await del(`/admin/posts/${draft.id}`, admin.cookie);
    const restored = await json<{ status: string }>(await post(`/admin/posts/trash/${draft.id}/restore`, admin.cookie));
    expect(restored.status).toBe("draft");
    expect((await post(`/admin/posts/${draft.id}/publish`, admin.cookie)).status).toBe(200);
  });
});

describe("trash endpoints", () => {
  it("lists trashed posts for admins only, newest first, with who and when", async () => {
    const a = await json<{ id: string }>(await post("/admin/posts", admin.cookie, { title: "Birinchi savat" }));
    const b = await json<{ id: string }>(await post("/admin/posts", staff.cookie, { title: "Ikkinchi savat" }));
    await del(`/admin/posts/${a.id}`, admin.cookie);
    await del(`/admin/posts/${b.id}`, admin.cookie);

    expect((await get("/admin/posts/trash", null)).status).toBe(401);
    expect((await get("/admin/posts/trash", staff.cookie)).status).toBe(403);

    const res = await get("/admin/posts/trash?limit=2", admin.cookie);
    expect(res.status).toBe(200);
    const body = TrashListResponseSchema.parse(await res.json());
    expect(body.items.map((item) => item.id).slice(0, 2)).toEqual([b.id, a.id]);
    expect(body.items[0]?.deletedBy).toEqual({ id: admin.id, name: "Admin" });
    expect(body.items[0]?.createdBy).toEqual({ id: staff.id, name: "Xodim" });
    expect(Date.parse(body.items[0]!.deletedAt)).not.toBeNaN();
    expect(body.total).toBeGreaterThanOrEqual(2);
  });

  it("restore and permanent delete are admin-only and only work on trashed posts", async () => {
    const draft = await json<{ id: string }>(await post("/admin/posts", admin.cookie, { title: "Doimiy" }));
    // Jonli postni "doimiy o'chirish" mumkin emas.
    expect((await del(`/admin/posts/trash/${draft.id}`, admin.cookie)).status).toBe(404);
    expect((await post(`/admin/posts/trash/${draft.id}/restore`, admin.cookie)).status).toBe(404);

    await del(`/admin/posts/${draft.id}`, admin.cookie);
    expect((await del(`/admin/posts/trash/${draft.id}`, staff.cookie)).status).toBe(403);
    expect((await post(`/admin/posts/trash/${draft.id}/restore`, staff.cookie)).status).toBe(403);
    expect((await del("/admin/posts/trash/not-a-uuid", admin.cookie)).status).toBe(404);

    expect((await del(`/admin/posts/trash/${draft.id}`, admin.cookie)).status).toBe(200);
    expect(await db.select().from(schema.posts).where(eq(schema.posts.id, draft.id))).toHaveLength(0);
  });

  it("permanent delete cascades to tags, comments, channel versions and revisions", async () => {
    const created = await json<{ id: string }>(await post("/admin/posts", admin.cookie, { title: "Cascade" }));
    await db.insert(schema.tags).values({ slug: "cascade-tag", name: "Cascade" }).onConflictDoNothing();
    await patch(`/admin/posts/${created.id}`, admin.cookie, { tagSlugs: ["cascade-tag"], title: "Cascade 2" });
    await db.insert(schema.comments).values({ postId: created.id, path: "0001", authorName: "A", body: "x", bodyHtml: "<p>x</p>" });
    await db
      .insert(schema.channelPostVersions)
      .values({ postId: created.id, name: "v", mode: "text", contentJson: doc("x"), textHtml: "x" });
    expect((await db.select().from(schema.postRevisions).where(eq(schema.postRevisions.postId, created.id))).length).toBeGreaterThan(0);

    await del(`/admin/posts/${created.id}`, admin.cookie);
    await del(`/admin/posts/trash/${created.id}`, admin.cookie);

    expect(await db.select().from(schema.postTags).where(eq(schema.postTags.postId, created.id))).toHaveLength(0);
    expect(await db.select().from(schema.comments).where(eq(schema.comments.postId, created.id))).toHaveLength(0);
    expect(await db.select().from(schema.channelPostVersions).where(eq(schema.channelPostVersions.postId, created.id))).toHaveLength(0);
    expect(await db.select().from(schema.postRevisions).where(eq(schema.postRevisions.postId, created.id))).toHaveLength(0);
    // Jurnal yozuvlari saqlanadi.
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, created.id));
    expect(audit.map((row) => row.action)).toContain("post.purge");
  });

  it("takes a revision snapshot before trashing", async () => {
    const created = await json<{ id: string }>(await post("/admin/posts", admin.cookie, { title: "Snapshot" }));
    await del(`/admin/posts/${created.id}`, admin.cookie);
    const rows = await db.select().from(schema.postRevisions).where(eq(schema.postRevisions.postId, created.id));
    expect(rows.map((row) => row.reason)).toEqual(["trash"]);
  });
});

describe("slug of a trashed post is freed", () => {
  async function trashedWithSlug(slug: string) {
    const created = await json<{ id: string }>(await post("/admin/posts", admin.cookie, { title: "Slug bo'shaydi" }));
    expect((await patch(`/admin/posts/${created.id}`, admin.cookie, { slug })).status).toBe(200);
    expect((await del(`/admin/posts/${created.id}`, admin.cookie)).status).toBe(200);
    return created.id;
  }

  it("a new post can take the slug right after trashing; the row moves to an internal slug and remembers the original", async () => {
    const id = await trashedWithSlug("bosh-slug");
    const [trashed] = await db.select().from(schema.posts).where(eq(schema.posts.id, id));
    expect(trashed?.slug).toBe(`_trash_${id}`);
    expect(trashed?.originalSlug).toBe("bosh-slug");

    const other = await json<{ id: string }>(await post("/admin/posts", admin.cookie, { title: "Yangi" }));
    expect((await patch(`/admin/posts/${other.id}`, admin.cookie, { slug: "bosh-slug" })).status).toBe(200);

    // Trash ro'yxati asl slug'ni ko'rsatadi, ichki slug'ni emas.
    const list = TrashListResponseSchema.parse(await (await get("/admin/posts/trash?limit=100", admin.cookie)).json());
    expect(list.items.find((i) => i.id === id)?.slug).toBe("bosh-slug");
    expect(JSON.stringify(list)).not.toContain("_trash_");
  });

  it("the revision snapshot taken at trash time keeps the original slug", async () => {
    const id = await trashedWithSlug("snapshot-slug");
    const rows = await db.select().from(schema.postRevisions).where(eq(schema.postRevisions.postId, id));
    expect(rows.find((r) => r.reason === "trash")?.slug).toBe("snapshot-slug");
  });

  it("the internal slug cannot be resolved publicly, cannot be chosen, and 'trash' is reserved", async () => {
    const id = await trashedWithSlug("ichki-slug");
    expect((await get(`/posts/_trash_${id}`)).status).toBe(404);
    expect((await get("/posts/ichki-slug")).status).toBe(404);
    const other = await json<{ id: string }>(await post("/admin/posts", admin.cookie, { title: "Boshqa" }));
    const reserved = await patch(`/admin/posts/${other.id}`, admin.cookie, { slug: "trash" });
    expect(reserved.status).toBe(400);
    // `slugify` "_" belgisini olib tashlaydi — ichki slug'ni tanlab bo'lmaydi.
    expect((await patch(`/admin/posts/${other.id}`, admin.cookie, { slug: `_trash_${id}` })).status).toBe(200);
    expect((await row(other.id)).slug).not.toBe(`_trash_${id}`);
  });

  it("restore gives the original slug back when it is still free", async () => {
    const id = await trashedWithSlug("qaytadigan-slug");
    const res = await post(`/admin/posts/trash/${id}/restore`, admin.cookie);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ slug: "qaytadigan-slug", slugRestored: true, originalSlug: "qaytadigan-slug" });
    expect((await row(id)).originalSlug).toBeNull();
  });

  it("restore uses a free variant when another post took the slug, and says so (response and audit)", async () => {
    const id = await trashedWithSlug("band-bolgan-slug");
    const other = await json<{ id: string }>(await post("/admin/posts", admin.cookie, { title: "Egallovchi" }));
    await patch(`/admin/posts/${other.id}`, admin.cookie, { slug: "band-bolgan-slug" });

    const res = await post(`/admin/posts/trash/${id}/restore`, admin.cookie);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ slug: "band-bolgan-slug-2", slugRestored: false, originalSlug: "band-bolgan-slug" });
    expect((await row(other.id)).slug).toBe("band-bolgan-slug");
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, id));
    const entry = audit.find((a) => a.action === "post.restore_trash");
    expect(entry?.meta).toMatchObject({ slugRestored: false, originalSlug: "band-bolgan-slug", slug: "band-bolgan-slug-2" });
    expect(entry?.summary).toContain("band-bolgan-slug-2");
  });

  it("permanent delete leaves the slug free and the audit keeps the original slug", async () => {
    const id = await trashedWithSlug("doimiy-slug");
    expect((await del(`/admin/posts/trash/${id}`, admin.cookie)).status).toBe(200);
    const other = await json<{ id: string }>(await post("/admin/posts", admin.cookie, { title: "X" }));
    expect((await patch(`/admin/posts/${other.id}`, admin.cookie, { slug: "doimiy-slug" })).status).toBe(200);
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, id));
    expect(audit.find((a) => a.action === "post.purge")?.meta).toMatchObject({ slug: "doimiy-slug" });
  });

  it("a genuinely taken slug still gets the unchanged error", async () => {
    const a = await json<{ id: string }>(await post("/admin/posts", admin.cookie, { title: "A" }));
    await patch(`/admin/posts/${a.id}`, admin.cookie, { slug: "haqiqiy-band" });
    const b = await json<{ id: string }>(await post("/admin/posts", admin.cookie, { title: "B" }));
    const res = await patch(`/admin/posts/${b.id}`, admin.cookie, { slug: "haqiqiy-band" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '"haqiqiy-band" slug allaqachon band' });
  });
});

describe("a trashed post is invisible everywhere", () => {
  it("public, admin, stats and comment reads all drop it (forced worst case: published AND trashed)", async () => {
    await db.insert(schema.tags).values({ slug: "kuzatuv", name: "Kuzatuv" }).onConflictDoNothing();
    const victim = await createPublished({ tag: "kuzatuv" });
    const sibling = await createPublished({ tag: "kuzatuv" });
    const [comment] = await db
      .insert(schema.comments)
      .values({ postId: victim.id, path: "0001", authorName: "Mehmon", body: "Izoh", bodyHtml: "<p>Izoh</p>", status: "pending" })
      .returning();
    await db.insert(schema.postViewsDaily).values({ postId: victim.id, day: new Date().toISOString().slice(0, 10), views: 7 });
    await db.insert(schema.reactions).values({ targetType: "post", targetId: victim.id, deviceHash: "dev-x", type: "like" });

    const readAll = async () => {
      const [list, byTag, search, feed, detail, stats, tagList, comments, reactionsMe, previewSibling] = await Promise.all([
        json<{ items: { slug: string }[]; total: number }>(await get("/posts?limit=50")),
        json<{ items: { slug: string }[] }>(await get("/posts?tag=kuzatuv&limit=50")),
        json<{ items: { slug: string }[] }>(await get(`/posts?q=${victim.word}`)),
        json<{ items: { slug: string }[] }>(await get("/posts/feed")),
        get(`/posts/${victim.slug}`),
        get(`/posts/${victim.slug}/stats`),
        json<{ slug: string; postsCount: number }[]>(await get("/tags")),
        get(`/posts/${victim.slug}/comments`),
        get(`/posts/${victim.slug}/reactions/me`),
        json<{ related: { slug: string }[]; adjacent: { prev: { slug: string } | null; next: { slug: string } | null } }>(
          await get(`/admin/posts/${sibling.id}/preview`, admin.cookie),
        ),
      ]);
      const adminList = await json<{ items: { id: string }[]; total: number; totals: { all: number; published: number } }>(
        await get("/admin/posts?limit=100", admin.cookie),
      );
      const adminSearch = await json<{ items: { id: string }[] }>(await get(`/admin/posts?q=${victim.word}`, admin.cookie));
      const adminPublished = await json<{ items: { id: string }[] }>(await get("/admin/posts?status=published&limit=100", admin.cookie));
      const adminComments = await json<{ items: { id: string }[]; counts: { all: number; pending: number } }>(
        await get("/admin/comments", admin.cookie),
      );
      const overview = await json<{
        totals: { views: number; likes: number; publishedPosts: number };
        topPosts: { slug: string }[];
        recentComments: { id: string }[];
        pendingComments: number;
      }>(await get("/admin/stats/overview?range=all", admin.cookie));
      const summary = await json<{ topPosts: { slug: string }[]; pendingComments: number }>(
        await get("/admin/stats/summary", admin.cookie),
      );
      const adminPostStats = await get(`/admin/stats/posts/${victim.id}`, admin.cookie);
      const reactionOnComment = await post(`/comments/${comment!.id}/reactions`, null, { type: "like" });
      return {
        listSlugs: list.items.map((i) => i.slug),
        listTotal: list.total,
        tagSlugs: byTag.items.map((i) => i.slug),
        searchSlugs: search.items.map((i) => i.slug),
        feedSlugs: feed.items.map((i) => i.slug),
        detailStatus: detail.status,
        statsStatus: stats.status,
        tagCount: tagList.find((t) => t.slug === "kuzatuv")?.postsCount ?? 0,
        commentsStatus: comments.status,
        reactionsStatus: reactionsMe.status,
        relatedSlugs: previewSibling.related.map((i) => i.slug),
        adjacent: [previewSibling.adjacent.prev?.slug, previewSibling.adjacent.next?.slug],
        adminIds: adminList.items.map((i) => i.id),
        adminTotal: adminList.total,
        adminTotals: adminList.totals,
        adminSearchIds: adminSearch.items.map((i) => i.id),
        adminPublishedIds: adminPublished.items.map((i) => i.id),
        adminCommentIds: adminComments.items.map((i) => i.id),
        adminCommentCounts: adminComments.counts,
        overview,
        summarySlugs: summary.topPosts.map((p) => p.slug),
        summaryPending: summary.pendingComments,
        adminPostStatsStatus: adminPostStats.status,
        commentItemStatus: reactionOnComment.status,
      };
    };

    // 1) Asos: post hamma yerda ko'rinadi (sinov ma'noli bo'lishi uchun).
    const before = await readAll();
    expect(before.listSlugs).toContain(victim.slug);
    expect(before.tagSlugs).toContain(victim.slug);
    expect(before.searchSlugs).toContain(victim.slug);
    expect(before.feedSlugs).toContain(victim.slug);
    expect(before.detailStatus).toBe(200);
    expect(before.statsStatus).toBe(200);
    expect(before.commentsStatus).toBe(200);
    expect(before.reactionsStatus).toBe(200);
    expect(before.tagCount).toBe(2);
    expect(before.relatedSlugs).toContain(victim.slug);
    expect(before.adminIds).toContain(victim.id);
    expect(before.adminSearchIds).toContain(victim.id);
    expect(before.adminPublishedIds).toContain(victim.id);
    expect(before.adminCommentIds).toContain(comment!.id);
    expect(before.overview.topPosts.map((p) => p.slug)).toContain(victim.slug);
    expect(before.overview.recentComments.map((c) => c.id)).toContain(comment!.id);
    expect(before.overview.totals.views).toBeGreaterThanOrEqual(7);
    expect(before.overview.totals.likes).toBeGreaterThanOrEqual(1);
    expect(before.adminPostStatsStatus).toBe(200);

    // 2) Eng yomon holat: chop etilgan VA chiqindi qutisida (status bo'yicha filtrlar tasodifan himoya qilmasligi uchun).
    await setDeleted(victim.id, true);
    const after = await readAll();

    expect(after.listSlugs).not.toContain(victim.slug);
    expect(after.listTotal).toBe(before.listTotal - 1);
    expect(after.tagSlugs).not.toContain(victim.slug);
    expect(after.tagSlugs).toContain(sibling.slug);
    expect(after.searchSlugs).not.toContain(victim.slug);
    expect(after.feedSlugs).not.toContain(victim.slug);
    expect(after.detailStatus).toBe(404);
    expect(after.statsStatus).toBe(404);
    expect((await post(`/posts/${victim.slug}/view`, null)).status).toBe(404);
    expect(after.commentsStatus).toBe(404);
    expect(after.reactionsStatus).toBe(404);
    expect(after.commentItemStatus).toBe(404);
    expect(after.tagCount).toBe(1);
    expect(after.relatedSlugs).not.toContain(victim.slug);
    expect(after.adjacent).not.toContain(victim.slug);
    expect(after.adminIds).not.toContain(victim.id);
    expect(after.adminTotal).toBe(before.adminTotal - 1);
    expect(after.adminTotals.all).toBe(before.adminTotals.all - 1);
    expect(after.adminTotals.published).toBe(before.adminTotals.published - 1);
    expect(after.adminSearchIds).not.toContain(victim.id);
    expect(after.adminPublishedIds).not.toContain(victim.id);
    expect(after.adminCommentIds).not.toContain(comment!.id);
    expect(after.adminCommentCounts.all).toBe(before.adminCommentCounts.all - 1);
    expect(after.adminCommentCounts.pending).toBe(before.adminCommentCounts.pending - 1);
    expect(after.overview.topPosts.map((p) => p.slug)).not.toContain(victim.slug);
    expect(after.overview.recentComments.map((c) => c.id)).not.toContain(comment!.id);
    expect(after.overview.totals.views).toBe(before.overview.totals.views - 7);
    expect(after.overview.totals.likes).toBe(before.overview.totals.likes - 1);
    expect(after.overview.totals.publishedPosts).toBe(before.overview.totals.publishedPosts - 1);
    expect(after.overview.pendingComments).toBe(before.overview.pendingComments - 1);
    expect(after.summarySlugs).not.toContain(victim.slug);
    expect(after.summaryPending).toBe(before.summaryPending - 1);
    expect(after.adminPostStatsStatus).toBe(404);

    // Admin tomondan to'g'ridan-to'g'ri ID bo'yicha ham 404.
    for (const path of [`/admin/posts/${victim.id}`, `/admin/posts/${victim.id}/preview`, `/admin/posts/${victim.id}/revisions`, `/admin/posts/${victim.id}/channel/versions`]) {
      expect((await get(path, admin.cookie)).status).toBe(404);
    }
    expect((await post(`/admin/posts/${victim.id}/publish`, admin.cookie)).status).toBe(404);
    expect((await patch(`/admin/posts/${victim.id}`, admin.cookie, { title: "Yangi" })).status).toBe(404);

    // 3) Qaytarish: hamma narsa joyiga qaytadi.
    await setDeleted(victim.id, false);
    const restored = await readAll();
    expect(restored.listSlugs).toContain(victim.slug);
    expect(restored.adminCommentIds).toContain(comment!.id);
    expect(restored.overview.totals.views).toBe(before.overview.totals.views);
  });

  it("mine/summary of a staff member ignores trashed posts", async () => {
    const created = await json<{ id: string }>(await post("/admin/posts", staff.cookie, { title: "Xodim savati" }));
    const before = await json<{ counts: { draft: number }; recent: { id: string }[] }>(await get("/admin/posts/mine/summary", staff.cookie));
    expect(before.recent.map((r) => r.id)).toContain(created.id);

    await del(`/admin/posts/${created.id}`, admin.cookie);
    const after = await json<{ counts: { draft: number }; recent: { id: string }[] }>(await get("/admin/posts/mine/summary", staff.cookie));
    expect(after.recent.map((r) => r.id)).not.toContain(created.id);
    expect(after.counts.draft).toBe(before.counts.draft - 1);
    const staffList = await json<{ items: { id: string }[]; totals: { all: number } }>(await get("/admin/posts", staff.cookie));
    expect(staffList.items.map((r) => r.id)).not.toContain(created.id);
  });

  it("the scheduler never publishes a trashed scheduled post", async () => {
    const created = await json<{ id: string }>(await post("/admin/posts", admin.cookie, { title: "Rejalangan savat" }));
    const when = new Date(Date.now() - 60_000).toISOString();
    await post(`/admin/posts/${created.id}/schedule`, admin.cookie, { scheduledAt: when });
    await setDeleted(created.id, true);

    const { publishDuePosts } = await import("../lib/scheduler.js");
    await publishDuePosts();
    const [row] = await db.select().from(schema.posts).where(eq(schema.posts.id, created.id));
    expect(row?.status).toBe("scheduled");
    expect(row?.publishedAt).toBeNull();

    await setDeleted(created.id, false);
    await publishDuePosts();
    const [published] = await db.select().from(schema.posts).where(eq(schema.posts.id, created.id));
    expect(published?.status).toBe("published");
  });

  it("channel-plan runs (due sends and crash recovery) skip a trashed post", async () => {
    const victim = await createPublished();
    const plan = { mode: "text", variant: "m", delayMinutes: 0, attempts: 0 };
    await db
      .update(schema.posts)
      .set({ channelPlan: plan, channelSendAt: new Date(Date.now() - 60_000), deletedAt: new Date() })
      .where(eq(schema.posts.id, victim.id));
    const interrupted = await createPublished();
    await db
      .update(schema.posts)
      .set({ channelPlan: plan, channelSendAt: null, deletedAt: new Date() })
      .where(eq(schema.posts.id, interrupted.id));

    const { runDueChannelSends, recoverInterruptedChannelSends, runChannelPlanFor } = await import("../telegram/channel-plan.js");
    await runDueChannelSends();
    expect(await recoverInterruptedChannelSends()).toBe(0);
    expect(await runChannelPlanFor(victim.id)).toEqual({ state: "skipped" });

    const [a] = await db.select().from(schema.posts).where(eq(schema.posts.id, victim.id));
    expect(a?.channelSendAt).not.toBeNull(); // da'vo qilinmadi
    expect(a?.channelPlan).toMatchObject({ delayMinutes: 0 });
    const [b] = await db.select().from(schema.posts).where(eq(schema.posts.id, interrupted.id));
    expect(b?.channelSendAt).toBeNull(); // tiklanmadi
  });

  it("Telegram sync and bot commands treat a trashed post as missing", async () => {
    const victim = await createPublished();
    const { findPostBySlug } = await import("../telegram/commands.js");
    expect((await findPostBySlug(victim.slug))?.id).toBe(victim.id);
    await setDeleted(victim.id, true);
    expect(await findPostBySlug(victim.slug)).toBeNull();

    const svc = await import("../lib/posts/index.js");
    const telegramActor = { userId: admin.id, role: "admin" as const, via: "telegram" as const };
    expect(await svc.publishPost(telegramActor, victim.id)).toMatchObject({ ok: false, error: { kind: "not_found" } });
    expect(await svc.unpublishPost(telegramActor, victim.id)).toMatchObject({ ok: false, error: { kind: "not_found" } });
    expect(await svc.updatePost(telegramActor, victim.id, { settings: { commentsEnabled: false } })).toMatchObject({
      ok: false,
      error: { kind: "not_found" },
    });

    // Telegraph/kanal sinxronizatsiyasi chiqindi qutisidagi postga tegmaydi (telegram_refs yaratilmaydi).
    const { refreshTelegraphMirror } = await import("../telegram/publish.js");
    await refreshTelegraphMirror(victim.id);
    expect(await db.select().from(schema.telegramRefs).where(eq(schema.telegramRefs.postId, victim.id))).toHaveLength(0);

    // Channel preview/preflight ham "topilmadi".
    const preview = await post(`/admin/posts/${victim.id}/channel/preview`, admin.cookie, { mode: "text", variant: "m" });
    expect(preview.status).toBe(404);
  });

  it("anything that read the old hard delete as 'gone' now sees a trashed row only in the trash list", async () => {
    const created = await json<{ id: string }>(await post("/admin/posts", admin.cookie, { title: "Faqat savatda" }));
    await del(`/admin/posts/${created.id}`, admin.cookie);
    const trash = TrashListResponseSchema.parse(await (await get("/admin/posts/trash?limit=100", admin.cookie)).json());
    expect(trash.items.map((i) => i.id)).toContain(created.id);
    const rows = await db
      .select({ id: schema.posts.id })
      .from(schema.posts)
      .where(and(eq(schema.posts.id, created.id), sql`${schema.posts.deletedAt} is not null`));
    expect(rows).toHaveLength(1);
  });
});

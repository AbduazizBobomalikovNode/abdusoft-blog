import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, type TestUser } from "../../test/auth-test-helpers.js";

type Svc = typeof import("./index.js");
let svc: Svc;
let db: typeof import("../../db/index.js").db;
let schema: typeof import("../../db/schema.js");
let events: typeof import("../events.js").events;
let config: { POST_REVISION_INTERVAL_MINUTES: number; POST_REVISION_MAX_PER_POST: number };
let admin: TestUser;
let staff: TestUser;
let otherStaff: TestUser;

const adminActor = (via: "web" | "mcp" = "web") => svc.actorFromAdminUser({ id: admin.id, role: "admin" }, via);
const staffActor = (u: TestUser = staff) => svc.actorFromAdminUser({ id: u.id, role: "staff" }, "web");

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

async function newPost(actor: import("./index.js").Actor, title = "Revision sinovi") {
  const created = await svc.createPost(actor, { title });
  if (!created.ok) throw new Error("create failed");
  return created.data;
}

async function revisions(postId: string) {
  return db.select().from(schema.postRevisions).where(eq(schema.postRevisions.postId, postId)).orderBy(asc(schema.postRevisions.seq));
}

async function backdateLatest(postId: string, minutes: number) {
  const rows = await revisions(postId);
  const latest = rows[rows.length - 1]!;
  await db
    .update(schema.postRevisions)
    .set({ createdAt: new Date(Date.now() - minutes * 60_000) })
    .where(eq(schema.postRevisions.id, latest.id));
}

beforeAll(async () => {
  await migrateTestDb();
  svc = await import("./index.js");
  ({ db } = await import("../../db/index.js"));
  schema = await import("../../db/schema.js");
  ({ events } = await import("../events.js"));
  ({ config } = (await import("../../config.js")) as unknown as { config: typeof config });
  admin = await createTestUser({ role: "admin", name: "Admin" });
  staff = await createTestUser({ role: "staff", name: "Xodim" });
  otherStaff = await createTestUser({ role: "staff", name: "Boshqa" });
});

afterEach(() => {
  config.POST_REVISION_INTERVAL_MINUTES = 10;
  config.POST_REVISION_MAX_PER_POST = 100;
});

describe("revision snapshot policy for plain updates", () => {
  it("an autosave burst by one actor produces a single snapshot of the pre-edit state", async () => {
    const post = await newPost(adminActor(), "Boshlang'ich");
    for (let i = 0; i < 30; i++) {
      const res = await svc.updatePost(adminActor(), post.id, { title: `Avtosaqlash ${i}`, contentJson: doc(`Matn ${i}`) });
      expect(res.ok).toBe(true);
    }
    const rows = await revisions(post.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Boshlang'ich", reason: "update", via: "web", createdBy: admin.id, status: "draft" });
  });

  it("snapshots again once the interval has elapsed", async () => {
    const post = await newPost(adminActor());
    await svc.updatePost(adminActor(), post.id, { title: "A" });
    await svc.updatePost(adminActor(), post.id, { title: "B" });
    expect(await revisions(post.id)).toHaveLength(1);

    await backdateLatest(post.id, 11);
    await svc.updatePost(adminActor(), post.id, { title: "C" });
    const rows = await revisions(post.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.title).toBe("B");
  });

  it("an interval of 0 snapshots before every update", async () => {
    config.POST_REVISION_INTERVAL_MINUTES = 0;
    const post = await newPost(adminActor());
    for (let i = 0; i < 3; i++) await svc.updatePost(adminActor(), post.id, { title: `T${i}` });
    expect(await revisions(post.id)).toHaveLength(3);
  });

  it("a different actor never coalesces into the previous one's revision", async () => {
    const post = await newPost(staffActor());
    await svc.updatePost(staffActor(), post.id, { title: "Xodim yozdi 1" });
    await svc.updatePost(staffActor(), post.id, { title: "Xodim yozdi 2" });
    expect(await revisions(post.id)).toHaveLength(1);

    await svc.updatePost(adminActor(), post.id, { title: "Admin tahriri" });
    let rows = await revisions(post.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ title: "Xodim yozdi 2", createdBy: admin.id });

    // Admin davom etsa — birlashadi; xodim qaytsa — yana ajratiladi.
    await svc.updatePost(adminActor(), post.id, { title: "Admin tahriri 2" });
    expect(await revisions(post.id)).toHaveLength(2);
    await svc.updatePost(staffActor(), post.id, { title: "Xodim qaytdi" });
    rows = await revisions(post.id);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ title: "Admin tahriri 2", createdBy: staff.id });
  });

  it("the same user on a different channel (web vs mcp) is a different actor", async () => {
    const post = await newPost(adminActor());
    await svc.updatePost(adminActor("web"), post.id, { title: "Inson" });
    await svc.updatePost(adminActor("mcp"), post.id, { title: "Yordamchi" });
    const rows = await revisions(post.id);
    expect(rows.map((row) => row.via)).toEqual(["web", "mcp"]);
    await svc.updatePost(adminActor("mcp"), post.id, { title: "Yordamchi 2" });
    expect(await revisions(post.id)).toHaveLength(2);
  });

  it("a no-op update (nothing to write) takes no snapshot", async () => {
    const post = await newPost(adminActor());
    await svc.updatePost(adminActor(), post.id, {});
    expect(await revisions(post.id)).toHaveLength(0);
  });

  it("stores tag slugs and settings in the snapshot", async () => {
    const [tag] = await db.insert(schema.tags).values({ slug: "rev-teg", name: "Rev" }).returning();
    const post = await newPost(adminActor());
    await svc.updatePost(adminActor(), post.id, { tagSlugs: ["rev-teg"], settings: { commentsEnabled: false } });
    await svc.updatePost(adminActor("mcp"), post.id, { title: "Keyingi" });
    const rows = await revisions(post.id);
    expect(rows[1]?.tagSlugs).toEqual(["rev-teg"]);
    expect((rows[1]?.settings as { commentsEnabled?: boolean }).commentsEnabled).toBe(false);
    expect(tag).toBeDefined();
  });
});

describe("transitions always snapshot first", () => {
  it("publish, unpublish, archive and schedule each add a revision regardless of the interval", async () => {
    const post = await newPost(adminActor());
    await svc.updatePost(adminActor(), post.id, { title: "Mazmun" });
    expect(await revisions(post.id)).toHaveLength(1);

    await svc.publishPost(adminActor(), post.id);
    await svc.unpublishPost(adminActor(), post.id);
    await svc.schedulePost(adminActor(), post.id, { scheduledAt: new Date(Date.now() + 3_600_000).toISOString() });
    await svc.archivePost(adminActor(), post.id);

    const rows = await revisions(post.id);
    expect(rows.map((row) => row.reason)).toEqual(["update", "publish", "unpublish", "schedule", "archive"]);
    expect(rows.map((row) => row.status)).toEqual(["draft", "draft", "published", "draft", "scheduled"]);
  });

  it("approve and the scheduler publish snapshot too (system actor has no user id)", async () => {
    const reviewed = await newPost(staffActor());
    await svc.submitPostForReview(staffActor(), reviewed.id);
    await svc.approvePost(adminActor(), reviewed.id);
    expect((await revisions(reviewed.id)).map((row) => row.reason)).toEqual(["publish"]);

    const scheduled = await newPost(adminActor());
    await svc.schedulePost(adminActor(), scheduled.id, { scheduledAt: new Date(Date.now() - 1000).toISOString() });
    await svc.publishDuePosts();
    const rows = await revisions(scheduled.id);
    expect(rows.map((row) => row.reason)).toEqual(["schedule", "publish"]);
    expect(rows[1]).toMatchObject({ createdBy: null, via: "scheduler", status: "scheduled" });
  });
});

describe("retention", () => {
  it("keeps at most N revisions, oldest pruned first, newest never", async () => {
    config.POST_REVISION_MAX_PER_POST = 3;
    const post = await newPost(adminActor());
    for (let i = 0; i < 6; i++) {
      await svc.publishPost(adminActor(), post.id);
      await svc.unpublishPost(adminActor(), post.id);
    }
    const rows = await revisions(post.id);
    expect(rows).toHaveLength(3);
    // 12 ta surat olingan; qolgani oxirgi 3 tasi (publish, unpublish dan keyingi eng yangilari).
    expect(rows.map((row) => row.reason)).toEqual(["unpublish", "publish", "unpublish"]);
    const all = await db.select().from(schema.postRevisions).where(eq(schema.postRevisions.postId, post.id));
    expect(Math.max(...all.map((row) => row.seq))).toBe(rows[2]?.seq);
  });

  it("N = 1 still keeps the newest revision", async () => {
    config.POST_REVISION_MAX_PER_POST = 1;
    const post = await newPost(adminActor());
    await svc.publishPost(adminActor(), post.id);
    await svc.archivePost(adminActor(), post.id);
    const rows = await revisions(post.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe("archive");
  });

  it("pruning one post never touches another post's history", async () => {
    config.POST_REVISION_MAX_PER_POST = 2;
    const a = await newPost(adminActor());
    const b = await newPost(adminActor());
    await svc.publishPost(adminActor(), b.id);
    for (let i = 0; i < 4; i++) await svc.publishPost(adminActor(), a.id);
    expect(await revisions(a.id)).toHaveLength(2);
    expect(await revisions(b.id)).toHaveLength(1);
  });
});

describe("restore from a revision", () => {
  it("snapshots the current state first, then applies the old content through the update path", async () => {
    const [tag] = await db.insert(schema.tags).values({ slug: "restore-teg", name: "Restore" }).returning();
    const post = await newPost(adminActor(), "Birinchi nom");
    await svc.updatePost(adminActor(), post.id, {
      contentJson: doc("Eski matn"),
      excerpt: "Eski qisqacha",
      tagSlugs: ["restore-teg"],
      settings: { commentsEnabled: false },
    });
    // mcp tahriri eski holatni revision sifatida saqlaydi (aktyor almashdi).
    await svc.updatePost(adminActor("mcp"), post.id, {
      title: "Yangi nom",
      contentJson: doc("Yangi matn"),
      excerpt: "Yangi qisqacha",
      tagSlugs: [],
      settings: { commentsEnabled: true },
    });
    const before = await revisions(post.id);
    const oldRevision = before.find((row) => row.via === "mcp")!;
    // Bu revision — birinchi tahrirdan KEYINGI ("Eski matn") holat.
    expect(oldRevision.title).toBe("Birinchi nom");
    expect(JSON.stringify(oldRevision.contentJson)).toContain("Eski matn");

    const restored = await svc.restoreRevision(adminActor(), post.id, oldRevision.id);
    expect(restored.ok).toBe(true);

    const [row] = await db.select().from(schema.posts).where(eq(schema.posts.id, post.id));
    expect(row?.title).toBe("Birinchi nom");
    expect(row?.contentText).toContain("Eski matn");
    expect(row?.contentHtml).toContain("Eski matn");
    expect(row?.excerpt).toBe("Eski qisqacha");
    expect((row?.settings as { commentsEnabled: boolean }).commentsEnabled).toBe(false);
    const tagRows = await db.select().from(schema.postTags).where(eq(schema.postTags.postId, post.id));
    expect(tagRows.map((t) => t.tagId)).toEqual([tag!.id]);

    const after = await revisions(post.id);
    expect(after).toHaveLength(before.length + 1);
    const snapshot = after[after.length - 1]!;
    expect(snapshot.reason).toBe("restore-revision");
    expect(snapshot.title).toBe("Yangi nom");
    expect(JSON.stringify(snapshot.contentJson)).toContain("Yangi matn");
  });

  it("emits post.updated for a published post and keeps its status", async () => {
    const post = await newPost(adminActor());
    await svc.updatePost(adminActor(), post.id, { contentJson: doc("Birinchi") });
    await svc.publishPost(adminActor(), post.id);
    const rows = await revisions(post.id);
    const target = rows[0]!;

    const seen: string[] = [];
    const listener = (payload: { id: string }) => void seen.push(payload.id);
    events.on("post.updated", listener);
    try {
      const res = await svc.restoreRevision(adminActor(), post.id, target.id);
      expect(res.ok).toBe(true);
    } finally {
      events.off("post.updated", listener);
    }
    expect(seen).toEqual([post.id]);
    const [row] = await db.select().from(schema.posts).where(eq(schema.posts.id, post.id));
    expect(row?.status).toBe("published");
  });

  it("applies staff rules: own draft only, no settings, not another staff member's post", async () => {
    const post = await newPost(staffActor());
    await svc.updatePost(staffActor(), post.id, { title: "Birinchi" });
    await svc.updatePost(adminActor(), post.id, { title: "Admin" });
    const target = (await revisions(post.id))[0]!;

    expect(await svc.restoreRevision(staffActor(otherStaff), post.id, target.id)).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect((await svc.restoreRevision(staffActor(), post.id, target.id)).ok).toBe(true);

    await svc.submitPostForReview(staffActor(), post.id);
    expect(await svc.restoreRevision(staffActor(), post.id, target.id)).toMatchObject({ ok: false, error: { kind: "conflict" } });
  });

  it("fails when the revision's slug is now used by another post", async () => {
    const a = await newPost(adminActor());
    await svc.updatePost(adminActor(), a.id, { slug: "birinchi-slug" });
    await svc.updatePost(adminActor("mcp"), a.id, { slug: "ikkinchi-slug" });
    const revision = (await revisions(a.id)).find((row) => row.slug === "birinchi-slug")!;
    const b = await newPost(adminActor());
    await svc.updatePost(adminActor(), b.id, { slug: "birinchi-slug" });

    const res = await svc.restoreRevision(adminActor(), a.id, revision.id);
    expect(res).toMatchObject({ ok: false, error: { kind: "bad_request" } });
    const [row] = await db.select().from(schema.posts).where(eq(schema.posts.id, a.id));
    expect(row?.slug).toBe("ikkinchi-slug");
  });

  it("404s for a revision of another post", async () => {
    const a = await newPost(adminActor());
    const b = await newPost(adminActor());
    await svc.publishPost(adminActor(), a.id);
    const revision = (await revisions(a.id))[0]!;
    expect(await svc.restoreRevision(adminActor(), b.id, revision.id)).toMatchObject({ ok: false, error: { kind: "not_found" } });
    expect(await svc.getRevision(adminActor(), b.id, revision.id)).toMatchObject({ ok: false, error: { kind: "not_found" } });
  });
});

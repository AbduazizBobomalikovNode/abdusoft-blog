import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, type TestUser } from "../../test/auth-test-helpers.js";

type Svc = typeof import("./index.js");
type Dbm = typeof import("../../db/index.js");
type Schema = typeof import("../../db/schema.js");
type Ev = typeof import("../events.js");

let svc: Svc;
let db: Dbm["db"];
let schema: Schema;
let events: Ev["events"];
let admin: TestUser;
let staff: TestUser;
let otherStaff: TestUser;

const adminActor = () => svc.actorFromAdminUser({ id: admin.id, role: "admin" }, "web");
const staffActor = (u: TestUser = staff) => svc.actorFromAdminUser({ id: u.id, role: "staff" }, "web");

async function newPost(actor: import("./index.js").Actor, title = "Sinov post") {
  const created = await svc.createPost(actor, { title });
  if (!created.ok) throw new Error("create failed");
  return created.data;
}

beforeAll(async () => {
  await migrateTestDb();
  svc = await import("./index.js");
  ({ db } = await import("../../db/index.js"));
  schema = await import("../../db/schema.js");
  ({ events } = await import("../events.js"));
  admin = await createTestUser({ role: "admin", name: "Admin" });
  staff = await createTestUser({ role: "staff", name: "Xodim" });
  otherStaff = await createTestUser({ role: "staff", name: "Boshqa xodim" });
});

describe("posts service — staff rules are enforced without HTTP", () => {
  it("staff cannot view or edit another staff member's post", async () => {
    const post = await newPost(staffActor());
    const view = await svc.getPostDetail(staffActor(otherStaff), post.id);
    expect(view).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    const edit = await svc.updatePost(staffActor(otherStaff), post.id, { title: "Hack" });
    expect(edit).toMatchObject({ ok: false, error: { kind: "forbidden" } });
  });

  it("staff cannot touch admin-only fields and cannot edit outside draft/changes_requested", async () => {
    const post = await newPost(staffActor());
    const pinned = await svc.updatePost(staffActor(), post.id, { pinned: true });
    expect(pinned).toMatchObject({ ok: false, error: { kind: "forbidden" } });

    expect((await svc.submitPostForReview(staffActor(), post.id)).ok).toBe(true);
    const locked = await svc.updatePost(staffActor(), post.id, { title: "Yana" });
    expect(locked).toMatchObject({ ok: false, error: { kind: "conflict" } });
  });

  it("staff cannot publish, unpublish, archive, schedule, approve, request changes or delete", async () => {
    const post = await newPost(staffActor());
    const actor = staffActor();
    const results = await Promise.all([
      svc.publishPost(actor, post.id),
      svc.unpublishPost(actor, post.id),
      svc.archivePost(actor, post.id),
      svc.schedulePost(actor, post.id, { scheduledAt: new Date().toISOString() }),
      svc.approvePost(actor, post.id),
      svc.requestPostChanges(actor, post.id, "x"),
      svc.deletePost(actor, post.id),
    ]);
    for (const result of results) expect(result).toMatchObject({ ok: false, error: { kind: "forbidden" } });
  });

  it("a post can only be submitted by its author", async () => {
    const post = await newPost(staffActor());
    const res = await svc.submitPostForReview(staffActor(otherStaff), post.id);
    expect(res).toMatchObject({ ok: false, error: { kind: "forbidden" } });
  });

  it("a system actor without a user id cannot submit a post", async () => {
    const post = await newPost(adminActor());
    const res = await svc.submitPostForReview(svc.SCHEDULER_ACTOR, post.id);
    expect(res).toMatchObject({ ok: false, error: { kind: "forbidden" } });
  });
});

describe("posts service — one publish path for admin, approve and scheduler", () => {
  it("emits post.published exactly once for each of the three publish paths", async () => {
    const seen: string[] = [];
    const listener = (payload: { id: string }) => void seen.push(payload.id);
    events.on("post.published", listener);
    try {
      const manual = await newPost(adminActor());
      expect((await svc.publishPost(adminActor(), manual.id)).ok).toBe(true);

      const reviewed = await newPost(staffActor());
      await svc.submitPostForReview(staffActor(), reviewed.id);
      expect((await svc.approvePost(adminActor(), reviewed.id)).ok).toBe(true);

      const scheduled = await newPost(adminActor());
      const when = new Date(Date.now() - 60_000).toISOString();
      expect((await svc.schedulePost(adminActor(), scheduled.id, { scheduledAt: when })).ok).toBe(true);
      await svc.publishDuePosts();

      expect(seen.filter((id) => id === manual.id)).toHaveLength(1);
      expect(seen.filter((id) => id === reviewed.id)).toHaveLength(1);
      expect(seen.filter((id) => id === scheduled.id)).toHaveLength(1);

      const [row] = await db.select().from(schema.posts).where(eq(schema.posts.id, scheduled.id));
      expect(row?.status).toBe("published");
      expect(row?.scheduledAt).toBeNull();
    } finally {
      events.off("post.published", listener);
    }
  });

  it("scheduler skips a post that stopped being scheduled before it was claimed", async () => {
    const post = await newPost(adminActor());
    await svc.schedulePost(adminActor(), post.id, { scheduledAt: new Date(Date.now() - 1000).toISOString() });
    await svc.unpublishPost(adminActor(), post.id);
    await svc.publishDuePosts();
    const [row] = await db.select().from(schema.posts).where(eq(schema.posts.id, post.id));
    expect(row?.status).toBe("draft");
  });
});

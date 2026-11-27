import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, type TestUser } from "../../test/auth-test-helpers.js";

// Asosiy video video xizmatiga (VIDEO_ENABLED) bog'liq EMAS: bayroq bu faylda ataylab o'chiq.
vi.hoisted(() => {
  process.env.VIDEO_ENABLED = "false";
});

const revalidate = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock("../revalidate.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../revalidate.js")>();
  return { ...real, revalidateWeb: (paths: string[]) => void revalidate.calls.push(paths) };
});

const OWN = "http://localhost:4000/uploads/video/clip.mp4";
let app: Hono;
let admin: TestUser;
let staff: TestUser;
let db: typeof import("../../db/index.js").db;
let s: typeof import("../../db/schema.js");
let jobs: typeof import("../video/jobs.js");
let seq = 0;

const req = (p: string, who: TestUser | null, init: { method?: string; json?: unknown } = {}) =>
  app.request(p, { method: init.method ?? "GET", headers: { ...(who ? { cookie: who.cookie } : {}), ...(init.json !== undefined ? { "content-type": "application/json" } : {}) }, ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}) });
const patch = (id: string, json: unknown, who: TestUser = admin) => req(`/admin/posts/${id}`, who, { method: "PATCH", json });

async function newPost(status: "draft" | "published" = "published", createdBy?: string): Promise<{ id: string; slug: string }> {
  const slug = `mv-post-${++seq}`;
  const [row] = await db
    .insert(s.posts)
    .values({ slug, title: slug, contentJson: { type: "doc", content: [] }, contentHtml: "<p>x</p>", toc: [], status, publishedAt: status === "published" ? new Date() : null, createdBy: createdBy ?? null } as never)
    .returning();
  return { id: (row as { id: string }).id, slug };
}

async function newJob(postId: string | null, o: { kind?: "render" | "gif" | "preview"; status?: "ready" | "queued"; assets?: Array<{ kind: string; url?: string; width?: number | null; height?: number | null }> } = {}): Promise<string> {
  const [job] = await db
    .insert(s.motionJobs)
    .values({ kind: o.kind ?? "render", status: o.status ?? "ready", postId, storyboard: {}, durationSeconds: 58, via: "mcp", finishedAt: new Date() } as never)
    .returning();
  const id = (job as { id: string }).id;
  const assets = o.assets ?? [{ kind: "mp4", width: 1280, height: 720 }];
  for (const [i, a] of assets.entries()) {
    await db.insert(s.motionAssets).values({ jobId: id, kind: a.kind, key: `video/none-${id}-${i}`, url: a.url ?? OWN.replace("clip", `${id}-${i}`), mime: a.kind === "mp4" ? "video/mp4" : "image/jpeg", size: 10, width: a.width === undefined ? 1280 : a.width, height: a.height === undefined ? 720 : a.height, seconds: 57.6 } as never);
  }
  return id;
}

const storedVideo = async (id: string) => ((await db.select({ v: s.posts.mainVideo }).from(s.posts).where(eq(s.posts.id, id)))[0]?.v ?? null) as Record<string, unknown> | null;
const publicPost = async (slug: string) => (await (await req(`/posts/${slug}`, null)).json()) as { mainVideo: Record<string, unknown> | null };

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  ({ db } = await import("../../db/index.js"));
  s = await import("../../db/schema.js");
  jobs = await import("../video/jobs.js");
  admin = await createTestUser({ role: "admin" });
  staff = await createTestUser({ role: "staff" });
});
beforeEach(() => {
  revalidate.calls.length = 0;
});

describe("setting and clearing the main video", () => {
  it("sets a snapshot from the post's ready render (video service off), audits and revalidates, then clears with null", async () => {
    const post = await newPost();
    const job = await newJob(post.id);
    const r = await patch(post.id, { mainVideoJobId: job });
    expect(r.status).toBe(200);
    expect(await storedVideo(post.id)).toMatchObject({ jobId: job, posterUrl: null, width: 1280, height: 720, seconds: 57.6, mime: "video/mp4" });
    expect(revalidate.calls.some((p) => p.includes(`/${post.slug}`))).toBe(true);
    const audit = (await db.select().from(s.auditLog)).filter((a) => a.entityId === post.id);
    expect(JSON.stringify(audit)).toContain("mainVideoJobId");

    const detail = (await (await req(`/admin/posts/${post.id}`, admin)).json()) as { mainVideo: { jobId: string } | null };
    expect(detail.mainVideo?.jobId).toBe(job);

    revalidate.calls.length = 0;
    expect((await patch(post.id, { mainVideoJobId: null })).status).toBe(200);
    expect(await storedVideo(post.id)).toBeNull();
    expect(revalidate.calls.some((p) => p.includes(`/${post.slug}`))).toBe(true);
  });

  it("uses the job's still as the poster when one exists", async () => {
    const post = await newPost();
    const job = await newJob(post.id, { assets: [{ kind: "mp4" }, { kind: "still", url: "http://localhost:4000/uploads/video/poster.jpg" }] });
    expect((await patch(post.id, { mainVideoJobId: job })).status).toBe(200);
    expect(await storedVideo(post.id)).toMatchObject({ posterUrl: "http://localhost:4000/uploads/video/poster.jpg" });
  });

  it("refuses another post's job, a non-ready job, preview/gif jobs, a missing job, a non-own URL and an mp4 without size", async () => {
    const post = await newPost();
    const other = await newPost();
    const cases: Array<[string, string, number]> = [
      [await newJob(other.id), "job_other_post", 400],
      [await newJob(null), "job_other_post", 400],
      [await newJob(post.id, { status: "queued" }), "job_not_ready", 409],
      [await newJob(post.id, { kind: "preview", assets: [{ kind: "still" }] }), "job_not_render", 400],
      [await newJob(post.id, { kind: "gif", assets: [{ kind: "gif" }] }), "job_not_render", 400],
      [await newJob(post.id, { assets: [{ kind: "mp4", url: "https://evil.example/x.mp4" }] }), "job_url_not_own", 400],
      [await newJob(post.id, { assets: [{ kind: "mp4", width: null, height: null }] }), "job_no_mp4", 400],
      ["00000000-0000-4000-8000-000000000000", "job_not_found", 404],
    ];
    for (const [job, code, status] of cases) {
      const r = await patch(post.id, { mainVideoJobId: job });
      expect({ code, status: r.status, body: (await r.json()) as { code?: string } }, code).toMatchObject({ status, body: { code } });
    }
    expect((await patch(post.id, { mainVideoJobId: "not-a-uuid" })).status).toBe(400);
    expect(await storedVideo(post.id)).toBeNull();
  });

  it("staff cannot set it (403) even on their own draft", async () => {
    const own = await newPost("draft", staff.id);
    const job = await newJob(own.id);
    expect((await patch(own.id, { mainVideoJobId: job }, staff)).status).toBe(403);
    expect(await storedVideo(own.id)).toBeNull();
  });

  it("restoring a revision leaves the video as it is (not part of revisions)", async () => {
    const post = await newPost();
    const job = await newJob(post.id);
    await patch(post.id, { mainVideoJobId: job });
    await patch(post.id, { title: "Yangi sarlavha" });
    const revs = (await (await req(`/admin/posts/${post.id}/revisions`, admin)).json()) as { items?: Array<{ id: string }> } | Array<{ id: string }>;
    const list = Array.isArray(revs) ? revs : (revs.items ?? []);
    if (list[0]) await req(`/admin/posts/${post.id}/revisions/${list[0].id}/restore`, admin, { method: "POST", json: {} });
    expect(await storedVideo(post.id)).toMatchObject({ jobId: job });
  });
});

describe("public read", () => {
  it("returns mainVideo without the job id for a published post, null when none, null when the stored value is malformed", async () => {
    const post = await newPost();
    expect((await publicPost(post.slug)).mainVideo).toBeNull();
    await patch(post.id, { mainVideoJobId: await newJob(post.id) });
    const v = (await publicPost(post.slug)).mainVideo;
    expect(v).toMatchObject({ width: 1280, height: 720, mime: "video/mp4", posterUrl: null });
    expect(v).not.toHaveProperty("jobId");
    for (const bad of [{ nope: 1 }, "str", { url: "javascript:alert(1)", width: 1, height: 1, seconds: 1 }, { url: OWN, width: 0, height: 5, seconds: 1 }]) {
      await db.update(s.posts).set({ mainVideo: bad as never }).where(eq(s.posts.id, post.id));
      expect((await publicPost(post.slug)).mainVideo, JSON.stringify(bad)).toBeNull();
    }
  });

  it("never exposes a draft's video", async () => {
    const post = await newPost("draft");
    await db.update(s.posts).set({ mainVideo: { url: OWN, width: 1, height: 1, seconds: 1, posterUrl: null, mime: "video/mp4" } as never }).where(eq(s.posts.id, post.id));
    expect((await req(`/posts/${post.slug}`, null)).status).toBe(404);
  });
});

describe("a main video protects its job", () => {
  it("deleteJob answers job_referenced while set and succeeds after clearing; pruning keeps it", async () => {
    const post = await newPost();
    const job = await newJob(post.id);
    await patch(post.id, { mainVideoJobId: job });
    const actor = { userId: admin.id, role: "admin", via: "web" } as never;
    const blocked = await jobs.deleteJob(actor, job);
    expect(blocked).toMatchObject({ ok: false, error: { extra: { code: "job_referenced" } } });

    // eng yangi 3 tasi qoladi, eskisi (asosiy video) o'chirilmaydi
    for (let i = 0; i < 4; i++) await newJob(post.id);
    await jobs.pruneRendersForPost(post.id);
    expect((await db.select().from(s.motionJobs).where(eq(s.motionJobs.id, job))).length).toBe(1);

    await patch(post.id, { mainVideoJobId: null });
    expect((await jobs.deleteJob(actor, job)).ok).toBe(true);
    expect((await db.select().from(s.motionJobs).where(eq(s.motionJobs.id, job))).length).toBe(0);
  });
});

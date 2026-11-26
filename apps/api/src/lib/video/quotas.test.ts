import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { sbOf } from "../../test/video-harness.js";

vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/video-quota-test-${process.pid}`;
  process.env.VIDEO_ENABLED = "true";
  process.env.VIDEO_RUNNER = "github";
  process.env.VIDEO_RUNNER_SECRET = "q".repeat(48);
  process.env.VIDEO_GITHUB_TOKEN = "github_pat_quota";
  process.env.VIDEO_GITHUB_REPO = "owner/blog";
  process.env.VIDEO_DATA_DIR = `${dir}/data`;
  process.env.VIDEO_MAX_RUNNING = "1";
});

type Jobs = typeof import("./jobs.js");
let jobs: Jobs;
let db: typeof import("../../db/index.js").db;
let s: typeof import("../../db/schema.js");
let config: Record<string, number | string | boolean>;
let userId: string;
let n = 0;
const saved: Record<string, unknown> = {};
const setCfg = (patch: Record<string, number | string | boolean>) => {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in saved)) saved[k] = config[k];
    config[k] = v;
  }
};
const actor = () => ({ userId, role: "admin" as const, via: "web" as const });
const newPost = async (): Promise<string> => {
  n++;
  const [row] = await db.insert(s.posts).values({ slug: `quota-${n}`, title: `p${n}`, contentJson: { type: "doc", content: [] }, contentHtml: "", toc: [], status: "draft" } as never).returning();
  return (row as { id: string }).id;
};
const codeOf = (r: Awaited<ReturnType<Jobs["createJob"]>>): string | null => (r.ok ? null : String(r.error.extra?.code ?? r.error.kind));

beforeAll(async () => {
  await migrateTestDb();
  ({ db } = await import("../../db/index.js"));
  s = await import("../../db/schema.js");
  ({ config } = (await import("../../config.js")) as unknown as { config: Record<string, number | string | boolean> });
  jobs = await import("./jobs.js");
  // No GitHub: the dispatch is a no-op, jobs just wait.
  (await import("./runner-github.js")).setDispatchHookForTests(async () => ({ ok: true, runId: null }));
  (await import("./resources.js")).setResourceProbeForTests(() => ({ freeDiskMb: 100_000, freeMemoryMb: 100_000 }));
  const { createTestUser } = await import("../../test/auth-test-helpers.js");
  userId = (await createTestUser({ role: "admin" })).id;
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) config[k] = v as never;
  for (const k of Object.keys(saved)) delete saved[k];
  await db.update(s.motionJobs).set({ status: "cancelled", finishedAt: new Date() }).where(eq(s.motionJobs.status, "queued"));
  await db.update(s.motionJobs).set({ status: "cancelled", finishedAt: new Date() }).where(eq(s.motionJobs.status, "running"));
  await db.delete(s.motionUsage);
});

describe("quotas are atomic under parallel calls", () => {
  it("10 parallel renders for ONE post: exactly one is accepted, nine get post_busy", async () => {
    const postId = await newPost();
    const results = await Promise.all(Array.from({ length: 10 }, () => jobs.createJob(actor(), { kind: "render", storyboard: sbOf("ok"), postId })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => codeOf(r) === "post_busy")).toHaveLength(9);
    const active = await db.select().from(s.motionJobs).where(eq(s.motionJobs.postId, postId));
    expect(active).toHaveLength(1);
  });

  it("the database itself refuses a second active render/gif for a post (partial unique index), but allows previews and finished jobs", async () => {
    const postId = await newPost();
    const row = { storyboard: sbOf("ok"), durationSeconds: 5, via: "web", postId } as never;
    await db.insert(s.motionJobs).values({ ...(row as object), kind: "render", status: "queued" } as never);
    await expect(db.insert(s.motionJobs).values({ ...(row as object), kind: "gif", status: "running" } as never)).rejects.toThrow();
    await db.insert(s.motionJobs).values({ ...(row as object), kind: "preview", status: "queued" } as never);
    await db.insert(s.motionJobs).values({ ...(row as object), kind: "render", status: "ready" } as never);
    await db.insert(s.motionJobs).values({ ...(row as object), kind: "render", status: "failed" } as never);
  });

  it("the queue limit holds under parallel calls (previews have no per-post limit)", async () => {
    setCfg({ VIDEO_MAX_QUEUE: 3 });
    const results = await Promise.all(Array.from({ length: 12 }, () => jobs.createJob(actor(), { kind: "preview", storyboard: sbOf("ok") })));
    const accepted = results.filter((r) => r.ok).length;
    // at most MAX_QUEUE waiting + the one the scheduler may already have started (VIDEO_MAX_RUNNING=1)
    expect(accepted).toBeGreaterThanOrEqual(3);
    expect(accepted).toBeLessThanOrEqual(4);
    expect(results.filter((r) => !r.ok).every((r) => codeOf(r) === "queue_full")).toBe(true);
    const q = await jobs.queueCounts();
    expect(q.queued).toBeLessThanOrEqual(3);
  });

  it("the daily render cap holds under parallel calls: exactly the cap is accepted", async () => {
    setCfg({ VIDEO_MAX_RENDERS_PER_DAY: 2, VIDEO_MAX_QUEUE: 50 });
    const posts = await Promise.all(Array.from({ length: 6 }, () => newPost()));
    const results = await Promise.all(posts.map((postId) => jobs.createJob(actor(), { kind: "render", storyboard: sbOf("ok"), postId })));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => codeOf(r) === "daily_renders")).toHaveLength(4);
  });

  it("the daily preview cap holds under parallel calls", async () => {
    setCfg({ VIDEO_MAX_PREVIEWS_PER_DAY: 3, VIDEO_MAX_QUEUE: 50 });
    const results = await Promise.all(Array.from({ length: 8 }, () => jobs.createJob(actor(), { kind: "preview", storyboard: sbOf("ok") })));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => codeOf(r) === "daily_previews")).toHaveLength(5);
  });
});

describe("the daily count cannot be reset by deleting jobs", () => {
  it("deleting every job does not give the quota back", async () => {
    setCfg({ VIDEO_MAX_RENDERS_PER_DAY: 2, VIDEO_MAX_QUEUE: 50 });
    const before = (await db.select().from(s.motionJobs)).length;
    for (let i = 0; i < 2; i++) {
      const r = await jobs.createJob(actor(), { kind: "render", storyboard: sbOf("ok"), postId: await newPost() });
      expect(r.ok).toBe(true);
      if (r.ok) {
        await jobs.cancelJob(actor(), r.data.id);
        const del = await jobs.deleteJob(actor(), r.data.id);
        expect(del.ok, JSON.stringify(del)).toBe(true);
      }
    }
    expect(await db.select().from(s.motionJobs)).toHaveLength(before);
    const third = await jobs.createJob(actor(), { kind: "render", storyboard: sbOf("ok"), postId: await newPost() });
    expect(codeOf(third)).toBe("daily_renders");
    expect((await jobs.countCreatedToday()).renders).toBe(2);
  });

  it("the ledger rows older than the window are pruned by the retention run, recent ones stay", async () => {
    await db.insert(s.motionUsage).values([{ bucket: "render", createdAt: new Date(Date.now() - 3 * 86400_000) }, { bucket: "render" }] as never);
    await jobs.runRetention();
    expect(await db.select().from(s.motionUsage)).toHaveLength(1);
  });
});

describe("dry-run style checks do not consume the quota", () => {
  it("checkQuotas alone writes nothing", async () => {
    await jobs.checkQuotas("render", null);
    expect(await db.select().from(s.motionUsage)).toHaveLength(0);
  });
});

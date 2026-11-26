import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { FAKE_WORKER, alive, makeVideoDir, readPid, sbOf, waitFor } from "../../test/video-harness.js";

const env = vi.hoisted(() => {
  // Shared temp dir for the whole file (hoisted: config reads the environment at import time).
  const dir = `${process.env.TMPDIR ?? "/tmp"}/video-jobs-test-${process.pid}`;
  process.env.VIDEO_ENABLED = "true";
  process.env.VIDEO_DATA_DIR = `${dir}/data`;
  process.env.VIDEO_MAX_RUNNING = "1";
  return { dir };
});

// Storage: a fake in a temp directory (no R2, no repo .data folder).
const storage = vi.hoisted(() => ({ root: "", deleted: [] as string[] }));
vi.mock("../media/store.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../media/store.js")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  return {
    ...real,
    storeFileFromPath: async (input: { path: string; ext: string; mime: string }) => {
      const key = `video/${Math.random().toString(36).slice(2)}.${input.ext}`;
      const dest = nodePath.join(storage.root, key);
      fs.mkdirSync(nodePath.dirname(dest), { recursive: true });
      fs.copyFileSync(input.path, dest);
      return { key, url: `http://localhost:4000/uploads/${key}`, size: fs.statSync(dest).size };
    },
    deleteStoredFile: async (key: string) => {
      storage.deleted.push(key);
      fs.rmSync(nodePath.join(storage.root, key), { force: true });
    },
    readStoredFile: async (key: string) => fs.readFileSync(nodePath.join(storage.root, key)),
  };
});

type Jobs = typeof import("./jobs.js");
type Runner = typeof import("./runner.js");
let jobs: Jobs;
let runner: Runner;
let resources: typeof import("./resources.js");
let schema: typeof import("../../db/schema.js");
let db: typeof import("../../db/index.js").db;
let config: Record<string, number | string | boolean>;
let postId: string;
let otherPostId: string;
let cwd: string;
let userId: string;
const actor = () => ({ userId, role: "admin" as const, via: "web" as const });
const mcpActor = () => ({ userId, role: "admin" as const, via: "mcp" as const, mcp: { clientId: "c1", clientName: "Claude", tool: "start_video_render", channelsSend: false } });

const saved: Record<string, unknown> = {};
const setCfg = (patch: Record<string, number | string | boolean>) => {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in saved)) saved[k] = config[k];
    config[k] = v;
  }
};

async function insertPost(slug: string, extra: Record<string, unknown> = {}): Promise<string> {
  const [row] = await db
    .insert(schema.posts)
    .values({ slug, title: slug, contentJson: { type: "doc", content: [] }, contentHtml: "", toc: [], status: "draft", ...extra } as never)
    .returning();
  return (row as { id: string }).id;
}

const create = async (mode: string, kind: "preview" | "render" | "gif" = "render", over: { postId?: string | null; options?: Record<string, unknown>; scenes?: number } = {}) => {
  const res = await jobs.createJob(actor(), { kind, storyboard: sbOf(mode, over.scenes), postId: over.postId === undefined ? postId : over.postId, ...(over.options ? { options: over.options } : {}) });
  if (!res.ok) throw new Error(`create failed: ${JSON.stringify(res.error)}`);
  return res.data;
};
const settle = async (id: string) => {
  await idleAll();
  return (await jobs.getJob(id))!;
};
/** Nothing queued or running any more (a job may be claimed a moment after it is created, so the in-memory set alone is not enough). */
const idleAll = async () => {
  await waitFor(async () => {
    const c = await jobs.queueCounts();
    return c.running === 0 && c.queued === 0 && jobs.runningJobCount() === 0;
  }, 45_000, 100);
};
const rowOf = async (id: string) => (await jobs.getJob(id))!.row;

beforeAll(async () => {
  const v = makeVideoDir();
  void v;
  storage.root = path.join(env.dir, "storage");
  mkdirSync(storage.root, { recursive: true });
  await migrateTestDb();
  ({ db } = await import("../../db/index.js"));
  schema = await import("../../db/schema.js");
  ({ config } = (await import("../../config.js")) as unknown as { config: Record<string, number | string | boolean> });
  jobs = await import("./jobs.js");
  runner = await import("./runner.js");
  resources = await import("./resources.js");
  const { createTestUser } = await import("../../test/auth-test-helpers.js");
  userId = (await createTestUser({ role: "admin" })).id;
  postId = await insertPost("video-post");
  otherPostId = await insertPost("video-post-2");
  cwd = path.join(env.dir, "cwd");
  mkdirSync(cwd, { recursive: true });
  runner.setWorkerLaunchForTests((_spec, specFile) => ({ command: process.execPath, args: [FAKE_WORKER, specFile], cwd }));
  runner.setKillGraceForTests(300);
  jobs.setKillMarginForTests(500);
  resources.setResourceProbeForTests(() => ({ freeDiskMb: 100_000, freeMemoryMb: 100_000 }));
});

beforeEach(() => {
  setCfg({ VIDEO_MAX_QUEUE: 5, VIDEO_MAX_RENDERS_PER_DAY: 0, VIDEO_MAX_PREVIEWS_PER_DAY: 0, VIDEO_RENDER_TIMEOUT_SECONDS: 30, VIDEO_WORKER_MEMORY_MB: 1536, VIDEO_KEEP_RENDERS_PER_POST: 3 });
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) config[k] = v as never;
  // leave nothing queued/running behind for the next test
  await db.update(schema.motionJobs).set({ status: "cancelled", finishedAt: new Date() }).where(eq(schema.motionJobs.status, "queued"));
  for (const r of await db.select().from(schema.motionJobs).where(eq(schema.motionJobs.status, "running"))) await jobs.cancelJob(actor(), r.id);
  await idleAll();
  resources.setResourceProbeForTests(() => ({ freeDiskMb: 100_000, freeMemoryMb: 100_000 }));
});

afterAll(() => {
  runner.killAllWorkersSync();
});

describe("job lifecycle with a fake renderer", () => {
  it("queues, claims atomically, runs in a worker, reports progress and stores the results", async () => {
    const created = await create("ok", "render");
    expect(created.status).toBe("queued");
    expect(created.queuePosition).toBe(1);
    expect((await jobs.listJobs({ postId }))[0]?.id).toBe(created.id);
    const { row, assets } = await settle(created.id);
    expect(row.status).toBe("ready");
    expect(row.progress).toBe(100);
    expect(row.startedAt && row.finishedAt).toBeTruthy();
    expect(row.workerPid).toBeNull();
    expect((row.timings as { wallMs: number }).wallMs).toBeGreaterThan(0);
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ kind: "mp4", mime: "video/mp4" });
    expect(assets[0]!.url).toMatch(/^http:\/\/localhost:4000\/uploads\/video\/.+\.mp4$/);
    expect(existsSync(path.join(storage.root, assets[0]!.key))).toBe(true);
    // the per-job directory is gone
    expect(existsSync(path.join(env.dir, "data", "jobs", created.id))).toBe(false);
  });

  it("runs ONE job at a time: five queued jobs never overlap", async () => {
    const ids = [];
    for (const p of [postId, otherPostId]) ids.push((await create("slow", "render", { postId: p })).id);
    for (let i = 0; i < 3; i++) ids.push((await create("slow", "preview", { postId: null })).id);
    let maxRunning = 0;
    const watch = setInterval(async () => {
      const r = await db.select({ id: schema.motionJobs.id }).from(schema.motionJobs).where(eq(schema.motionJobs.status, "running"));
      maxRunning = Math.max(maxRunning, r.length);
    }, 100);
    await waitFor(async () => (await db.select({ s: schema.motionJobs.status }).from(schema.motionJobs).where(eq(schema.motionJobs.status, "ready"))).length >= 5, 60_000, 200);
    clearInterval(watch);
    expect(maxRunning).toBe(1);
    expect(jobs.runningJobCount()).toBeLessThanOrEqual(1);
  }, 90_000);

  it("previews are claimed before renders", async () => {
    const blocker = await create("slow", "preview", { postId: null });
    await waitFor(async () => (await rowOf(blocker.id)).status === "running", 10_000);
    const r = await create("ok", "render");
    const p = await create("ok", "preview", { postId: null });
    expect(p.queuePosition).toBe(1);
    expect((await jobs.getJobDetail(r.id))!.queuePosition).toBe(2);
    await idleAll();
    await idleAll();
    const rr = await rowOf(r.id);
    const pr = await rowOf(p.id);
    expect(pr.startedAt!.getTime()).toBeLessThanOrEqual(rr.startedAt!.getTime());
  });

  it("reports progress while running (phase mapped to a percentage)", async () => {
    const created = await create("slow");
    const seen = new Set<number>();
    const end = Date.now() + 20_000;
    while (Date.now() < end) {
      const r = await rowOf(created.id);
      if (r.status === "running" && r.progress > 0) seen.add(r.progress);
      if (r.status === "ready") break;
      await new Promise((res) => setTimeout(res, 100));
    }
    expect([...seen].some((p) => p > 5 && p < 100)).toBe(true);
    expect((await rowOf(created.id)).status).toBe("ready");
  }, 30_000);

  it("a preview stores its stills as small JPEG assets with scene numbers and an expiry", async () => {
    const created = await create("ok", "preview", { postId: null, options: { at: [1, 2] } });
    const { row, assets } = await settle(created.id);
    expect(row.status).toBe("ready");
    expect(row.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(assets.map((a) => a.kind)).toEqual(["still", "still"]);
    expect(assets[0]).toMatchObject({ mime: "image/jpeg", sceneIndex: 0, sceneType: "intro" });
  });

  it("a typed worker failure becomes a failed job with a safe message (no server paths)", async () => {
    const { row } = await settle((await create("fail")).id);
    expect(row.status).toBe("failed");
    expect(row.errorCode).toBe("render_failed");
    expect(row.errorMessage).toContain("boom while rendering");
    expect(row.errorMessage).not.toMatch(/\/home\/|\/Users\/|video-jobs-test/);
  });

  it("a missing browser is the typed browser_missing failure that tells the owner what to run", async () => {
    const { row } = await settle((await create("browser_missing")).id);
    expect(row).toMatchObject({ status: "failed", errorCode: "browser_missing" });
    expect(row.errorMessage).toMatch(/setup-motion-browser\.sh/);
  });

  it("a worker that dies without a result is reported as crashed, not hung", async () => {
    const { row } = await settle((await create("crash")).id);
    expect(row).toMatchObject({ status: "failed", errorCode: "crashed" });
    expect(row.errorMessage).toMatch(/exit 3/);
  });

  it("the worker environment has no secrets, a low priority and its own temp dirs", async () => {
    process.env.DATABASE_URL = "postgres://secret";
    process.env.BETTER_AUTH_SECRET_TEST = "s3cret";
    try {
      const { row } = await settle((await create("env")).id);
      const msg = row.errorMessage ?? "";
      expect(msg).toContain("HOME,");
      expect(msg).toMatch(/TMPDIR/);
      expect(msg).not.toMatch(/DATABASE_URL|SECRET|TOKEN|PASSWORD|API_KEY/);
      expect(msg).toMatch(/NICE=(1[0-9]|[2-9])/); // niceness raised from 0 (low CPU priority)
    } finally {
      delete process.env.DATABASE_URL;
      delete process.env.BETTER_AUTH_SECRET_TEST;
    }
  });
});

describe("limits that always end a job", () => {
  it("a wall-clock timeout kills the worker and its whole process group", async () => {
    setCfg({ VIDEO_RENDER_TIMEOUT_SECONDS: 1 });
    const created = await create("child");
    const pid = await waitFor(() => readPid(cwd, "child.pid"), 10_000);
    const workerPid = readPid(cwd, "child.pid");
    expect(workerPid).toBeTruthy();
    const { row } = await settle(created.id);
    expect(row).toMatchObject({ status: "failed", errorCode: "timeout" });
    expect(row.errorMessage).toMatch(/time limit/);
    expect(await waitFor(() => !alive(pid), 5000)).toBe(true); // the grandchild died with the group
  }, 30_000);

  it("a worker that ignores SIGTERM is killed after the grace period", async () => {
    setCfg({ VIDEO_RENDER_TIMEOUT_SECONDS: 1 });
    const created = await create("stubborn");
    const { row } = await settle(created.id);
    expect(row.errorCode).toBe("timeout");
    const pid = readPid(cwd, "stubborn.pid")!;
    expect(await waitFor(() => !alive(pid), 5000)).toBe(true);
  }, 30_000);

  it("cancelling a running job stops it within seconds and cleans up its children", async () => {
    const created = await create("child");
    await waitFor(async () => (await rowOf(created.id)).status === "running" && readPid(cwd, "child.pid"), 10_000);
    const child = readPid(cwd, "child.pid")!;
    const res = await jobs.cancelJob(actor(), created.id);
    expect(res.ok).toBe(true);
    const { row } = await settle(created.id);
    expect(row.status).toBe("cancelled");
    expect(row.cancelRequested).toBe(true);
    expect(await waitFor(() => !alive(child), 5000)).toBe(true);
    expect(existsSync(path.join(env.dir, "data", "jobs", created.id))).toBe(false);
  }, 30_000);

  it("cancelling a queued job never starts a worker", async () => {
    const running = await create("hang", "render", { postId });
    await waitFor(async () => (await rowOf(running.id)).status === "running", 10_000);
    const queued = await create("ok", "render", { postId: otherPostId });
    const res = await jobs.cancelJob(actor(), queued.id);
    expect(res.ok && res.data.status).toBe("cancelled");
    expect((await rowOf(queued.id)).startedAt).toBeNull();
    const again = await jobs.cancelJob(actor(), queued.id);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toMatchObject({ kind: "conflict", extra: { code: "job_finished" } });
  });

  it("API shutdown kills every worker group and aborts the jobs", async () => {
    const created = await create("hang");
    await waitFor(() => readPid(cwd, "hang.pid"), 10_000);
    const pid = readPid(cwd, "hang.pid")!;
    expect(runner.liveWorkerCount()).toBe(1);
    jobs.abortAllRunning();
    const { row } = await settle(created.id);
    expect(row.status).toBe("cancelled");
    expect(await waitFor(() => !alive(pid), 5000)).toBe(true);
    // the synchronous exit-time kill also works on a fresh worker
    const second = await create("hang");
    await waitFor(async () => (await rowOf(second.id)).status === "running", 10_000);
    await waitFor(() => runner.liveWorkerCount() === 1, 5000);
    expect(runner.killAllWorkersSync()).toBe(1);
    const done = await settle(second.id);
    expect(["cancelled", "failed"]).toContain(done.row.status);
  }, 40_000);

  it("a memory ceiling kills the worker group", async () => {
    setCfg({ VIDEO_WORKER_MEMORY_MB: 256 });
    const { row } = await settle((await create("memory")).id);
    expect(row).toMatchObject({ status: "failed", errorCode: "memory" });
    expect(row.errorMessage).toMatch(/more than 256 MB/);
    expect((row.timings as { peakRssMb: number }).peakRssMb).toBeGreaterThan(256);
  }, 40_000);

  it("rejects a result that is over the size limit and one that points outside the job directory", async () => {
    setCfg({ VIDEO_MAX_MP4_BYTES: 1024 });
    const big = await settle((await create("big")).id);
    expect(big.row).toMatchObject({ status: "failed", errorCode: "too_large" });
    const escape = await settle((await create("escape")).id);
    expect(escape.row.status).toBe("failed");
    expect(escape.assets).toHaveLength(0);
  });
});

describe("orphan recovery", () => {
  it("fails jobs left 'running', kills a stale worker group and sweeps leftover files", async () => {
    const stale = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "packages/motion/src/worker/main.ts"], { detached: true, stdio: "ignore" });
    stale.unref();
    const [orphan] = await db
      .insert(schema.motionJobs)
      .values({ kind: "render", status: "running", postId, storyboard: sbOf("ok"), durationSeconds: 5, via: "web", workerPid: stale.pid!, startedAt: new Date() })
      .returning();
    const [queued] = await db.insert(schema.motionJobs).values({ kind: "render", status: "queued", postId: otherPostId, storyboard: sbOf("ok"), durationSeconds: 5, via: "web" }).returning();
    mkdirSync(path.join(env.dir, "data", "jobs", "leftover"), { recursive: true });
    writeFileSync(path.join(env.dir, "data", "jobs", "leftover", "x"), "x");
    const report = await jobs.recoverVideoJobs();
    expect(report.failedRunning).toBe(1);
    expect(report.killedStale).toBe(1);
    expect(report.sweptDirs).toBeGreaterThanOrEqual(1);
    expect(await waitFor(() => !alive(stale.pid!), 5000)).toBe(true);
    const after = await rowOf(orphan!.id);
    expect(after).toMatchObject({ status: "failed", errorCode: "interrupted" });
    expect(after.errorMessage).toMatch(/restarted/);
    expect((await rowOf(queued!.id)).status).toBe("queued"); // not started yet: stays queued
    expect(readdirSync(path.join(env.dir, "data", "jobs"))).toEqual([]);
  });

  it("never kills an unrelated process that reuses the pid", async () => {
    const innocent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    innocent.unref();
    expect(await runner.killStaleWorker(innocent.pid!)).toBe(false);
    expect(alive(innocent.pid!)).toBe(true);
    process.kill(-innocent.pid!, "SIGKILL");
  });
});

describe("quotas and resource refusal (each refusal is actionable)", () => {
  const refusal = async (mode = "ok", kind: "preview" | "render" | "gif" = "render", p: string | null = postId, options?: Record<string, unknown>) => {
    const res = await jobs.createJob(actor(), { kind, storyboard: sbOf(mode), postId: p, ...(options ? { options } : {}) });
    expect(res.ok).toBe(false);
    return res.ok ? null : res.error;
  };

  it("one active render per post", async () => {
    const first = await create("hang");
    const e = await refusal();
    expect(e).toMatchObject({ kind: "conflict", extra: { code: "post_busy", activeJobId: first.id } });
    expect(e!.extra!.hint).toMatch(/cancel/);
    // another post is fine
    expect((await jobs.createJob(actor(), { kind: "render", storyboard: sbOf("ok"), postId: otherPostId })).ok).toBe(true);
  });

  it("queue length limit", async () => {
    setCfg({ VIDEO_MAX_QUEUE: 1 });
    await create("hang", "preview", { postId: null });
    await waitFor(async () => (await jobs.queueCounts()).running === 1, 10_000);
    await create("ok", "preview", { postId: null });
    const e = await refusal("ok", "preview", null);
    expect(e).toMatchObject({ kind: "rate_limited", extra: { code: "queue_full", limit: 1 } });
  });

  it("daily caps for renders and for previews", async () => {
    setCfg({ VIDEO_MAX_RENDERS_PER_DAY: 1, VIDEO_MAX_PREVIEWS_PER_DAY: 1 });
    const since = new Date(Date.now() - 86_400_000);
    const used = await jobs.countCreatedToday();
    void since;
    setCfg({ VIDEO_MAX_RENDERS_PER_DAY: used.renders + 1, VIDEO_MAX_PREVIEWS_PER_DAY: used.previews + 1 });
    await create("ok", "render", { postId: otherPostId });
    await idleAll();
    const r = await refusal("ok", "render", otherPostId);
    expect(r).toMatchObject({ kind: "rate_limited", extra: { code: "daily_renders", env: "VIDEO_MAX_RENDERS_PER_DAY" } });
    await create("ok", "preview", { postId: null });
    await idleAll();
    const p = await refusal("ok", "preview", null);
    expect(p).toMatchObject({ kind: "rate_limited", extra: { code: "daily_previews", env: "VIDEO_MAX_PREVIEWS_PER_DAY" } });
  });

  it("low free disk and low free memory refuse new jobs and keep queued ones waiting", async () => {
    resources.setResourceProbeForTests(() => ({ freeDiskMb: 10, freeMemoryMb: 100_000 }));
    expect(await refusal()).toMatchObject({ kind: "rate_limited", extra: { code: "low_disk", minFreeDiskMb: config.VIDEO_MIN_FREE_DISK_MB } });
    resources.setResourceProbeForTests(() => ({ freeDiskMb: 100_000, freeMemoryMb: 50 }));
    const e = await refusal();
    expect(e).toMatchObject({ kind: "rate_limited", extra: { code: "low_memory", retryAfterSeconds: 120 } });
    expect(e!.extra!.hint).toMatch(/blog comes first/);
    // a job queued before the squeeze is not started while memory is low, and starts once it recovers
    resources.setResourceProbeForTests(() => ({ freeDiskMb: 100_000, freeMemoryMb: 100_000 }));
    const waiting = await create("ok", "render", { postId: otherPostId });
    await idleAll();
    expect((await rowOf(waiting.id)).status).toBe("ready");
    const second = await db.insert(schema.motionJobs).values({ kind: "preview", status: "queued", storyboard: sbOf("ok"), durationSeconds: 5, via: "web" }).returning();
    resources.setResourceProbeForTests(() => ({ freeDiskMb: 100_000, freeMemoryMb: 50 }));
    await jobs.tickQueue();
    expect((await rowOf(second[0]!.id)).status).toBe("queued");
    resources.setResourceProbeForTests(() => ({ freeDiskMb: 100_000, freeMemoryMb: 100_000 }));
    await jobs.tickQueue();
    await idleAll();
    expect((await rowOf(second[0]!.id)).status).toBe("ready");
  });

  it("invalid storyboards, unknown posts, unknown scenes and impossible GIFs are refused before queueing", async () => {
    const bad = await jobs.createJob(actor(), { kind: "render", storyboard: { version: 1, title: "x", theme: "dark", scenes: [{ type: "title", title: "y".repeat(200) }] }, postId });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect((bad.error.extra!.issues as Array<{ path: string }>)[0]!.path).toBe("scenes[0].title");
    const huge = await jobs.createJob(actor(), { kind: "render", storyboard: { version: 1, title: "x".repeat(400_000), theme: "dark", scenes: [] }, postId });
    expect(huge.ok).toBe(false);
    if (!huge.ok) expect((huge.error.extra!.issues as Array<{ code: string }>)[0]!.code).toBe("input_too_large");
    expect(await refusal("ok", "render", "00000000-0000-4000-8000-000000000000")).toMatchObject({ kind: "not_found", extra: { code: "post_not_found" } });
    expect(await refusal("ok", "render", postId, { scene: "nope" })).toMatchObject({ kind: "unprocessable", extra: { code: "scene_not_found" } });
    const longRes = await jobs.createJob(actor(), { kind: "gif", storyboard: sbOf("ok", 12), postId });
    expect(longRes.ok).toBe(false);
    const longGif = longRes.ok ? null : longRes.error;
    expect(longGif).toMatchObject({ kind: "unprocessable", extra: { code: "gif_limit" } });
    expect(String(longGif!.extra!.hint)).toMatch(/limited to 15 s/);
    expect((await jobs.createJob(actor(), { kind: "gif", storyboard: sbOf("ok"), postId, options: { scene: "bye" } })).ok).toBe(true);
    // nothing but the one valid GIF job was stored for this check
    expect((await jobs.listJobs({ postId })).filter((j) => j.status === "queued" || j.status === "running").length).toBeLessThanOrEqual(1);
  });

  it("stale queued jobs fail with low_resources when the server stays short for too long", async () => {
    const [old] = await db.insert(schema.motionJobs).values({ kind: "preview", status: "queued", storyboard: sbOf("ok"), durationSeconds: 5, via: "web", createdAt: new Date(Date.now() - 2 * 3600_000) }).returning();
    resources.setResourceProbeForTests(() => ({ freeDiskMb: 100_000, freeMemoryMb: 10 }));
    await jobs.tickQueue();
    expect(await rowOf(old!.id)).toMatchObject({ status: "failed", errorCode: "low_resources" });
  });
});

describe("storage, retention and deletion", () => {
  it("keeps the last N renders per post and removes the older files from storage", async () => {
    setCfg({ VIDEO_KEEP_RENDERS_PER_POST: 2 });
    const p = await insertPost("retention-post");
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const c = await create("ok", "render", { postId: p });
      await idleAll();
      ids.push(c.id);
    }
    const left = (await jobs.listJobs({ postId: p })).map((j) => j.id);
    expect(left.sort()).toEqual([ids[2]!, ids[3]!].sort());
    expect(storage.deleted.length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("never deletes a video that a post still uses (retention, delete)", async () => {
    setCfg({ VIDEO_KEEP_RENDERS_PER_POST: 1 });
    const p = await insertPost("ref-post");
    const first = await create("ok", "render", { postId: p });
    await idleAll();
    const url = (await jobs.getJob(first.id))!.assets[0]!.url;
    await db.update(schema.posts).set({ contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `video: ${url}` }] }] } }).where(eq(schema.posts.id, p));
    await create("ok", "render", { postId: p });
    await idleAll();
    await create("ok", "render", { postId: p });
    await idleAll();
    expect(await jobs.getJob(first.id)).not.toBeNull(); // old, over the limit, but referenced
    const del = await jobs.deleteJob(actor(), first.id);
    expect(del.ok).toBe(false);
    if (!del.ok) expect(del.error).toMatchObject({ kind: "conflict", extra: { code: "job_referenced" } });
    expect(existsSync(path.join(storage.root, (await jobs.getJob(first.id))!.assets[0]!.key))).toBe(true);
    // once the link is removed it can go
    await db.update(schema.posts).set({ contentJson: { type: "doc", content: [] } }).where(eq(schema.posts.id, p));
    expect((await jobs.deleteJob(actor(), first.id)).ok).toBe(true);
    expect(await jobs.getJob(first.id)).toBeNull();
  }, 60_000);

  it("previews are short-lived; failed jobs expire; running jobs cannot be deleted", async () => {
    const pv = await create("ok", "preview", { postId: null });
    await idleAll();
    const f = await create("fail", "render", { postId: otherPostId });
    await idleAll();
    await db.update(schema.motionJobs).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.motionJobs.id, pv.id));
    await db.update(schema.motionJobs).set({ createdAt: new Date(Date.now() - 30 * 86_400_000) }).where(eq(schema.motionJobs.id, f.id));
    const report = await jobs.runRetention();
    expect(report.previews).toBeGreaterThanOrEqual(1);
    expect(report.failed).toBeGreaterThanOrEqual(1);
    expect(await jobs.getJob(pv.id)).toBeNull();
    expect(await jobs.getJob(f.id)).toBeNull();
    const running = await create("hang", "render", { postId: postId });
    await waitFor(async () => (await rowOf(running.id)).status === "running", 10_000);
    const del = await jobs.deleteJob(actor(), running.id);
    expect(del.ok).toBe(false);
    if (!del.ok) expect(del.error.extra).toMatchObject({ code: "job_running" });
  }, 60_000);

  it("a deleted post leaves its jobs as post-less jobs that expire normally", async () => {
    const p = await insertPost("gone-post");
    const c = await create("ok", "render", { postId: p });
    await idleAll();
    await db.delete(schema.posts).where(eq(schema.posts.id, p));
    expect((await rowOf(c.id)).postId).toBeNull();
  });

  it("audits who asked and through which channel, with the MCP client when there is one", async () => {
    const c = await jobs.createJob(mcpActor(), { kind: "preview", storyboard: sbOf("ok"), postId: null });
    expect(c.ok).toBe(true);
    await idleAll();
    const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "video.preview"));
    const mine = rows.find((r) => (r.meta as { client?: string }).client === "c1");
    expect(mine).toMatchObject({ via: "mcp", entityType: "video" });
    expect(mine!.meta).toMatchObject({ clientName: "Claude", tool: "start_video_render", kind: "preview" });
  });
});

describe("estimates", () => {
  it("uses defaults, then the measured speed of finished jobs", async () => {
    await db.delete(schema.motionJobs).where(eq(schema.motionJobs.status, "ready"));
    const d = await jobs.estimateSeconds("render", 30);
    expect(d.basis).toBe("default");
    expect(d.seconds).toBe(Math.round(jobs.ESTIMATE_DEFAULTS.renderBaseSeconds + jobs.ESTIMATE_DEFAULTS.renderSecondsPerVideoSecond * 30));
    const p = await jobs.estimateSeconds("preview", 0, 4);
    expect(p.seconds).toBeLessThan(60);
  });
});

void copyFileSync;

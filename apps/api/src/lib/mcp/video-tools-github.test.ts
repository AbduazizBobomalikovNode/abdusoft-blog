import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD, type TestUser } from "../../test/auth-test-helpers.js";
import { callTool, connect, mcpCall, type Json } from "../../test/mcp-harness.js";
import { sbOf } from "../../test/video-harness.js";
import { githubDouble, jpeg } from "../../test/video-github-harness.js";

const env = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/video-tools-gh-test-${process.pid}`;
  process.env.VIDEO_ENABLED = "true";
  process.env.VIDEO_RUNNER = "github";
  process.env.VIDEO_RUNNER_SECRET = "g".repeat(48);
  process.env.VIDEO_GITHUB_TOKEN = "github_pat_toolstest";
  process.env.VIDEO_GITHUB_REPO = "owner/blog";
  process.env.VIDEO_DATA_DIR = `${dir}/data`;
  process.env.VIDEO_MAX_RUNNING = "4";
  process.env.VIDEO_MAX_RENDERS_PER_DAY = "0";
  process.env.VIDEO_MAX_PREVIEWS_PER_DAY = "0";
  process.env.VIDEO_MAX_QUEUE = "50";
  process.env.MCP_ENABLED = "true";
  process.env.MCP_WRITE_TOOLS_ENABLED = "true";
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
  process.env.MCP_WRITE_LIMIT_DESTRUCTIVE_PER_DAY = "0";
  return { dir };
});

const storage = vi.hoisted(() => ({ root: "" }));
vi.mock("../media/store.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../media/store.js")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  return {
    ...real,
    storeFileFromPath: async (input: { path: string; ext: string }) => {
      const key = `video/${Math.random().toString(36).slice(2)}.${input.ext}`;
      const dest = nodePath.join(storage.root, key);
      fs.mkdirSync(nodePath.dirname(dest), { recursive: true });
      fs.copyFileSync(input.path, dest);
      return { key, url: `http://localhost:4000/uploads/${key}`, size: fs.statSync(dest).size };
    },
    deleteStoredFile: async (key: string) => fs.rmSync(nodePath.join(storage.root, key), { force: true }),
    readStoredFile: async (key: string) => fs.readFileSync(nodePath.join(storage.root, key)),
  };
});

const SCOPES = "blog:read posts:write video:render offline_access";
let app: Hono;
let admin: TestUser;
let full: string;
let db: typeof import("../../db/index.js").db;
let s: typeof import("../../db/schema.js");
let jobs: typeof import("../video/jobs.js");
let tokens: typeof import("../video/runner-token.js");
let postN = 0;
const creds = () => ({ email: admin.email, password: TEST_USER_PASSWORD });
const call = (name: string, args: Record<string, unknown> = {}) => callTool(app, full, name, args);
const newPost = async (): Promise<string> => {
  postN++;
  const [row] = await db.insert(s.posts).values({ slug: `ghtool-${postN}`, title: `p${postN}`, contentJson: { type: "doc", content: [] }, contentHtml: "", toc: [], status: "draft" } as never).returning();
  return (row as { id: string }).id;
};
const runner = (id: string, method: string, p: string, init: { json?: unknown; body?: Buffer } = {}) =>
  app.request(`/runner/video/jobs/${id}${p}`, {
    method,
    headers: { authorization: `Bearer ${tokens.runnerTokenFor("g".repeat(48), id)}`, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : init.body ? { body: init.body as never } : {}),
  });

beforeAll(async () => {
  storage.root = path.join(env.dir, "storage");
  mkdirSync(storage.root, { recursive: true });
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  ({ db } = await import("../../db/index.js"));
  s = await import("../../db/schema.js");
  jobs = await import("../video/jobs.js");
  tokens = await import("../video/runner-token.js");
  const gh = await import("../video/github.js");
  gh.setGithubFetchForTests(githubDouble().fetchFn);
  (await import("../video/resources.js")).setResourceProbeForTests(() => ({ freeDiskMb: 100_000, freeMemoryMb: 100_000 }));
  admin = await createTestUser({ role: "admin" });
  full = (await connect(app, creds(), { scope: SCOPES })).tokens.access_token;
});

describe("preview_storyboard waits a bounded time and hands over to get_video_job", () => {
  it("answers 'still rendering' with the job id, the stage and the instruction; get_video_job later returns the frames as images", async () => {
    jobs.setPreviewWaitForTests(1500);
    try {
      const t0 = Date.now();
      const r = await call("preview_storyboard", { storyboard: sbOf("ok", 3) });
      expect(Date.now() - t0).toBeLessThan(8000);
      expect(r.isError).toBe(false);
      expect(r.json).toMatchObject({ stillRendering: true, status: "running" });
      expect(r.json.stage).toBe("waiting_runner");
      expect(r.json.next).toContain(`get_video_job with job_id "${r.json.jobId}"`);
      const id = r.json.jobId as string;
      // the job is not ready yet: get_video_job says so and attaches no images
      const pending = await mcpCall(app, full, "tools/call", { name: "get_video_job", arguments: { job_id: id } });
      expect((pending.body.result.content as Json[]).filter((c) => c.type === "image")).toHaveLength(0);
      // the runner finishes the job through the real endpoints
      expect((await runner(id, "POST", "/claim", { json: { runId: "55", attempt: 1 } })).status).toBe(200);
      const img = await jpeg(480, 270);
      for (const n of [1, 2, 3]) {
        expect((await runner(id, "PUT", `/files/still-${n}.jpg/parts/0`, { body: img })).status).toBe(200);
        expect((await runner(id, "POST", `/files/still-${n}.jpg/complete`, { json: { parts: 1, bytes: img.length } })).status).toBe(200);
      }
      const done = await runner(id, "POST", "/complete", { json: { kind: "preview", stills: [1, 2, 3].map((n) => ({ name: `still-${n}.jpg`, seconds: n, scene: n - 1, sceneType: "bullets" })), timings: { renderMs: 10, uploadMs: 5 } } });
      expect(done.status).toBe(200);
      const later = await mcpCall(app, full, "tools/call", { name: "get_video_job", arguments: { job_id: id } });
      const content = later.body.result.content as Json[];
      expect(JSON.parse(content[0].text).job.status).toBe("ready");
      expect(content.filter((c) => c.type === "image")).toHaveLength(3);
    } finally {
      jobs.setPreviewWaitForTests(null);
    }
  }, 60_000);

  it("the default wait is VIDEO_PREVIEW_WAIT_SECONDS (40 s), always below the proxy's 60 s", () => {
    expect(jobs.previewWaitMs()).toBe(40_000);
  });

  it("a hosted preview never answers 'busy': it queues behind other jobs", async () => {
    jobs.setPreviewWaitForTests(300);
    try {
      const a = await call("preview_storyboard", { storyboard: sbOf("ok") });
      const b = await call("preview_storyboard", { storyboard: sbOf("ok") });
      expect(a.isError).toBe(false);
      expect(b.isError).toBe(false);
      expect(b.json.stillRendering).toBe(true);
    } finally {
      jobs.setPreviewWaitForTests(null);
    }
  });
});

describe("start_video_render with the github backend", () => {
  it("validates ONCE per request (the API never repeats it for a job that was just validated)", async () => {
    const motion = await import("../video/motion.js");
    const api = await motion.loadMotion();
    const spy = vi.spyOn(api, "validateStoryboardJson");
    try {
      const r = await call("start_video_render", { post_id: await newPost(), storyboard: sbOf("ok", 4) });
      expect(r.isError).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockClear();
      const p = await call("preview_storyboard", { storyboard: sbOf("ok", 4) });
      expect(p.isError).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("a storyboard that is a key flood is refused by the structural pre-check in milliseconds", async () => {
    const flood: Record<string, unknown> = { version: 1, title: "x", scenes: [{ type: "title", title: "x" }] };
    for (let i = 0; i < 12_000; i++) flood[`k${i}`] = i;
    const t0 = Date.now();
    const r = await call("start_video_render", { post_id: await newPost(), storyboard: flood });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.json)).toContain("structure_too_large");
  });

  it("dry_run reports the backend, the hosted-runner start-up note and no browser", async () => {
    const r = await call("start_video_render", { post_id: await newPost(), storyboard: sbOf("ok", 4), dry_run: true });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ dryRun: true, wouldQueue: true, runner: "github", githubConfigured: true });
    expect(r.json.estimate.note).toMatch(/roughly a minute/);
    expect(r.json.browserInstalled).toBeUndefined();
  });

  it("get_video_status shows what is configured and never a value", async () => {
    const r = await call("get_video_status");
    expect(r.json).toMatchObject({ runner: "github", browser: null, github: { tokenConfigured: true, secretConfigured: true, repoConfigured: true, repo: "owner/blog" } });
    expect(JSON.stringify(r.json)).not.toContain("toolstest");
    expect(JSON.stringify(r.json)).not.toContain("gggggggg");
  });
});

describe("get_video_job stays inside the connector's result limit", () => {
  async function readyPreview(frames: number, bytesEach: number, storyboardPad = 0): Promise<string> {
    const [job] = await db
      .insert(s.motionJobs)
      .values({ kind: "preview", status: "ready", storyboard: { ...sbOf("budget", 4), pad: "p".repeat(storyboardPad) }, durationSeconds: 12, via: "mcp", runner: "github", finishedAt: new Date(), progress: 100 } as never)
      .returning();
    const id = (job as { id: string }).id;
    for (let i = 0; i < frames; i++) {
      const key = `video/${id}-${i}.jpg`;
      const file = path.join(storage.root, key);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, Buffer.alloc(bytesEach, i + 1));
      await db.insert(s.motionAssets).values({ jobId: id, kind: "still", key, url: `http://localhost:4000/uploads/${key}`, mime: "image/jpeg", size: bytesEach, width: 480, height: 270, seconds: i, sceneIndex: i, sceneType: "bullets" } as never);
    }
    return id;
  }
  const total = (content: Json[]): number => content.reduce((n, c) => n + (c.type === "image" ? (c.data as string).length : (c.text as string).length), 0);

  it("images get 'limit minus text minus margin'; the rest is paged through image_offset; every page fits", async () => {
    const who = await call("whoami");
    const limit = who.json.limits.resultMaxChars as number;
    const id = await readyPreview(12, 22_000);
    let offset = 0;
    let seen = 0;
    for (let page = 0; page < 12 && offset !== null; page++) {
      const r = await mcpCall(app, full, "tools/call", { name: "get_video_job", arguments: { job_id: id, image_offset: offset } });
      const content = r.body.result.content as Json[];
      expect(total(content), `page ${page}`).toBeLessThanOrEqual(limit);
      const body = JSON.parse(content[0].text);
      const n = content.filter((c) => c.type === "image").length;
      expect(n).toBeGreaterThan(0);
      seen += n;
      offset = body.moreImagesFrom ?? null;
    }
    expect(seen).toBe(12);
    expect(offset).toBeNull();
  });

  it("a long storyboard echo cannot push the result over the limit: it is omitted with a note, and the images shrink accordingly", async () => {
    const who = await call("whoami");
    const limit = who.json.limits.resultMaxChars as number;
    const id = await readyPreview(4, 20_000, 60_000);
    const r = await mcpCall(app, full, "tools/call", { name: "get_video_job", arguments: { job_id: id, include_storyboard: true } });
    const content = r.body.result.content as Json[];
    expect(total(content)).toBeLessThanOrEqual(limit);
    const body = JSON.parse(content[0].text);
    expect(body.storyboard).toBeUndefined();
    expect(body.storyboardOmitted).toMatchObject({ limitChars: 24000 });
    // a short storyboard is echoed
    const small = await readyPreview(2, 5000);
    const r2 = await mcpCall(app, full, "tools/call", { name: "get_video_job", arguments: { job_id: small, include_storyboard: true } });
    expect(JSON.parse((r2.body.result.content as Json[])[0].text).storyboard.title).toBe("budget");
  });

  it("a single frame bigger than the whole budget is skipped (not inlined) instead of breaking the result", async () => {
    const who = await call("whoami");
    const limit = who.json.limits.resultMaxChars as number;
    const id = await readyPreview(2, Math.ceil(limit * 0.9));
    const r = await mcpCall(app, full, "tools/call", { name: "get_video_job", arguments: { job_id: id } });
    const content = r.body.result.content as Json[];
    expect(total(content)).toBeLessThanOrEqual(limit);
    expect(JSON.parse(content[0].text).frames.every((f: Json) => f.inlined === false)).toBe(true);
  });
});

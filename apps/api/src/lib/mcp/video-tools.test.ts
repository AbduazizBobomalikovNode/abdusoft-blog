import { mkdirSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD, type TestUser } from "../../test/auth-test-helpers.js";
import { API, authorize, callTool, connect, exchangeCode, mcpCall, registerClient, type Json } from "../../test/mcp-harness.js";
import { FAKE_WORKER, sbOf, waitFor } from "../../test/video-harness.js";

const env = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/video-tools-test-${process.pid}`;
  process.env.VIDEO_ENABLED = "true";
  process.env.VIDEO_RUNNER = "local";
  process.env.VIDEO_DATA_DIR = `${dir}/data`;
  process.env.MCP_ENABLED = "true";
  process.env.MCP_WRITE_TOOLS_ENABLED = "true";
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
  process.env.MCP_WRITE_LIMIT_DESTRUCTIVE_PER_DAY = "0";
  process.env.VIDEO_MAX_RENDERS_PER_DAY = "0";
  process.env.VIDEO_MAX_PREVIEWS_PER_DAY = "0";
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
let staff: TestUser;
let full: string;
let readOnly: string;
let postId: string;
let db: typeof import("../../db/index.js").db;
let s: typeof import("../../db/schema.js");
let jobs: typeof import("../video/jobs.js");
const creds = () => ({ email: admin.email, password: TEST_USER_PASSWORD });
const call = (tok: string, name: string, args: Record<string, unknown> = {}) => callTool(app, tok, name, args);
const web = (p: string, init: { method?: string; as?: TestUser } = {}) => app.request(`${API}${p}`, { method: init.method ?? "GET", headers: { cookie: (init.as ?? admin).cookie } });
const idle = () =>
  waitFor(async () => {
    const c = await jobs.queueCounts();
    return c.running === 0 && c.queued === 0 && jobs.runningJobCount() === 0;
  }, 45_000, 100);

async function newPost(slug: string): Promise<string> {
  const [row] = await db.insert(s.posts).values({ slug, title: slug, contentJson: { type: "doc", content: [] }, contentHtml: "", toc: [], status: "draft" } as never).returning();
  return (row as { id: string }).id;
}

beforeAll(async () => {
  storage.root = path.join(env.dir, "storage");
  mkdirSync(storage.root, { recursive: true });
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  ({ db } = await import("../../db/index.js"));
  s = await import("../../db/schema.js");
  jobs = await import("../video/jobs.js");
  const runner = await import("../video/runner.js");
  const resources = await import("../video/resources.js");
  (await import("../video/local-preflight.js")).setPreflightForTests({ ok: true, hint: "", at: null });
  const cwd = path.join(env.dir, "cwd");
  mkdirSync(cwd, { recursive: true });
  runner.setWorkerLaunchForTests((_spec, specFile) => ({ command: process.execPath, args: [FAKE_WORKER, specFile], cwd }));
  runner.setKillGraceForTests(300);
  jobs.setKillMarginForTests(500);
  resources.setResourceProbeForTests(() => ({ freeDiskMb: 100_000, freeMemoryMb: 100_000 }));
  const status = await import("../video/status.js");
  status.setBrowserProbeForTests(async () => ({ installed: true, path: "/fake/chrome", hint: null }));
  admin = await createTestUser({ role: "admin" });
  staff = await createTestUser({ role: "staff" });
  full = (await connect(app, creds(), { scope: SCOPES })).tokens.access_token;
  readOnly = (await connect(app, creds(), { scope: "blog:read offline_access" })).tokens.access_token;
  postId = await newPost("video-tools-post");
});

describe("permission and consent", () => {
  it("tools/list shows the nine video tools; a read-only connection is refused the render tools with the missing scope named", async () => {
    const tools = ((await mcpCall(app, full, "tools/list")).body.result.tools as Json[]).map((t) => t.name);
    for (const n of ["get_storyboard_guide", "validate_storyboard", "preview_storyboard", "start_video_render", "get_video_job", "list_post_videos", "get_video_status", "cancel_video_job", "delete_video_job"]) expect(tools).toContain(n);
    const r = await call(readOnly, "start_video_render", { post_id: postId, storyboard: sbOf("ok") });
    expect(r.isError).toBe(true);
    expect(r.json.error).toMatchObject({ code: "insufficient_scope", requiredScope: "video:render" });
    expect((await call(readOnly, "preview_storyboard", { storyboard: sbOf("ok") })).json.error.code).toBe("insufficient_scope");
    // the read tools work with blog:read only
    expect((await call(readOnly, "validate_storyboard", { storyboard: sbOf("ok") })).isError).toBe(false);
  });

  it("video rendering is a new permission: an existing approval never gains it silently, the consent page comes again", async () => {
    const clientId = await registerClient(app);
    const first = await connect(app, creds(), { clientId, scope: "blog:read offline_access" });
    const again = await authorize(app, { clientId, ...creds(), scope: SCOPES, browser: first.authorize.browser, stopAtConsent: true });
    expect(again.steps).toContain("consent-page");
    expect(again.consentUrl).toContain("video%3Arender");
    const oldWho = await call(first.tokens.access_token, "whoami");
    expect(oldWho.json.grantedScopes.map((g: Json) => g.id)).toEqual(["blog:read"]);
    const upgraded = await authorize(app, { clientId, ...creds(), scope: SCOPES, browser: first.authorize.browser });
    const tok = await exchangeCode(app, upgraded);
    expect(tok.body.scope.split(" ")).toContain("video:render");
  });

  it("whoami lists the video permission with its English description", async () => {
    const who = await call(full, "whoami");
    expect(who.json.grantedScopes.map((g: Json) => g.id)).toContain("video:render");
  });
});

describe("read tools", () => {
  it("get_storyboard_guide: overview (limits, 13 scene types, variants, presets, a valid example), scene and schema sections", async () => {
    const g = (await call(full, "get_storyboard_guide")).json;
    expect(g.limits).toMatchObject({ maxTotalSeconds: 60, maxScenes: 16, gif: { maxSeconds: 15 } });
    expect(g.sceneTypes).toHaveLength(13);
    expect(g.introAndClosingVariants).toHaveLength(6);
    expect(g.stylePresets).toEqual(["default", "vivid", "blueprint", "neon"]);
    expect(g.workflow.join(" ")).toMatch(/validate_storyboard/);
    expect((await call(full, "validate_storyboard", { storyboard: g.example })).json.valid).toBe(true);
    const scene = (await call(full, "get_storyboard_guide", { section: "scene", scene_type: "code" })).json;
    expect(scene.jsonSchema.properties.code.maxLength).toBe(2030);
    expect((await call(full, "get_storyboard_guide", { section: "scene", scene_type: "nope" })).json.error.code).toBe("invalid_input");
    const schema = await call(full, "get_storyboard_guide", { section: "schema" });
    expect(schema.json.jsonSchema.properties.scenes).toBeTruthy();
    expect(schema.text.length).toBeLessThan(100_000);
  });

  it("validate_storyboard: valid -> timeline and estimate; invalid -> precise issues, never an exception", async () => {
    const ok = (await call(full, "validate_storyboard", { storyboard: sbOf("ok", 4) })).json;
    expect(ok.valid).toBe(true);
    expect(ok.timeline.scenes).toHaveLength(4);
    expect(ok.timeline.scenes[0]).toMatchObject({ position: 1, id: "intro", type: "intro" });
    expect(ok.estimate.renderSeconds).toBeGreaterThan(0);
    expect(ok.untrusted).toBe(true);
    const bad = await call(full, "validate_storyboard", { storyboard: { version: 1, title: "x", theme: "dark", scenes: [{ type: "code", language: "typescript", code: "a".repeat(100_000) }, { type: "title", id: "q", title: "t" }, { type: "title", id: "q", title: "u" }] } });
    expect(bad.isError).toBe(false);
    expect(bad.json.valid).toBe(false);
    const paths = bad.json.issues.map((i: Json) => i.path);
    expect(paths).toContain("scenes[0].code");
    expect(paths).toContain("scenes[2].id");
    expect(bad.json.issues[0].fix ?? bad.json.issues[0].message).toBeTruthy();
    expect((await call(full, "validate_storyboard", { storyboard: { nonsense: true } })).json.valid).toBe(false);
  });
});

describe("preview_storyboard", () => {
  it("answers synchronously with IMAGE results plus a text summary", async () => {
    const res = await mcpCall(app, full, "tools/call", { name: "preview_storyboard", arguments: { storyboard: sbOf("ok", 4) } });
    const content = res.body.result.content as Json[];
    expect(res.body.result.isError).toBeUndefined();
    const text = JSON.parse(content[0].text);
    const images = content.filter((c) => c.type === "image");
    expect(images).toHaveLength(4);
    expect(images[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect(Buffer.from(images[0].data, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(text.summary).toMatch(/4 of 4 preview frame/);
    expect(text.frames[0]).toMatchObject({ scene: 1, sceneType: "intro", inlined: true });
    expect(JSON.stringify(content).length).toBeLessThan(150_000);
    await idle();
  });

  it("with `at` only the asked seconds are captured (max 4)", async () => {
    const res = await call(full, "preview_storyboard", { storyboard: sbOf("ok", 5), at: [1, 2] });
    expect(res.json.frames).toHaveLength(2);
    expect((await call(full, "preview_storyboard", { storyboard: sbOf("ok"), at: [1, 2, 3, 4, 5] })).isError).toBe(true);
    await idle();
  });

  it("does not wait when another job is running: 'busy' with the queue state, instantly", async () => {
    const hog = (await jobs.createJob({ userId: admin.id, role: "admin", via: "web" }, { kind: "preview", storyboard: sbOf("hang"), postId: null }));
    expect(hog.ok).toBe(true);
    const t0 = Date.now();
    const r = await call(full, "preview_storyboard", { storyboard: sbOf("ok") });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.isError).toBe(true);
    expect(r.json.error).toMatchObject({ code: "rate_limited", busy: true, retryAfterSeconds: 60 });
    expect(r.json.error.queue.running + r.json.error.queue.queued).toBeGreaterThanOrEqual(1);
    if (hog.ok) await jobs.cancelJob({ userId: admin.id, role: "admin", via: "web" }, hog.data.id);
    await idle();
  });

  it("stays well inside the 240 s tool budget: the wait is bounded and a slow job is returned as 'still rendering'", async () => {
    expect(jobs.previewWaitMs()).toBeLessThan(240_000 - 20_000);
    expect(jobs.PREVIEW_MAX_SECONDS * 1000 + 30_000).toBeLessThan(240_000);
    jobs.setPreviewWaitForTests(1200);
    try {
      const r = await call(full, "preview_storyboard", { storyboard: sbOf("slow") });
      expect(r.isError).toBe(false);
      expect(r.json.status).toMatch(/queued|running/);
      expect(r.json.summary).toMatch(/get_video_job/);
      await idle();
      const later = await mcpCall(app, full, "tools/call", { name: "get_video_job", arguments: { job_id: r.json.jobId } });
      const content = later.body.result.content as Json[];
      expect(JSON.parse(content[0].text).job.status).toBe("ready");
      expect(content.filter((c) => c.type === "image").length).toBe(3);
    } finally {
      jobs.setPreviewWaitForTests(null);
    }
  }, 30_000);

  it("a failing preview is an actionable error, not a crash", async () => {
    const r = await call(full, "preview_storyboard", { storyboard: sbOf("browser_missing") });
    expect(r.isError).toBe(true);
    expect(r.json.error.hint).toMatch(/setup-motion-browser/);
    const invalid = await call(full, "preview_storyboard", { storyboard: { version: 1 } });
    expect(invalid.isError).toBe(true);
    expect(invalid.json.error.issues[0].path).toBeTruthy();
    await idle();
  });
});

describe("render, jobs, cancel, delete", () => {
  it("start_video_render dry_run: validation, estimate, quota/queue state; nothing is queued", async () => {
    const before = (await jobs.listJobs({ postId })).length;
    const r = await call(full, "start_video_render", { post_id: postId, storyboard: sbOf("ok", 4), dry_run: true });
    expect(r.json).toMatchObject({ ok: true, dryRun: true, wouldQueue: true, format: "mp4", browserInstalled: true });
    expect(r.json.estimate.renderSeconds).toBeGreaterThan(0);
    expect(r.json.timeline.scenes).toHaveLength(4);
    expect((await jobs.listJobs({ postId })).length).toBe(before);
  });

  it("returns a job id at once, then progress and result URLs through get_video_job; audited with via mcp", async () => {
    const r = await call(full, "start_video_render", { post_id: postId, storyboard: sbOf("slow"), idempotency_key: "render-key-0001" });
    expect(r.isError, r.text).toBe(false);
    expect(r.json.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(["queued", "running"]).toContain(r.json.status);
    const replay = await call(full, "start_video_render", { post_id: postId, storyboard: sbOf("slow"), idempotency_key: "render-key-0001" });
    expect(replay.json.idempotentReplay).toBe(true);
    expect(replay.json.jobId).toBe(r.json.jobId);
    const mid = (await call(full, "get_video_job", { job_id: r.json.jobId })).json;
    expect(["queued", "running"]).toContain(mid.job.status);
    expect(mid.untrusted).toBe(true);
    await idle();
    const done = (await call(full, "get_video_job", { job_id: r.json.jobId, include_storyboard: true })).json;
    expect(done.job.status).toBe("ready");
    expect(done.job.assets[0]).toMatchObject({ kind: "mp4", mime: "video/mp4" });
    expect(done.job.assets[0].url).toMatch(/\/uploads\/video\/.+\.mp4$/);
    expect(done.storyboard.title).toBe("slow");
    expect(done.untrustedFields).toContain("storyboard");
    const audit = (await db.select().from(s.auditLog).where(eq(s.auditLog.action, "video.render"))).filter((a) => a.via === "mcp");
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0]!.meta).toMatchObject({ tool: "start_video_render", kind: "render" });
    const list = (await call(full, "list_post_videos", { post_id: postId })).json;
    expect(list.jobs[0]).toMatchObject({ id: r.json.jobId, status: "ready" });
    expect(list.jobs[0].urls[0].kind).toBe("mp4");
    expect(list.untrusted).toBe(true);
  }, 40_000);

  it("a GIF is one short scene: a clip over 15 s is refused with the fix; format mp4 rejects gif-only args", async () => {
    const long = await call(full, "start_video_render", { post_id: postId, storyboard: sbOf("ok", 12), format: "gif" });
    expect(long.isError).toBe(true);
    expect(long.json.error.message).toMatch(/limited to 15 s/);
    const mixed = await call(full, "start_video_render", { post_id: postId, storyboard: sbOf("ok"), loop: true });
    expect(mixed.json.error.code).toBe("invalid_input");
    const gif = await call(full, "start_video_render", { post_id: postId, storyboard: sbOf("ok"), format: "gif", scene: "bye" });
    expect(gif.isError, gif.text).toBe(false);
    await idle();
    expect((await call(full, "get_video_job", { job_id: gif.json.jobId })).json.job.assets[0]).toMatchObject({ kind: "gif", mime: "image/gif" });
  });

  it("one active render per post, with the actionable conflict; an unknown post is not_found; an invalid storyboard queues nothing", async () => {
    const first = await call(full, "start_video_render", { post_id: postId, storyboard: sbOf("hang") });
    expect(first.isError, first.text).toBe(false);
    const second = await call(full, "start_video_render", { post_id: postId, storyboard: sbOf("ok") });
    expect(second.json.error).toMatchObject({ code: "conflict", reason: "post_busy", activeJobId: first.json.jobId });
    expect((await call(full, "start_video_render", { post_id: "00000000-0000-4000-8000-000000000000", storyboard: sbOf("ok") })).json.error.code).toBe("not_found");
    const bad = await call(full, "start_video_render", { post_id: postId, storyboard: { version: 1, title: "x", theme: "dark", scenes: [] } });
    expect(bad.json.error.issues.length).toBeGreaterThan(0);
    const cancelled = await call(full, "cancel_video_job", { job_id: first.json.jobId });
    expect(cancelled.isError, cancelled.text).toBe(false);
    await idle();
    expect((await call(full, "get_video_job", { job_id: first.json.jobId })).json.job.status).toBe("cancelled");
    expect((await call(full, "cancel_video_job", { job_id: first.json.jobId })).json.error.code).toBe("conflict");
  }, 30_000);

  it("get_video_status shows the browser, queue and quotas; delete removes the files but refuses a referenced one", async () => {
    const st = (await call(full, "get_video_status")).json;
    expect(st).toMatchObject({ enabled: true, browser: { installed: true }, queue: { maxRunning: 1 } });
    const made = await call(full, "start_video_render", { post_id: await newPost("delete-post"), storyboard: sbOf("ok") });
    await idle();
    const job = (await call(full, "get_video_job", { job_id: made.json.jobId })).json.job;
    const url = job.assets[0].url as string;
    const post = await newPost("ref-post");
    await db.update(s.posts).set({ coverUrl: url }).where(eq(s.posts.id, post));
    const refused = await call(full, "delete_video_job", { job_id: made.json.jobId });
    expect(refused.json.error).toMatchObject({ code: "conflict", reason: "job_referenced" });
    expect(refused.json.error.usedBy).toHaveLength(1);
    await db.update(s.posts).set({ coverUrl: null }).where(eq(s.posts.id, post));
    expect((await call(full, "delete_video_job", { job_id: made.json.jobId })).isError).toBe(false);
    expect((await call(full, "get_video_job", { job_id: made.json.jobId })).json.error.code).toBe("not_found");
  }, 30_000);
});

describe("admin panel routes", () => {
  it("status, list, detail (with the storyboard JSON), cancel and delete; staff and anonymous are refused", async () => {
    const p = await newPost("route-post");
    const made = await call(full, "start_video_render", { post_id: p, storyboard: sbOf("ok") });
    await idle();
    const id = made.json.jobId as string;
    expect(((await (await web("/admin/video/status")).json()) as Json).browser.installed).toBe(true);
    const list = (await (await web(`/admin/video/jobs?postId=${p}`)).json()) as Json;
    expect(list.items[0]).toMatchObject({ id, status: "ready", via: "mcp", clientName: "Claude" });
    const detail = (await (await web(`/admin/video/jobs/${id}`)).json()) as Json;
    expect(detail.storyboard.title).toBe("ok");
    expect(detail.assets[0].url).toMatch(/\.mp4$/);
    expect((await web("/admin/video/jobs/not-a-uuid")).status).toBe(404);
    expect((await web("/admin/video/jobs/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await web("/admin/video/status", { as: staff })).status).toBe(403);
    expect((await app.request(`${API}/admin/video/status`)).status).toBe(401);
    expect((await web(`/admin/video/jobs/${id}/cancel`, { method: "POST" })).status).toBe(409);
    expect((await web(`/admin/video/jobs/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await web(`/admin/video/jobs/${id}`)).status).toBe(404);
    const audit = await db.select().from(s.auditLog).where(eq(s.auditLog.action, "video.delete"));
    expect(audit.some((a) => a.via === "web")).toBe(true);
  });
});

import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { sbOf, waitFor } from "../../test/video-harness.js";
import { githubDouble, gif, jpeg, mp4, sha } from "../../test/video-github-harness.js";

const SECRET = "t".repeat(48);
const env = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/video-gh-test-${process.pid}`;
  process.env.VIDEO_ENABLED = "true";
  process.env.VIDEO_RUNNER = "github";
  process.env.VIDEO_RUNNER_SECRET = "t".repeat(48);
  process.env.VIDEO_GITHUB_TOKEN = "github_pat_TESTTOKEN_do_not_leak";
  process.env.VIDEO_GITHUB_REPO = "owner/blog";
  process.env.VIDEO_DATA_DIR = `${dir}/data`;
  process.env.VIDEO_MAX_RUNNING = "4";
  process.env.VIDEO_MAX_RENDERS_PER_DAY = "0";
  process.env.VIDEO_MAX_PREVIEWS_PER_DAY = "0";
  process.env.VIDEO_MAX_QUEUE = "50";
  return { dir };
});

const storage = vi.hoisted(() => ({ root: "", deleted: [] as string[], failNext: false }));
vi.mock("../media/store.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../media/store.js")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  return {
    ...real,
    storeFileFromPath: async (input: { path: string; ext: string }) => {
      if (storage.failNext) {
        storage.failNext = false;
        throw new Error("storage is down");
      }
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
    listStoredObjects: async (prefix: string) => {
      const root = nodePath.join(storage.root, prefix);
      const out: Array<{ key: string; modifiedAt: Date }> = [];
      const walk = (d: string): void => {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = nodePath.join(d, e.name);
          if (e.isDirectory()) walk(full);
          else out.push({ key: nodePath.relative(storage.root, full), modifiedAt: fs.statSync(full).mtime });
        }
      };
      walk(root);
      return out;
    },
  };
});

let app: Hono;
let jobs: typeof import("./jobs.js");
let gh: typeof import("./github.js");
let rg: typeof import("./runner-github.js");
let uploads: typeof import("./uploads.js");
let tokens: typeof import("./runner-token.js");
let db: typeof import("../../db/index.js").db;
let s: typeof import("../../db/schema.js");
let config: Record<string, number | string | boolean>;
let userId: string;
let postN = 0;
const saved: Record<string, unknown> = {};
const setCfg = (patch: Record<string, number | string | boolean>) => {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in saved)) saved[k] = config[k];
    config[k] = v;
  }
};
const actor = () => ({ userId, role: "admin" as const, via: "web" as const });
let double = githubDouble();

async function newPost(): Promise<string> {
  postN++;
  const [row] = await db.insert(s.posts).values({ slug: `gh-post-${postN}`, title: `p${postN}`, contentJson: { type: "doc", content: [] }, contentHtml: "", toc: [], status: "draft" } as never).returning();
  return (row as { id: string }).id;
}

/** Create a job and drive it to "dispatched and waiting for the runner" with the GitHub fetch double. */
async function startJob(kind: "preview" | "render" | "gif" = "render", opts: { options?: Record<string, unknown>; scenes?: number } = {}): Promise<string> {
  const postId = kind === "preview" ? null : await newPost();
  const res = await jobs.createJob(actor(), { kind, storyboard: sbOf("ok", opts.scenes), postId, ...(opts.options ? { options: opts.options } : {}) });
  if (!res.ok) throw new Error(`create failed ${JSON.stringify(res.error)}`);
  await waitFor(async () => (await rowOf(res.data.id)).runnerDispatchedAt, 15_000);
  return res.data.id;
}
const rowOf = async (id: string) => (await jobs.getJob(id))!.row;
const tok = (id: string) => tokens.runnerTokenFor(SECRET, id);
type Init = { token?: string | null; json?: unknown; body?: Uint8Array | Buffer; headers?: Record<string, string> };
const call = (id: string, method: string, p: string, init: Init = {}) =>
  app.request(`/runner/video/jobs/${id}${p}`, {
    method,
    headers: { ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? tok(id)}` }), ...(init.json !== undefined ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : init.body ? { body: init.body as never } : {}),
  });
const jsonOf = async (r: Response) => (await r.json()) as Record<string, unknown>;
const claim = (id: string, runId = "4242", attempt = 1) => call(id, "POST", "/claim", { json: { runId, attempt } });
const uploadDir = (id: string) => uploads.uploadDirOf(id);

async function putFile(id: string, name: string, data: Buffer, partBytes = uploads.PART_BYTES): Promise<{ parts: number }> {
  let n = 0;
  for (let off = 0; off < data.length; off += partBytes, n++) {
    const part = data.subarray(off, off + partBytes);
    const r = await call(id, "PUT", `/files/${name}/parts/${n}`, { body: part, headers: { "x-part-sha256": sha(part) } });
    if (r.status !== 200) throw new Error(`part ${n} -> ${r.status} ${JSON.stringify(await r.json())}`);
  }
  const done = await call(id, "POST", `/files/${name}/complete`, { json: { parts: n, bytes: data.length, sha256: sha(data) } });
  if (done.status !== 200) throw new Error(`complete ${name} -> ${done.status} ${JSON.stringify(await done.json())}`);
  return { parts: n };
}

beforeAll(async () => {
  storage.root = path.join(env.dir, "storage");
  mkdirSync(storage.root, { recursive: true });
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  ({ db } = await import("../../db/index.js"));
  s = await import("../../db/schema.js");
  ({ config } = (await import("../../config.js")) as unknown as { config: Record<string, number | string | boolean> });
  jobs = await import("./jobs.js");
  gh = await import("./github.js");
  rg = await import("./runner-github.js");
  uploads = await import("./uploads.js");
  tokens = await import("./runner-token.js");
  (await import("./resources.js")).setResourceProbeForTests(() => ({ freeDiskMb: 100_000, freeMemoryMb: 100_000 }));
  const { createTestUser } = await import("../../test/auth-test-helpers.js");
  userId = (await createTestUser({ role: "admin" })).id;
});

beforeEach(() => {
  double = githubDouble();
  gh.setGithubFetchForTests(double.fetchFn);
  storage.deleted.length = 0;
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) config[k] = v as never;
  for (const k of Object.keys(saved)) delete saved[k];
  await db.update(s.motionJobs).set({ status: "cancelled", finishedAt: new Date() }).where(eq(s.motionJobs.status, "queued"));
  await db.update(s.motionJobs).set({ status: "cancelled", finishedAt: new Date() }).where(eq(s.motionJobs.status, "running"));
});

afterAll(() => gh.setGithubFetchForTests(null));

describe("dispatch", () => {
  it("sends one workflow_dispatch to api.github.com with only the job id as input, and records the run id", async () => {
    const id = await startJob("render");
    const dispatches = double.calls.filter((c) => c.url.endsWith("/dispatches"));
    expect(dispatches).toHaveLength(1);
    const c = dispatches[0]!;
    expect(c.url).toBe("https://api.github.com/repos/owner/blog/actions/workflows/render-video.yml/dispatches");
    expect(c.method).toBe("POST");
    expect(c.headers.authorization).toBe("Bearer github_pat_TESTTOKEN_do_not_leak");
    expect(c.headers["x-github-api-version"]).toBe("2022-11-28");
    expect(JSON.parse(c.body!)).toEqual({ ref: "main", inputs: { job_id: id }, return_run_details: true });
    const row = await rowOf(id);
    expect(row).toMatchObject({ status: "running", runner: "github", runnerRunId: "4242", phase: "waiting_runner" });
  });

  it("accepts a plain 204 (no run details)", async () => {
    double = githubDouble(() => new Response(null, { status: 204 }));
    gh.setGithubFetchForTests(double.fetchFn);
    const id = await startJob("preview");
    expect((await rowOf(id)).runnerRunId).toBeNull();
  });

  const classes: Array<[number, string, string]> = [
    [401, "runner_auth", "rejected the token"],
    [403, "runner_auth", "Actions: Read and write"],
    [404, "runner_not_found", "render-video.yml"],
    [422, "runner_rejected", "workflow_dispatch"],
  ];
  for (const [status, code, text] of classes) {
    it(`HTTP ${status} fails the job at once as ${code} with an actionable message (token never in it)`, async () => {
      double = githubDouble(() => new Response(JSON.stringify({ message: "boom github_pat_TESTTOKEN_do_not_leak" }), { status }));
      gh.setGithubFetchForTests(double.fetchFn);
      const res = await jobs.createJob(actor(), { kind: "preview", storyboard: sbOf("ok") });
      if (!res.ok) throw new Error("create");
      await waitFor(async () => (await rowOf(res.data.id)).status === "failed", 15_000);
      const row = await rowOf(res.data.id);
      expect(row.errorCode).toBe(code);
      expect(row.errorMessage).toContain(text);
      expect(JSON.stringify(row)).not.toContain("TESTTOKEN");
      expect(double.calls.filter((c) => c.url.endsWith("/dispatches"))).toHaveLength(1);
    });
  }

  it("a transient failure (500, 429, network) is retried a bounded number of times, then fails as runner_unavailable", async () => {
    let n = 0;
    double = githubDouble(() => {
      n++;
      if (n === 1) throw new Error("socket hang up");
      return new Response("{}", { status: n === 2 ? 429 : 502 });
    });
    gh.setGithubFetchForTests(double.fetchFn);
    const res = await jobs.createJob(actor(), { kind: "preview", storyboard: sbOf("ok") });
    if (!res.ok) throw new Error("create");
    const id = res.data.id;
    await waitFor(async () => (await rowOf(id)).dispatchAttempts === 1, 15_000);
    let row = await rowOf(id);
    expect(row.status).toBe("running");
    expect(row.runnerDispatchedAt).toBeNull();
    // fake clock: the retry is due after the backoff
    await rg.superviseGithubJobs(new Date(Date.now() + 6_000));
    await waitFor(async () => (await rowOf(id)).dispatchAttempts === 2, 15_000);
    await rg.superviseGithubJobs(new Date(Date.now() + 20_000));
    await waitFor(async () => (await rowOf(id)).status === "failed", 15_000);
    row = await rowOf(id);
    expect(row.errorCode).toBe("runner_unavailable");
    expect(n).toBe(3);
  });

  it("a transient failure followed by success is fine (the claim is single-use, so a repeated dispatch is harmless)", async () => {
    let n = 0;
    double = githubDouble(() => {
      n++;
      return n === 1 ? new Response("{}", { status: 503 }) : new Response(null, { status: 204 });
    });
    gh.setGithubFetchForTests(double.fetchFn);
    const res = await jobs.createJob(actor(), { kind: "preview", storyboard: sbOf("ok") });
    if (!res.ok) throw new Error("create");
    await waitFor(async () => (await rowOf(res.data.id)).dispatchAttempts === 1, 15_000);
    await rg.superviseGithubJobs(new Date(Date.now() + 6_000));
    await waitFor(async () => (await rowOf(res.data.id)).runnerDispatchedAt, 15_000);
  });

  it("refuses to create a job when the backend is not configured, with the setup hint (and queues nothing)", async () => {
    setCfg({ VIDEO_RUNNER_SECRET: "short" });
    const r = await jobs.createJob(actor(), { kind: "preview", storyboard: sbOf("ok") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.extra).toMatchObject({ code: "runner_not_configured" });
    expect(String((!r.ok && r.error.extra?.hint) || "")).toContain("VIDEO_RUNNER_SECRET");
  });

  it("only api.github.com is ever contacted", async () => {
    await startJob("render");
    for (const c of double.calls) expect(new URL(c.url).hostname).toBe("api.github.com");
  });
});

describe("runner endpoint authentication", () => {
  it("no token, a wrong token, another job's token and a malformed id all get the same 401 and change nothing", async () => {
    const id = await startJob("preview");
    const other = await startJob("render");
    const wrong = [null, "deadbeef", "0".repeat(64), tok(other), "Bearer", `${tok(id)}x`];
    for (const t of wrong) {
      const r = await call(id, "POST", "/claim", { token: t, json: { runId: "1", attempt: 1 } });
      expect(r.status).toBe(401);
      expect(await jsonOf(r)).toEqual({ code: "unauthorized" });
    }
    expect((await call("not-a-uuid", "POST", "/claim", { json: { runId: "1", attempt: 1 } })).status).toBe(401);
    expect((await rowOf(id)).runnerClaimedAt).toBeNull();
  });

  it("a missing or short VIDEO_RUNNER_SECRET accepts nothing, not even a token computed from it", async () => {
    const id = await startJob("preview");
    const good = tok(id);
    setCfg({ VIDEO_RUNNER_SECRET: "x".repeat(31) });
    expect((await call(id, "POST", "/claim", { token: tokens.runnerTokenFor("x".repeat(31), id), json: { runId: "1", attempt: 1 } })).status).toBe(401);
    setCfg({ VIDEO_RUNNER_SECRET: "" });
    expect((await call(id, "POST", "/claim", { token: good, json: { runId: "1", attempt: 1 } })).status).toBe(401);
    expect((await call(id, "POST", "/claim", { token: tokens.runnerTokenFor("", id), json: { runId: "1", attempt: 1 } })).status).toBe(401);
  });

  it("the token is HMAC-SHA256(secret, job id) in hex (fixed test vector, the same one the runner script uses)", () => {
    expect(tokens.runnerTokenFor("k".repeat(32), "11111111-2222-3333-4444-555555555555")).toBe("4c15e44073b36f33ed0124d57eedad050650b8a7e1e54d2183a4332a370a4f2a");
  });
});

describe("claim", () => {
  it("is single use: the first run wins, the SAME run may repeat it, a different run id is refused (duplicate dispatch is harmless)", async () => {
    const id = await startJob("render");
    const first = await claim(id, "4242", 1);
    expect(first.status).toBe(200);
    const body = await jsonOf(first);
    expect(body).toMatchObject({ kind: "render", videoName: "video.mp4", partBytes: 8 * 1024 * 1024, concurrency: 4 });
    expect((body.storyboard as { title: string }).title).toBe("ok");
    expect((await claim(id, "4242", 1)).status).toBe(200);
    const dup = await claim(id, "2002", 1);
    expect(dup.status).toBe(409);
    expect(await jsonOf(dup)).toEqual({ code: "already_claimed" });
    expect((await claim(id, "4242", 2)).status).toBe(409);
    expect(await rowOf(id)).toMatchObject({ runnerRunId: "4242", runnerAttempt: 1 });
  });

  it("is refused for a job that is queued, finished, failed or cancelled", async () => {
    const queuedRes = await jobs.createJob(actor(), { kind: "render", storyboard: sbOf("ok"), postId: await newPost() });
    if (!queuedRes.ok) throw new Error("create");
    setCfg({ VIDEO_MAX_RUNNING: 1 });
    // not claimed by the scheduler yet or already dispatched: a job that is not running on the github backend answers 404/409
    const id = await startJob("preview");
    await jobs.cancelJob(actor(), id);
    const r = await claim(id);
    expect(r.status).toBe(409);
    expect(await jsonOf(r)).toEqual({ code: "job_cancelled" });
    await db.update(s.motionJobs).set({ status: "failed", finishedAt: new Date() }).where(eq(s.motionJobs.id, queuedRes.data.id));
    expect((await claim(queuedRes.data.id)).status).toBe(404);
  });

  it("is refused once the job is past its start deadline (expired)", async () => {
    const id = await startJob("preview");
    const old = new Date(Date.now() - 3 * 3600_000);
    await db.update(s.motionJobs).set({ startedAt: old, runnerDispatchedAt: old }).where(eq(s.motionJobs.id, id));
    const r = await claim(id);
    expect(r.status).toBe(410);
    expect(await jsonOf(r)).toEqual({ code: "job_expired" });
  });

  it("endpoints other than claim need a claimed job", async () => {
    const id = await startJob("render");
    expect((await call(id, "POST", "/progress", { json: { phase: "render", fraction: 0.1, message: "x" } })).status).toBe(409);
    expect((await call(id, "PUT", "/files/video.mp4/parts/0", { body: mp4() })).status).toBe(409);
  });
});

describe("progress and cancel", () => {
  it("progress is stored and returns cancel:false; bad bodies are 422", async () => {
    const id = await startJob("render");
    await claim(id);
    const r = await call(id, "POST", "/progress", { json: { phase: "render", fraction: 0.5, message: "frame 10/20" } });
    expect(await jsonOf(r)).toEqual({ cancel: false });
    expect(await rowOf(id)).toMatchObject({ progress: 60, phase: "render", message: "frame 10/20" });
    expect((await call(id, "POST", "/progress", { json: { phase: "render", fraction: 7, message: "x" } })).status).toBe(422);
    expect((await call(id, "POST", "/progress", { json: { phase: "render", fraction: 0.1, message: "x", extra: 1 } })).status).toBe(422);
  });

  it("cancel BEFORE the claim: the job is cancelled at once, the run is cancelled on GitHub, a late claim is refused", async () => {
    const id = await startJob("preview");
    const res = await jobs.cancelJob(actor(), id);
    expect(res.ok && res.data.status).toBe("cancelled");
    await waitFor(() => double.calls.some((c) => c.url.endsWith("/actions/runs/4242/cancel")), 5_000);
    expect(double.calls.find((c) => c.url.endsWith("/cancel"))?.method).toBe("POST");
    expect((await claim(id)).status).toBe(409);
  });

  it("cancel AFTER the claim: the next progress call tells the runner to stop; the run id is the one from the dispatch", async () => {
    const id = await startJob("render");
    await claim(id, "4242", 1);
    await jobs.cancelJob(actor(), id);
    expect((await rowOf(id)).status).toBe("cancelled");
    const p = await call(id, "POST", "/progress", { json: { phase: "render", fraction: 0.2, message: "x" } });
    expect(p.status).toBe(200);
    expect(await jsonOf(p)).toEqual({ cancel: true });
    await waitFor(() => double.calls.some((c) => c.url.endsWith("/actions/runs/4242/cancel")), 5_000);
    expect((await call(id, "POST", "/complete", { json: { kind: "render", video: { name: "video.mp4", seconds: 1, frames: 30, renderMs: 10 }, timings: { renderMs: 1, uploadMs: 1 } } })).status).toBe(409);
  });
});

describe("file upload rules", () => {
  it("rejects names outside the fixed pattern for the job kind (including traversal and storyboard-like names)", async () => {
    const id = await startJob("render");
    await claim(id);
    for (const name of ["evil.mp4", "clip.gif", "still-1.jpg", "..%2Fx", "%2e%2e", "video.mp4.exe", "Video.mp4", "a".repeat(40)]) {
      const r = await call(id, "PUT", `/files/${name}/parts/0`, { body: mp4() });
      expect([400, 404], `${name} -> ${r.status}`).toContain(r.status);
    }
    expect(existsSync(uploadDir(id)) ? readdirSync(uploadDir(id)) : []).toEqual([]);
    const bad = await call(id, "PUT", "/files/clip.gif/parts/0", { body: gif() });
    expect(await jsonOf(bad)).toEqual({ code: "bad_file_name" });
  });

  it("a preview accepts only still-N.jpg up to the expected number of frames; one scene means 4, `at` means its length", async () => {
    const id = await startJob("preview", { options: { at: [1, 2] } });
    await claim(id);
    const img = await jpeg(480, 270);
    expect((await call(id, "PUT", "/files/still-1.jpg/parts/0", { body: img })).status).toBe(200);
    expect((await call(id, "PUT", "/files/still-2.jpg/parts/0", { body: img })).status).toBe(200);
    const third = await call(id, "PUT", "/files/still-3.jpg/parts/0", { body: img });
    expect(third.status).toBe(400);
    expect((await call(id, "PUT", "/files/still-0.jpg/parts/0", { body: img })).status).toBe(400);
  });

  it("enforces the part size (> 8 MB is 413, by declared length and by actual bytes) and the per-file cap", async () => {
    const id = await startJob("render");
    await claim(id);
    const tooBig = Buffer.alloc(8 * 1024 * 1024 + 1, 1);
    const r = await call(id, "PUT", "/files/video.mp4/parts/0", { body: tooBig });
    expect(r.status).toBe(413);
    expect(existsSync(uploadDir(id)) ? readdirSync(uploadDir(id)).filter((f) => f.includes("part")) : []).toEqual([]);
    // cap of the file: 1 MB limit, a 2 MB part is refused as file_too_large
    setCfg({ VIDEO_MAX_MP4_BYTES: 1024 * 1024 });
    const big = await call(id, "PUT", "/files/video.mp4/parts/0", { body: Buffer.alloc(2 * 1024 * 1024, 1) });
    expect(big.status).toBe(413);
    expect(await jsonOf(big)).toEqual({ code: "file_too_large" });
  });

  it("enforces the total cap across all files of a preview (a limit lowered between uploads)", async () => {
    setCfg({ VIDEO_MAX_STILL_BYTES: 5000 });
    const id = await startJob("preview", { options: { at: [1, 2] } });
    await claim(id);
    expect((await call(id, "PUT", "/files/still-1.jpg/parts/0", { body: Buffer.alloc(4000, 9) })).status).toBe(200);
    // each file may use 5000 bytes; a second part of the same file is not allowed at all (one part per 8 MB of cap)
    expect((await call(id, "PUT", "/files/still-1.jpg/parts/1", { body: Buffer.alloc(10, 9) })).status).toBe(400);
    setCfg({ VIDEO_MAX_STILL_BYTES: 2500 });
    const over = await call(id, "PUT", "/files/still-2.jpg/parts/0", { body: Buffer.alloc(2400, 1) });
    expect(over.status).toBe(413);
    expect(await jsonOf(over)).toEqual({ code: "total_too_large" });
    const alsoBig = await call(id, "PUT", "/files/still-2.jpg/parts/0", { body: Buffer.alloc(2600, 1) });
    expect(alsoBig.status).toBe(413);
  });

  it("a retried part replaces itself (idempotent); the total is not double counted", async () => {
    const id = await startJob("render");
    await claim(id);
    const part = mp4(3000);
    for (let i = 0; i < 3; i++) expect((await call(id, "PUT", "/files/video.mp4/parts/0", { body: part, headers: { "x-part-sha256": sha(part) } })).status).toBe(200);
    expect(readdirSync(uploadDir(id)).filter((f) => f.endsWith(".part"))).toEqual(["video.mp4.0.part"]);
    const done = await call(id, "POST", "/files/video.mp4/complete", { json: { parts: 1, bytes: 3000, sha256: sha(part) } });
    expect(done.status).toBe(200);
  });

  it("a part whose checksum does not match is refused and nothing is kept", async () => {
    const id = await startJob("render");
    await claim(id);
    const r = await call(id, "PUT", "/files/video.mp4/parts/0", { body: mp4(), headers: { "x-part-sha256": "0".repeat(64) } });
    expect(r.status).toBe(422);
    expect(await jsonOf(r)).toEqual({ code: "checksum_mismatch" });
    expect(readdirSync(uploadDir(id))).toEqual([]);
  });

  it("assembles several 8 MB parts and verifies the whole file", async () => {
    const id = await startJob("render");
    await claim(id);
    const data = mp4(8 * 1024 * 1024 + 123_456);
    const { parts } = await putFile(id, "video.mp4", data);
    expect(parts).toBe(2);
    expect(readdirSync(uploadDir(id))).toEqual(["video.mp4"]);
  });

  it("a missing part at completion is refused (409) and a size mismatch too", async () => {
    const id = await startJob("render");
    await claim(id);
    const data = mp4(8 * 1024 * 1024 + 10);
    await call(id, "PUT", "/files/video.mp4/parts/0", { body: data.subarray(0, 8 * 1024 * 1024) });
    const missing = await call(id, "POST", "/files/video.mp4/complete", { json: { parts: 2, bytes: data.length } });
    expect(missing.status).toBe(409);
    expect(await jsonOf(missing)).toEqual({ code: "missing_part" });
    const wrong = await call(id, "POST", "/files/video.mp4/complete", { json: { parts: 1, bytes: 123 } });
    expect(wrong.status).toBe(409);
    expect(await jsonOf(wrong)).toEqual({ code: "size_mismatch" });
  });

  it("verifies magic numbers: an MP4 job refuses a file that is not an MP4, a GIF job refuses a non-GIF, a preview refuses a non-JPEG", async () => {
    const a = await startJob("render");
    await claim(a);
    const text = Buffer.from("<html>not a video at all, just text</html>");
    await call(a, "PUT", "/files/video.mp4/parts/0", { body: text });
    const r1 = await call(a, "POST", "/files/video.mp4/complete", { json: { parts: 1, bytes: text.length } });
    expect(r1.status).toBe(422);
    expect(await jsonOf(r1)).toEqual({ code: "bad_magic" });
    const b = await startJob("gif", { options: { scene: "1" } });
    await claim(b);
    await call(b, "PUT", "/files/clip.gif/parts/0", { body: mp4() });
    expect((await call(b, "POST", "/files/clip.gif/complete", { json: { parts: 1, bytes: 4096 } })).status).toBe(422);
    const c = await startJob("preview");
    await claim(c);
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    await call(c, "PUT", "/files/still-1.jpg/parts/0", { body: png });
    expect((await call(c, "POST", "/files/still-1.jpg/complete", { json: { parts: 1, bytes: png.length } })).status).toBe(422);
  });

  it("verifies the decoded dimensions of preview frames", async () => {
    const id = await startJob("preview");
    await claim(id);
    const wrong = await jpeg(300, 300);
    await call(id, "PUT", "/files/still-1.jpg/parts/0", { body: wrong });
    const r = await call(id, "POST", "/files/still-1.jpg/complete", { json: { parts: 1, bytes: wrong.length } });
    expect(r.status).toBe(422);
    expect(await jsonOf(r)).toEqual({ code: "bad_dimensions" });
    const ok = await jpeg(480, 270);
    await call(id, "PUT", "/files/still-2.jpg/parts/0", { body: ok });
    expect((await call(id, "POST", "/files/still-2.jpg/complete", { json: { parts: 1, bytes: ok.length } })).status).toBe(200);
  });

  it("a body that is not a stream of bytes, an empty body and a non-numeric part number are refused", async () => {
    const id = await startJob("render");
    await claim(id);
    expect((await call(id, "PUT", "/files/video.mp4/parts/0")).status).toBe(400);
    expect((await call(id, "PUT", "/files/video.mp4/parts/abc", { body: mp4() })).status).toBe(400);
    expect((await call(id, "PUT", "/files/video.mp4/parts/10", { body: mp4() })).status).toBe(400);
  });

  it("answers never contain server paths or stack traces", async () => {
    const id = await startJob("render");
    await claim(id);
    for (const r of [await call(id, "PUT", "/files/evil/parts/0", { body: mp4() }), await call(id, "POST", "/files/video.mp4/complete", { json: { parts: 1, bytes: 5 } }), await call(id, "POST", "/complete", { json: { nope: 1 } })]) {
      const text = JSON.stringify(await r.json());
      expect(text).not.toMatch(/\/Users|\/tmp|\/private|node_modules|\bat \w+ \(|Error:/);
    }
  });
});

describe("completion and cleanup", () => {
  const completeBody = (extra: Record<string, unknown> = {}) => ({ kind: "render", video: { name: "video.mp4", seconds: 5.5, frames: 165, renderMs: 4000 }, timings: { renderMs: 4100, uploadMs: 300 }, ...extra });

  it("a render: files move into media storage under final keys, the job is ready, temp uploads are gone, the outcome is audited with runner and run id", async () => {
    const id = await startJob("render");
    await claim(id, "4242", 2);
    await putFile(id, "video.mp4", mp4(5000));
    const r = await call(id, "POST", "/complete", { json: completeBody() });
    expect(r.status).toBe(200);
    const { row, assets } = (await jobs.getJob(id))!;
    expect(row).toMatchObject({ status: "ready", progress: 100, runnerRunId: "4242" });
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ kind: "mp4", mime: "video/mp4", size: 5000 });
    expect(existsSync(path.join(storage.root, assets[0]!.key))).toBe(true);
    expect(existsSync(uploadDir(id))).toBe(false);
    const audit = (await db.select().from(s.auditLog)).filter((a) => a.action === "video.finish" && a.entityId === id);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.meta).toMatchObject({ status: "ready", runner: "github", runId: "4242", kind: "render" });
    // repeating completion for a finished job is harmless
    expect((await call(id, "POST", "/complete", { json: completeBody() })).status).toBe(200);
  });

  it("a preview: every frame becomes an asset with its scene info; an unknown file name is refused", async () => {
    const id = await startJob("preview", { scenes: 3 });
    await claim(id);
    const img = await jpeg(480, 270);
    await putFile(id, "still-1.jpg", img);
    await putFile(id, "still-2.jpg", img);
    const body = { kind: "preview", stills: [{ name: "still-1.jpg", seconds: 1, scene: 0, sceneType: "intro" }, { name: "still-2.jpg", seconds: 4, scene: 1, sceneType: "bullets" }], timings: { renderMs: 10, uploadMs: 5 } };
    const bad = await call(id, "POST", "/complete", { json: { ...body, stills: [{ name: "still-9.jpg", seconds: 1, scene: 0, sceneType: "x" }] } });
    expect(bad.status).toBe(422);
    // the failed attempt cleaned the temp files (a runner would have to start over): re-upload then complete
    await putFile(id, "still-1.jpg", img);
    await putFile(id, "still-2.jpg", img);
    expect((await call(id, "POST", "/complete", { json: body })).status).toBe(200);
    const { row, assets } = (await jobs.getJob(id))!;
    expect(row.status).toBe("ready");
    expect(assets.map((a) => [a.kind, a.sceneIndex, a.sceneType])).toEqual([["still", 0, "intro"], ["still", 1, "bullets"]]);
  });

  it("completion without the uploaded file is refused and the temp directory is removed anyway", async () => {
    const id = await startJob("render");
    await claim(id);
    const r = await call(id, "POST", "/complete", { json: completeBody() });
    expect(r.status).toBe(422);
    expect(existsSync(uploadDir(id))).toBe(false);
    expect((await rowOf(id)).status).toBe("running");
  });

  it("a storage failure fails the job as storage_failed, deletes what was stored and removes the temp files", async () => {
    const id = await startJob("render");
    await claim(id);
    await putFile(id, "video.mp4", mp4());
    storage.failNext = true;
    const r = await call(id, "POST", "/complete", { json: completeBody() });
    expect(r.status).toBe(409);
    expect(await rowOf(id)).toMatchObject({ status: "failed", errorCode: "storage_failed" });
    expect(existsSync(uploadDir(id))).toBe(false);
  });

  it("a job cancelled while the result was arriving ends cancelled, stores nothing and cleans up", async () => {
    const id = await startJob("render");
    await claim(id);
    await putFile(id, "video.mp4", mp4());
    await jobs.cancelJob(actor(), id);
    const r = await call(id, "POST", "/complete", { json: completeBody() });
    expect(r.status).toBe(409);
    expect((await rowOf(id)).status).toBe("cancelled");
    expect((await jobs.getJob(id))!.assets).toHaveLength(0);
    expect(existsSync(uploadDir(id))).toBe(false);
  });

  it("an oversize result (limit lowered after upload) fails as too_large and nothing stays in storage", async () => {
    const id = await startJob("render");
    await claim(id);
    await putFile(id, "video.mp4", mp4(20_000));
    setCfg({ VIDEO_MAX_MP4_BYTES: 10_000 });
    await call(id, "POST", "/complete", { json: completeBody() });
    expect(await rowOf(id)).toMatchObject({ status: "failed", errorCode: "too_large" });
    expect(existsSync(uploadDir(id))).toBe(false);
  });

  it("a gif job completes with clip.gif", async () => {
    const id = await startJob("gif", { options: { scene: "1" } });
    await claim(id);
    await putFile(id, "clip.gif", gif());
    const r = await call(id, "POST", "/complete", { json: { kind: "gif", video: { name: "clip.gif", seconds: 3, frames: 45, renderMs: 900 }, timings: { renderMs: 1000, uploadMs: 10 } } });
    expect(r.status).toBe(200);
    expect((await jobs.getJob(id))!.assets[0]).toMatchObject({ kind: "gif", mime: "image/gif" });
  });
});

describe("failure reports from the runner", () => {
  it("maps known codes, keeps the message only for engine-side problems, bounds it and removes temp files", async () => {
    const id = await startJob("render");
    await claim(id);
    await call(id, "PUT", "/files/video.mp4/parts/0", { body: mp4() });
    const r = await call(id, "POST", "/fail", { json: { code: "engine_mismatch", message: `rejected at ${"x".repeat(300)} /Users/runner/work/secret` } });
    expect(r.status).toBe(200);
    const row = await rowOf(id);
    expect(row).toMatchObject({ status: "failed", errorCode: "engine_mismatch" });
    expect(row.errorMessage!.length).toBeLessThanOrEqual(400);
    expect(row.errorMessage).not.toContain("/Users");
    expect(existsSync(uploadDir(id))).toBe(false);
    // repeating is harmless
    expect((await call(id, "POST", "/fail", { json: { code: "render_failed", message: "again" } })).status).toBe(200);
    expect((await rowOf(id)).errorCode).toBe("engine_mismatch");
  });

  it("an unknown code becomes runner_failed with the generic text; `cancelled` is its own code; too long codes are 422", async () => {
    const a = await startJob("preview");
    await claim(a);
    await call(a, "POST", "/fail", { json: { code: "format_the_disk", message: "boom boom" } });
    expect(await rowOf(a)).toMatchObject({ errorCode: "runner_failed", errorMessage: "The GitHub runner reported a failure." });
    const b = await startJob("preview");
    await claim(b);
    await call(b, "POST", "/fail", { json: { code: "cancelled", message: "x" } });
    expect((await rowOf(b)).errorCode).toBe("runner_cancelled");
    expect((await call(b, "POST", "/fail", { json: { code: "x".repeat(50), message: "x" } })).status).toBe(422);
  });

  it("a request body over 64 KB on the JSON endpoints is 413", async () => {
    const id = await startJob("preview");
    await claim(id);
    const r = await call(id, "POST", "/fail", { json: { code: "render_failed", message: "x".repeat(70_000) } });
    expect(r.status).toBe(413);
  });
});

describe("watchdog (fake clock)", () => {
  it("not claimed within VIDEO_RUNNER_START_TIMEOUT_SECONDS: runner_not_started and a best-effort run cancel", async () => {
    setCfg({ VIDEO_RUNNER_START_TIMEOUT_SECONDS: 300 });
    const id = await startJob("render");
    const before = await rg.superviseGithubJobs(new Date(Date.now() + 299_000));
    expect(before.notStarted).toBe(0);
    expect((await rowOf(id)).status).toBe("running");
    const out = await rg.superviseGithubJobs(new Date(Date.now() + 302_000));
    expect(out.notStarted).toBe(1);
    expect(await rowOf(id)).toMatchObject({ status: "failed", errorCode: "runner_not_started" });
    await waitFor(() => double.calls.some((c) => c.url.endsWith("/actions/runs/4242/cancel")), 5_000);
  });

  it("claimed but not completed within the render timeout (+ grace): runner_timeout and a run cancel", async () => {
    setCfg({ VIDEO_RENDER_TIMEOUT_SECONDS: 600 });
    const id = await startJob("render");
    await claim(id, "4242", 1);
    const claimedAt = (await rowOf(id)).runnerClaimedAt!;
    const justBefore = new Date(claimedAt.getTime() + (600 + 179) * 1000);
    expect((await rg.superviseGithubJobs(justBefore)).timedOut).toBe(0);
    const out = await rg.superviseGithubJobs(new Date(claimedAt.getTime() + (600 + 181) * 1000));
    expect(out.timedOut).toBe(1);
    expect(await rowOf(id)).toMatchObject({ status: "failed", errorCode: "runner_timeout" });
    await waitFor(() => double.calls.some((c) => c.url.endsWith("/actions/runs/4242/cancel")), 5_000);
  });

  it("the preview timeout (not the render timeout) applies to previews", async () => {
    setCfg({ VIDEO_PREVIEW_TIMEOUT_SECONDS: 60, VIDEO_RENDER_TIMEOUT_SECONDS: 900 });
    const id = await startJob("preview");
    await claim(id);
    const claimedAt = (await rowOf(id)).runnerClaimedAt!;
    expect((await rg.superviseGithubJobs(new Date(claimedAt.getTime() + 200_000))).timedOut).toBe(0);
    expect((await rg.superviseGithubJobs(new Date(claimedAt.getTime() + 245_000))).timedOut).toBe(1);
  });

  it("a job that finishes in time is left alone by the watchdog", async () => {
    const id = await startJob("render");
    await claim(id);
    await putFile(id, "video.mp4", mp4());
    await call(id, "POST", "/complete", { json: { kind: "render", video: { name: "video.mp4", seconds: 1, frames: 30, renderMs: 1 }, timings: { renderMs: 1, uploadMs: 1 } } });
    await rg.superviseGithubJobs(new Date(Date.now() + 10 * 3600_000));
    expect((await rowOf(id)).status).toBe("ready");
  });
});

describe("API restart in the middle of a job", () => {
  it("recovery does NOT fail GitHub-backed jobs that are inside their deadlines; the runner can still finish", async () => {
    const id = await startJob("render");
    await claim(id);
    await putFile(id, "video.mp4", mp4());
    const report = await jobs.recoverVideoJobs();
    expect(report.failedRunning).toBe(0);
    expect((await rowOf(id)).status).toBe("running");
    expect(existsSync(uploadDir(id))).toBe(true);
    expect((await call(id, "POST", "/complete", { json: { kind: "render", video: { name: "video.mp4", seconds: 1, frames: 30, renderMs: 1 }, timings: { renderMs: 1, uploadMs: 1 } } })).status).toBe(200);
    expect((await rowOf(id)).status).toBe("ready");
  });

  it("a job claimed by the scheduler but never dispatched (crash in between) is dispatched again after the restart", async () => {
    const postId = await newPost();
    const created = await jobs.createJob(actor(), { kind: "render", storyboard: sbOf("ok"), postId });
    if (!created.ok) throw new Error("create");
    await waitFor(async () => (await rowOf(created.data.id)).runnerDispatchedAt, 15_000);
    // simulate the crash: the dispatch was never recorded
    await db.update(s.motionJobs).set({ runnerDispatchedAt: null, runnerRunId: null }).where(eq(s.motionJobs.id, created.data.id));
    const n = double.calls.length;
    await rg.superviseGithubJobs(new Date());
    await waitFor(async () => (await rowOf(created.data.id)).runnerDispatchedAt, 15_000);
    expect(double.calls.length).toBeGreaterThan(n);
  });

  it("jobs whose worker lived inside the old API process (local or unknown runner) ARE failed as interrupted", async () => {
    const [row] = await db.insert(s.motionJobs).values({ kind: "preview", status: "running", storyboard: sbOf("ok"), durationSeconds: 5, via: "web", runner: "local", startedAt: new Date() } as never).returning();
    const report = await jobs.recoverVideoJobs();
    expect(report.failedRunning).toBeGreaterThanOrEqual(1);
    expect((await rowOf((row as { id: string }).id)).errorCode).toBe("interrupted");
  });
});

describe("orphan sweep", () => {
  it("removes old temp upload directories of finished/unknown jobs and storage objects without a job row, keeps the live ones", async () => {
    const live = await startJob("render");
    await claim(live);
    await call(live, "PUT", "/files/video.mp4/parts/0", { body: mp4() });
    const ghost = "00000000-0000-4000-8000-000000000000";
    mkdirSync(uploads.uploadDirOf(ghost), { recursive: true });
    writeFileSync(path.join(uploads.uploadDirOf(ghost), "video.mp4.0.part"), "x");
    const old = new Date(Date.now() - 3 * 3600_000);
    utimesSync(uploads.uploadDirOf(ghost), old, old);
    utimesSync(uploads.uploadDirOf(live), old, old);
    // storage: one object that belongs to an asset, one without a row, one fresh without a row
    const owned = await startJob("render");
    await claim(owned);
    await putFile(owned, "video.mp4", mp4());
    await call(owned, "POST", "/complete", { json: { kind: "render", video: { name: "video.mp4", seconds: 1, frames: 30, renderMs: 1 }, timings: { renderMs: 1, uploadMs: 1 } } });
    const assetKey = (await jobs.getJob(owned))!.assets[0]!.key;
    const stale = path.join(storage.root, "video/2020/01/orphan.mp4");
    const fresh = path.join(storage.root, "video/2020/01/fresh.mp4");
    mkdirSync(path.dirname(stale), { recursive: true });
    writeFileSync(stale, "x");
    writeFileSync(fresh, "x");
    utimesSync(stale, old, old);
    const removed = await jobs.sweepRunnerOrphans();
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(existsSync(uploads.uploadDirOf(ghost))).toBe(false);
    expect(existsSync(uploads.uploadDirOf(live))).toBe(true); // running github job: kept even when old
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(path.join(storage.root, assetKey))).toBe(true);
  });
});

describe("rate limits", () => {
  it("the per-job limit answers 429 with Retry-After", async () => {
    const id = await startJob("preview");
    await claim(id);
    let last = 200;
    for (let i = 0; i < 620 && last !== 429; i++) {
      const r = await call(id, "POST", "/progress", { json: { phase: "stills", fraction: 0.1, message: "x" } });
      last = r.status;
      if (r.status === 429) expect(r.headers.get("retry-after")).toBeTruthy();
    }
    expect(last).toBe(429);
  }, 60_000);
});

// --------------------------------------------------------------------------- hardening follow-up (M1, M3, L1, L3)

const usageCount = async (): Promise<number> => (await db.select().from(s.motionUsage)).length;
const failRunner = (id: string, code = "render_failed") => call(id, "POST", "/fail", { json: { code, message: "x" } });

describe("configurable dispatch target (M1)", () => {
  it("dispatches to the configured repository, workflow file and ref (encoded path, ref in the body)", async () => {
    setCfg({ VIDEO_GITHUB_REPO: "render-owner/abdusoft-blog-render", VIDEO_GITHUB_WORKFLOW: "my-render.yaml", VIDEO_GITHUB_REF: "release/v1" });
    const id = await startJob("render");
    const c = double.calls.find((x) => x.url.endsWith("/dispatches"))!;
    expect(c.url).toBe("https://api.github.com/repos/render-owner/abdusoft-blog-render/actions/workflows/my-render.yaml/dispatches");
    expect(JSON.parse(c.body!)).toEqual({ ref: "release/v1", inputs: { job_id: id }, return_run_details: true });
  });

  it("defaults are render-video.yml and main; the status view shows the target", async () => {
    expect(config.VIDEO_RUNNER_START_TIMEOUT_SECONDS).toBe(600);
    const view = await (await import("./status.js")).videoStatus();
    expect(view.github).toMatchObject({ workflow: "render-video.yml", ref: "main", problem: null });
  });

  it("refuses the blog's own repository (any letter case) with an actionable job error and an Uzbek status message", async () => {
    for (const repo of [gh.BLOG_REPO, gh.BLOG_REPO.toUpperCase()]) {
      setCfg({ VIDEO_GITHUB_REPO: repo });
      const view = await (await import("./status.js")).videoStatus();
      expect(view.github?.problem).toContain("VIDEO_ALLOW_SAME_REPO");
      expect(view.github?.problem).toContain("alohida");
      const r = await jobs.createJob(actor(), { kind: "preview", storyboard: sbOf("ok") });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(String(r.error.extra?.hint)).toContain("VIDEO_ALLOW_SAME_REPO");
    }
    expect(double.calls).toHaveLength(0);
    // dispatch itself refuses too, even if readiness were bypassed
    const direct = await gh.dispatchWorkflow("11111111-2222-3333-4444-555555555555");
    expect(direct).toMatchObject({ ok: false, code: "runner_not_configured" });
    expect(double.calls).toHaveLength(0);
  });

  it("VIDEO_ALLOW_SAME_REPO=true lifts the refusal", async () => {
    setCfg({ VIDEO_GITHUB_REPO: gh.BLOG_REPO, VIDEO_ALLOW_SAME_REPO: true });
    expect((await (await import("./status.js")).videoStatus()).github?.problem).toBeNull();
    await startJob("preview");
    expect(double.calls.some((x) => x.url.includes(`/repos/${gh.BLOG_REPO}/actions/workflows/`))).toBe(true);
  });

  it("the settings save validates every field and refuses the blog repository", async () => {
    setCfg({ VIDEO_GITHUB_REPO: "", VIDEO_GITHUB_WORKFLOW: "", VIDEO_GITHUB_REF: "" });
    try {
      await expect(gh.saveGithubSettings({ githubRepo: gh.BLOG_REPO.toLowerCase() })).rejects.toMatchObject({ fields: { githubRepo: expect.stringContaining("VIDEO_ALLOW_SAME_REPO") } });
      await expect(gh.saveGithubSettings({ githubRepo: "owner/..", githubWorkflow: "../x.yml", githubRef: "-x" })).rejects.toMatchObject({ fields: { githubRepo: expect.any(String), githubWorkflow: expect.any(String), githubRef: expect.any(String) } });
      await gh.saveGithubSettings({ githubRepo: "o/render", githubWorkflow: "r.yml", githubRef: "main" });
      expect(await gh.getGithubSettingsView()).toMatchObject({ repo: { value: "o/render", source: "db" }, workflow: { value: "r.yml", source: "db" }, ref: { value: "main", source: "db" }, problem: null });
    } finally {
      await gh.saveGithubSettings({ githubRepo: "", githubWorkflow: "", githubRef: "" });
    }
  });
});

describe("run id steering (L1)", () => {
  it("a claim from a run other than the dispatched one is refused and leaves the job unclaimed", async () => {
    const id = await startJob("render");
    const bad = await claim(id, "999", 1);
    expect(bad.status).toBe(409);
    expect(await jsonOf(bad)).toEqual({ code: "run_mismatch" });
    expect(await rowOf(id)).toMatchObject({ runnerClaimedAt: null, runnerRunId: "4242" });
    expect((await claim(id, "4242", 1)).status).toBe(200);
    expect((await rowOf(id)).runnerRunId).toBe("4242");
  });

  it("without a dispatched run id the claim's id is stored once and never overwritten", async () => {
    double = githubDouble(() => new Response(null, { status: 204 }));
    gh.setGithubFetchForTests(double.fetchFn);
    const id = await startJob("render");
    expect((await rowOf(id)).runnerRunId).toBeNull();
    expect((await claim(id, "777", 1)).status).toBe(200);
    expect((await claim(id, "888", 1)).status).toBe(409);
    expect((await rowOf(id)).runnerRunId).toBe("777");
  });

  it("only digits of a sane length are accepted as a run id", async () => {
    const id = await startJob("render");
    for (const runId of ["", "abc", "12a", "0123", "-5", "1.5", "1".repeat(19), "9".repeat(40), "../1"]) {
      const r = await claim(id, runId, 1);
      expect(r.status, runId).toBe(422);
    }
    expect((await rowOf(id)).runnerClaimedAt).toBeNull();
  });
});

describe("a run GitHub already ended before the claim (M3)", () => {
  const ended = (conclusion: string) => async () => ({ status: "completed", conclusion });

  it("a cancelled run fails the job at once as runner_not_started, long before the start timeout", async () => {
    const id = await startJob("render");
    rg.setRunStateForTests(ended("cancelled"));
    try {
      expect((await rg.superviseGithubJobs()).notStarted).toBe(1);
      const row = await rowOf(id);
      expect(row).toMatchObject({ status: "failed", errorCode: "runner_not_started" });
      expect(row.errorMessage).toContain("was cancelled");
    } finally {
      rg.setRunStateForTests(null);
    }
  });

  it("a run that is still queued or in progress is left alone, and is polled at most every 20 s", async () => {
    const id = await startJob("render");
    let polls = 0;
    rg.setRunStateForTests(async () => {
      polls++;
      return { status: "in_progress", conclusion: null };
    });
    try {
      const t0 = Date.now();
      await rg.superviseGithubJobs(new Date(t0));
      await rg.superviseGithubJobs(new Date(t0 + 5_000));
      expect(polls).toBe(1);
      await rg.superviseGithubJobs(new Date(t0 + 21_000));
      expect(polls).toBe(2);
      expect((await rowOf(id)).status).toBe("running");
    } finally {
      rg.setRunStateForTests(null);
    }
  });

  it("a claimed job, and a job whose dispatch returned no run id, are never polled", async () => {
    const claimed = await startJob("render");
    await claim(claimed, "4242", 1);
    double = githubDouble(() => new Response(null, { status: 204 }));
    gh.setGithubFetchForTests(double.fetchFn);
    const noId = await startJob("render");
    let polls = 0;
    rg.setRunStateForTests(async () => {
      polls++;
      return { status: "completed", conclusion: "failure" };
    });
    try {
      await rg.superviseGithubJobs();
      expect(polls).toBe(0);
      expect((await rowOf(claimed)).status).toBe("running");
      expect((await rowOf(noId)).status).toBe("running");
    } finally {
      rg.setRunStateForTests(null);
    }
  });

  it("asks GitHub for the run with GET /repos/{owner}/{repo}/actions/runs/{id}", async () => {
    const calls: string[] = [];
    gh.setGithubFetchForTests(async (input, init) => {
      calls.push(`${init?.method} ${String(input)}`);
      return new Response(JSON.stringify({ status: "completed", conclusion: "cancelled" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    expect(await gh.getWorkflowRunState("4242")).toEqual({ status: "completed", conclusion: "cancelled" });
    expect(calls).toEqual(["GET https://api.github.com/repos/owner/blog/actions/runs/4242"]);
    expect(await gh.getWorkflowRunState("../4242")).toBeNull();
  });
});

describe("quota refund for infrastructure failures (L3)", () => {
  it("refunds exactly one unit for each infrastructure code, once, and deleting the job restores nothing more", async () => {
    setCfg({ VIDEO_MAX_RENDERS_PER_DAY: 50 });
    for (const code of ["runner_not_configured", "runner_auth", "runner_not_found", "runner_rejected", "runner_unavailable", "runner_not_started"]) {
      const postId = await newPost();
      const before = await usageCount();
      const created = await jobs.createJob(actor(), { kind: "render", storyboard: sbOf("ok"), postId });
      if (!created.ok) throw new Error("create");
      const id = created.data.id;
      await waitFor(async () => (await rowOf(id)).runnerDispatchedAt, 15_000);
      expect(await usageCount()).toBe(before + 1);
      expect(await jobs.failJob(id, code, undefined, {})).toBe(true);
      expect(await usageCount(), code).toBe(before);
      expect(await jobs.failJob(id, code, undefined, {})).toBe(false); // second call: nothing changes
      expect(await usageCount(), code).toBe(before);
      await jobs.deleteJob(actor(), id);
      expect(await usageCount(), code).toBe(before);
    }
  });

  it("the dispatch failing at once (HTTP 401) gives the unit back", async () => {
    double = githubDouble(() => new Response("{}", { status: 401 }));
    gh.setGithubFetchForTests(double.fetchFn);
    const before = await usageCount();
    const res = await jobs.createJob(actor(), { kind: "preview", storyboard: sbOf("ok") });
    if (!res.ok) throw new Error("create");
    await waitFor(async () => (await rowOf(res.data.id)).status === "failed", 15_000);
    expect(await usageCount()).toBe(before);
  });

  it("the watchdog's runner_not_started refunds; renders that ran, user cancels and runner failures do not", async () => {
    const start = await usageCount();
    const a = await startJob("render");
    await rg.superviseGithubJobs(new Date(Date.now() + 700_000));
    expect((await rowOf(a)).errorCode).toBe("runner_not_started");
    expect(await usageCount()).toBe(start);

    const b = await startJob("render");
    await claim(b, "4242", 1);
    expect((await failRunner(b)).status).toBe(200);
    expect((await rowOf(b)).errorCode).toBe("render_failed");
    expect(await usageCount()).toBe(start + 1);

    const c = await startJob("render");
    await jobs.cancelJob(actor(), c);
    expect(await usageCount()).toBe(start + 2);

    const d = await startJob("render");
    await claim(d, "4242", 1);
    await jobs.failJob(d, "runner_timeout", undefined, {});
    expect(await usageCount()).toBe(start + 3);
  });

  it("queued jobs failed because the backend became unconfigured get their unit back", async () => {
    setCfg({ VIDEO_MAX_RUNNING: 0 });
    const postId = await newPost();
    const before = await usageCount();
    const created = await jobs.createJob(actor(), { kind: "render", storyboard: sbOf("ok"), postId });
    if (!created.ok) throw new Error("create");
    expect((await rowOf(created.data.id)).status).toBe("queued");
    expect(await usageCount()).toBe(before + 1);
    setCfg({ VIDEO_RUNNER_SECRET: "short" });
    await rg.tickGithub(async () => null, new Date(Date.now() + 120_000));
    expect(await rowOf(created.data.id)).toMatchObject({ status: "failed", errorCode: "runner_not_configured" });
    expect(await usageCount()).toBe(before);
    await rg.tickGithub(async () => null, new Date(Date.now() + 120_000));
    expect(await usageCount()).toBe(before);
  });
});

describe("MP4 structure at upload (L4)", () => {
  it("an upload with a valid ftyp but no moov/mdat structure is refused at /files/video.mp4/complete and nothing is kept", async () => {
    const id = await startJob("render");
    await claim(id, "4242", 1);
    const fake = Buffer.alloc(4096, 7);
    fake.writeUInt32BE(24, 0);
    fake.write("ftypisom", 4, "latin1");
    expect((await call(id, "PUT", "/files/video.mp4/parts/0", { body: fake, headers: { "x-part-sha256": sha(fake) } })).status).toBe(200);
    const done = await call(id, "POST", "/files/video.mp4/complete", { json: { parts: 1, bytes: fake.length, sha256: sha(fake) } });
    expect(done.status).toBe(422);
    expect(await jsonOf(done)).toEqual({ code: "bad_structure" });
    expect(existsSync(path.join(uploadDir(id), "video.mp4"))).toBe(false);
    // a truncated copy of a real structure is refused as well
    const good = mp4(4096);
    const cut = good.subarray(0, 3000);
    await call(id, "PUT", "/files/video.mp4/parts/0", { body: cut, headers: { "x-part-sha256": sha(cut) } });
    expect((await call(id, "POST", "/files/video.mp4/complete", { json: { parts: 1, bytes: cut.length, sha256: sha(cut) } })).status).toBe(422);
  });
});

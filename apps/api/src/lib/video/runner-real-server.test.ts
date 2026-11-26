import { existsSync, mkdirSync, readdirSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { startRealServer } from "../../test/real-server.js";
import { sbOf, waitFor } from "../../test/video-harness.js";
import { githubDouble, mp4, sha } from "../../test/video-github-harness.js";

/**
 * The runner streams uploaded parts from the request body. In-process `app.request` cannot show how the REAL Node adapter behaves with a
 * streamed body (a hang was missed that way once), so these tests drive the endpoints over TCP through `@hono/node-server`.
 */
const SECRET = "r".repeat(48);
const env = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/video-real-server-test-${process.pid}`;
  process.env.VIDEO_ENABLED = "true";
  process.env.VIDEO_RUNNER = "github";
  process.env.VIDEO_RUNNER_SECRET = "r".repeat(48);
  process.env.VIDEO_GITHUB_TOKEN = "github_pat_realserver";
  process.env.VIDEO_GITHUB_REPO = "owner/blog";
  process.env.VIDEO_DATA_DIR = `${dir}/data`;
  process.env.VIDEO_MAX_RUNNING = "4";
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
  };
});

let server: Awaited<ReturnType<typeof startRealServer>>;
let jobs: typeof import("./jobs.js");
let uploads: typeof import("./uploads.js");
let tokens: typeof import("./runner-token.js");
let db: typeof import("../../db/index.js").db;
let s: typeof import("../../db/schema.js");
let n = 0;

async function startJob(): Promise<string> {
  n++;
  const [post] = await db.insert(s.posts).values({ slug: `rs-${n}`, title: "p", contentJson: { type: "doc", content: [] }, contentHtml: "", toc: [], status: "draft" } as never).returning();
  const r = await jobs.createJob({ userId: null, role: "system", via: "scheduler" }, { kind: "render", storyboard: sbOf("ok"), postId: (post as { id: string }).id });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  await waitFor(async () => (await jobs.getJob(r.data.id))!.row.runnerDispatchedAt, 15_000);
  return r.data.id;
}

interface Res {
  status: number | "timeout";
  body: string;
  ms: number;
  sent: number;
}

/** One request over a real socket. `mode` chooses Content-Length or chunked; `body` is produced chunk by chunk so a large one is never held. */
function send(opts: { id: string; method: string; path: string; token?: string; mode: "content-length" | "chunked" | "none"; total?: number; chunk?: number; headers?: Record<string, string>; json?: unknown; timeoutMs?: number }): Promise<Res> {
  return new Promise((resolve) => {
    const started = Date.now();
    let sent = 0;
    let done = false;
    const headers: Record<string, string> = { authorization: `Bearer ${opts.token ?? tokens.runnerTokenFor(SECRET, opts.id)}`, ...(opts.headers ?? {}) };
    const jsonText = opts.json !== undefined ? JSON.stringify(opts.json) : null;
    if (jsonText !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(jsonText));
    } else if (opts.mode === "content-length") headers["content-length"] = String(opts.total ?? 0);
    else if (opts.mode === "chunked") headers["transfer-encoding"] = "chunked";
    const req = http.request({ host: "127.0.0.1", port: server.port, method: opts.method, path: `/runner/video/jobs/${opts.id}${opts.path}`, headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => finish(res.statusCode ?? 0, body));
      res.on("error", () => finish(res.statusCode ?? 0, body));
    });
    const timer = setTimeout(() => finish("timeout", ""), opts.timeoutMs ?? 30_000);
    function finish(status: Res["status"], body: string) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      resolve({ status, body, ms: Date.now() - started, sent });
    }
    req.on("error", () => undefined);
    if (jsonText !== null) return void req.end(jsonText);
    if (opts.mode === "none") return void req.end();
    const total = opts.total ?? 0;
    const piece = Buffer.alloc(opts.chunk ?? 256 * 1024, 7);
    piece.write("\0\0\0\u0018ftypisom", 0, "latin1");
    const pump = () => {
      while (!done && sent < total) {
        const len = Math.min(piece.length, total - sent);
        sent += len;
        if (!req.write(len === piece.length ? piece : piece.subarray(0, len))) return void req.once("drain", pump);
      }
      if (!done) req.end();
    };
    pump();
  });
}

beforeAll(async () => {
  storage.root = path.join(env.dir, "storage");
  mkdirSync(storage.root, { recursive: true });
  await migrateTestDb();
  const { app } = await import("../../app.js");
  db = (await import("../../db/index.js")).db;
  s = await import("../../db/schema.js");
  jobs = await import("./jobs.js");
  uploads = await import("./uploads.js");
  tokens = await import("./runner-token.js");
  (await import("./github.js")).setGithubFetchForTests(githubDouble().fetchFn);
  (await import("./resources.js")).setResourceProbeForTests(() => ({ freeDiskMb: 100_000, freeMemoryMb: 100_000 }));
  server = await startRealServer(app);
});
afterAll(async () => {
  await server?.close();
});

const PART = 8 * 1024 * 1024;

describe("part upload through the real Node adapter", () => {
  it("an 8 MB part with Content-Length and one sent chunked both succeed quickly; the parts assemble and complete", async () => {
    const id = await startJob();
    expect((await send({ id, method: "POST", path: "/claim", mode: "none", json: { runId: "9", attempt: 1 } })).status).toBe(200);
    const a = await send({ id, method: "PUT", path: "/files/video.mp4/parts/0", mode: "content-length", total: PART });
    expect(a.status).toBe(200);
    expect(a.ms).toBeLessThan(15_000);
    const b = await send({ id, method: "PUT", path: "/files/video.mp4/parts/1", mode: "chunked", total: PART, chunk: 64 * 1024 });
    expect(b.status).toBe(200);
    expect(b.ms).toBeLessThan(15_000);
    // a short last part, chunked, without a declared length
    const c = await send({ id, method: "PUT", path: "/files/video.mp4/parts/2", mode: "chunked", total: 123_456 });
    expect(c.status).toBe(200);
    const done = await send({ id, method: "POST", path: "/files/video.mp4/complete", mode: "none", json: { parts: 3, bytes: 2 * PART + 123_456 } });
    expect(done.status).toBe(200);
    expect(readdirSync(uploads.uploadDirOf(id))).toEqual(["video.mp4"]);
    const fin = await send({ id, method: "POST", path: "/complete", mode: "none", json: { kind: "render", video: { name: "video.mp4", seconds: 1, frames: 30, renderMs: 1 }, timings: { renderMs: 1, uploadMs: 1 } } });
    expect(fin.status).toBe(200);
    expect((await jobs.getJob(id))!.row.status).toBe("ready");
  }, 90_000);

  it("a part larger than 8 MB is refused with 413 before the body is buffered: declared and chunked, nothing hangs", async () => {
    const id = await startJob();
    await send({ id, method: "POST", path: "/claim", mode: "none", json: { runId: "9", attempt: 1 } });
    // declared length over the cap: refused from the header alone
    const declared = await send({ id, method: "PUT", path: "/files/video.mp4/parts/0", mode: "content-length", total: PART + 1, timeoutMs: 15_000 });
    expect(declared.status).toBe(413);
    // chunked, 256 MB offered: the server answers 413 long before the whole body is read (the cap is enforced while streaming)
    const flood = await send({ id, method: "PUT", path: "/files/video.mp4/parts/0", mode: "chunked", total: 256 * 1024 * 1024, chunk: 512 * 1024, timeoutMs: 20_000 });
    expect(flood.status).toBe(413);
    expect(flood.ms).toBeLessThan(15_000);
    expect(flood.sent).toBeLessThan(64 * 1024 * 1024);
    const dir = uploads.uploadDirOf(id);
    expect(existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".part")) : []).toEqual([]);
    // the job still works afterwards
    expect((await send({ id, method: "PUT", path: "/files/video.mp4/parts/0", mode: "content-length", total: 4096 })).status).toBe(200);
  }, 90_000);

  it("a bad token over the real adapter is 401 without reading the body; an unfinished body does not hang the server", async () => {
    const id = await startJob();
    const r = await send({ id, method: "PUT", path: "/files/video.mp4/parts/0", token: "0".repeat(64), mode: "chunked", total: 32 * 1024 * 1024, timeoutMs: 15_000 });
    expect(r.status).toBe(401);
    expect(r.sent).toBeLessThan(32 * 1024 * 1024);
    void mp4;
    void sha;
  }, 60_000);
});

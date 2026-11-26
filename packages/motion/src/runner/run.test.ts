import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { readFixture } from "../test-helpers.ts";
import type { ExecuteOptions, ExecuteOutcome } from "../worker/execute.ts";
import { checkOrigin } from "./client.ts";
import { runnerToken, type ClaimResponse } from "./protocol.ts";
import { runGithubJob, specFor, type RunnerEnv } from "./run.ts";

const dir = mkdtempSync(path.join(tmpdir(), "runner-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const JOB = "11111111-2222-3333-4444-555555555555";
const SECRET = "k".repeat(32);
const env = (over: Partial<RunnerEnv> = {}): RunnerEnv => ({ JOB_ID: JOB, VIDEO_RUNNER_SECRET: SECRET, VIDEO_API_ORIGIN: "https://api.example.test", GITHUB_RUN_ID: "777", GITHUB_RUN_ATTEMPT: "1", RUNNER_TEMP: dir, ...over });

const baseClaim = (over: Partial<ClaimResponse> = {}): ClaimResponse => ({
  kind: "render",
  storyboard: readFixture("showcase.json"),
  options: {},
  timeoutSeconds: 60,
  concurrency: 4,
  partBytes: 1000,
  maxFiles: 1,
  stillMaxBytes: 600_000,
  videoName: "video.mp4",
  videoMaxBytes: 80_000_000,
  ...over,
});

interface Seen {
  path: string;
  method: string;
  auth: string | null;
  body: Uint8Array | string | null;
  headers: Record<string, string>;
}

/** An API double: answers the runner endpoints and records every request. */
function apiDouble(opts: { claim?: ClaimResponse | number; progress?: Array<{ cancel: boolean } | number>; failOnPart?: number; completeStatus?: number } = {}) {
  const seen: Seen[] = [];
  let progressN = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const p = u.pathname.replace(`/runner/video/jobs/${JOB}`, "");
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const body = init.body as Uint8Array | string | null;
    seen.push({ path: p, method: init.method ?? "GET", auth: headers.authorization ?? null, body, headers });
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (p === "/claim") return typeof opts.claim === "number" ? json(opts.claim, { code: "already_claimed" }) : json(200, opts.claim ?? baseClaim());
    if (p === "/progress") {
      const r = opts.progress?.[progressN++] ?? { cancel: false };
      return typeof r === "number" ? json(r, { code: "job_finished" }) : json(200, r);
    }
    if (p.includes("/parts/") && opts.failOnPart !== undefined && p.endsWith(`/parts/${opts.failOnPart}`)) return json(507, { code: "disk_full" });
    if (p === "/complete") return json(opts.completeStatus ?? 200, { ok: true });
    return json(200, { ok: true });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const okRender = (file: string, bytes = 2500): ExecuteOutcome => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.alloc(bytes, 5));
  return { ok: true, result: { t: "result", kind: "render", file, bytes, frames: 90, seconds: 3, renderMs: 1234 } };
};

const run = (e: RunnerEnv, execute: (o: ExecuteOptions) => Promise<ExecuteOutcome>, d: ReturnType<typeof apiDouble>, extra: { progressEveryMs?: number } = {}) => {
  const logs: string[] = [];
  return runGithubJob(e, { log: (l) => logs.push(l), execute, client: { fetchImpl: d.fetchImpl, sleep: async () => undefined, attempts: 3 }, cpus: 2, ...extra }).then((exit) => ({ exit, logs }));
};

describe("runner script", () => {
  it("the bearer token is HMAC-SHA256(secret, job id), the same vector the API test uses", () => {
    expect(runnerToken("k".repeat(32), JOB)).toBe("4c15e44073b36f33ed0124d57eedad050650b8a7e1e54d2183a4332a370a4f2a");
    expect(runnerToken(SECRET, JOB)).toBe(createHmac("sha256", SECRET).update(JOB).digest("hex"));
  });

  it("claims, validates, renders, uploads in parts with checksums, completes; the secret never goes on the wire", async () => {
    const d = apiDouble();
    let spec: ExecuteOptions["spec"] | null = null;
    const { exit, logs } = await run(env(), async (o) => {
      spec = o.spec;
      return okRender(path.join(o.spec.outDir, "video.mp4"));
    }, d);
    expect(exit).toEqual({ code: 0, summary: "done" });
    const paths = d.seen.map((s) => `${s.method} ${s.path}`);
    expect(paths[0]).toBe("POST /claim");
    expect(paths.filter((p) => p.startsWith("PUT /files/video.mp4/parts/"))).toEqual(["PUT /files/video.mp4/parts/0", "PUT /files/video.mp4/parts/1", "PUT /files/video.mp4/parts/2"]);
    expect(paths.slice(-2)).toEqual(["POST /files/video.mp4/complete", "POST /complete"]);
    for (const s of d.seen) {
      expect(s.auth).toBe(`Bearer ${runnerToken(SECRET, JOB)}`);
      expect(s.auth).not.toContain(SECRET);
    }
    const claimBody = JSON.parse(d.seen[0]!.body as string) as Record<string, unknown>;
    expect(claimBody).toEqual({ runId: "777", attempt: 1 });
    const parts = d.seen.filter((s) => s.path.includes("/parts/"));
    expect(parts.map((p) => (p.body as Uint8Array).length)).toEqual([1000, 1000, 500]);
    for (const p of parts) expect(p.headers["x-part-sha256"]).toBe(createHash("sha256").update(p.body as Uint8Array).digest("hex"));
    const fileDone = JSON.parse(d.seen.find((s) => s.path === "/files/video.mp4/complete")!.body as string) as { parts: number; bytes: number; sha256: string };
    expect(fileDone).toMatchObject({ parts: 3, bytes: 2500, sha256: createHash("sha256").update(Buffer.alloc(2500, 5)).digest("hex") });
    // concurrency: the API's number capped by the runner's cores (2 here); timeout from the claim
    expect(spec).toMatchObject({ kind: "render", concurrency: 2, timeoutMs: 60_000, outName: "video.mp4", maxOutputBytes: 80_000_000 });
    // the log: stage names, timings and sizes only
    const text = logs.join("\n");
    expect(text).toMatch(/stage=claim/);
    expect(text).toMatch(/stage=upload files=1 size=0\.00 MB/);
    expect(text).toMatch(/requests=\d+/);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(runnerToken(SECRET, JOB));
    expect(text).not.toContain("api.example.test");
    expect(text).not.toContain(JSON.stringify((claimBody as { runId: string }).runId + "x"));
  });

  it("a preview uploads still-N.jpg per frame and reports the scene info", async () => {
    const d = apiDouble({ claim: baseClaim({ kind: "preview", videoName: null, options: { at: [1, 2], width: 480 }, maxFiles: 2 }) });
    const { exit } = await run(env(), async (o) => {
      mkdirSync(o.spec.outDir, { recursive: true });
      const a = path.join(o.spec.outDir, "a.jpg");
      const b = path.join(o.spec.outDir, "b.jpg");
      writeFileSync(a, Buffer.alloc(300, 1));
      writeFileSync(b, Buffer.alloc(400, 2));
      return { ok: true, result: { t: "result", kind: "preview", stills: [{ file: a, seconds: 1, scene: 0, sceneType: "intro", bytes: 300 }, { file: b, seconds: 2, scene: 1, sceneType: "bullets", bytes: 400 }], totalSeconds: 9 } };
    }, d);
    expect(exit.code).toBe(0);
    const complete = JSON.parse(d.seen.at(-1)!.body as string) as { kind: string; stills: Array<{ name: string; scene: number }> };
    expect(complete.kind).toBe("preview");
    expect(complete.stills.map((s) => s.name)).toEqual(["still-1.jpg", "still-2.jpg"]);
    expect(d.seen.some((s) => s.path === "/files/still-2.jpg/parts/0")).toBe(true);
  });

  it("a claim the API refuses (another run won, job finished) ends quietly with exit 0 and renders nothing", async () => {
    for (const status of [409, 404, 410]) {
      const d = apiDouble({ claim: status });
      let rendered = false;
      const { exit } = await run(env(), async () => {
        rendered = true;
        return { ok: false, code: "render_failed", message: "x" };
      }, d);
      expect(exit.code).toBe(0);
      expect(rendered).toBe(false);
      expect(d.seen).toHaveLength(1);
    }
  });

  it("an engine mismatch (the engine rejects what the API accepted) is reported as engine_mismatch and renders nothing", async () => {
    const d = apiDouble({ claim: baseClaim({ storyboard: { version: 1, title: "t", scenes: [{ type: "nope" }] } }) });
    let rendered = false;
    const { exit, logs } = await run(env(), async () => {
      rendered = true;
      return okRender("/dev/null");
    }, d);
    expect(exit).toEqual({ code: 1, summary: "engine_mismatch" });
    expect(rendered).toBe(false);
    const fail = d.seen.find((s) => s.path === "/fail")!;
    expect(JSON.parse(fail.body as string)).toMatchObject({ code: "engine_mismatch" });
    expect(logs.join("\n")).not.toContain("nope");
  });

  it("a render failure is reported with its code and a bounded message; the log carries only the code", async () => {
    const d = apiDouble();
    const { exit, logs } = await run(env(), async () => ({ ok: false, code: "render_failed", message: `boom ${"y".repeat(1000)} secret storyboard text` }), d);
    expect(exit).toEqual({ code: 1, summary: "render_failed" });
    const fail = JSON.parse(d.seen.find((s) => s.path === "/fail")!.body as string) as { code: string; message: string };
    expect(fail.code).toBe("render_failed");
    expect(fail.message.length).toBeLessThanOrEqual(300);
    expect(logs.join("\n")).not.toContain("secret storyboard text");
  });

  it("the cancel flag from a progress call aborts the render promptly and nothing is uploaded or reported as failure", async () => {
    const d = apiDouble({ progress: [{ cancel: true }] });
    const { exit } = await run(
      env(),
      (o) =>
        new Promise<ExecuteOutcome>((resolve) => {
          o.onProgress({ t: "progress", phase: "render", fraction: 0.1, message: "frame" });
          o.signal.addEventListener("abort", () => resolve({ ok: false, code: "cancelled", message: "cancelled" }));
        }),
      d,
      { progressEveryMs: 10 },
    );
    expect(exit).toEqual({ code: 0, summary: "cancelled" });
    expect(d.seen.some((s) => s.path.includes("/files/") || s.path === "/complete" || s.path === "/fail")).toBe(false);
  });

  it("a 409 on progress (job already finished or cancelled) also stops the render", async () => {
    const d = apiDouble({ progress: [409] });
    const { exit } = await run(
      env(),
      (o) =>
        new Promise<ExecuteOutcome>((resolve) => {
          o.onProgress({ t: "progress", phase: "render", fraction: 0.1, message: "frame" });
          o.signal.addEventListener("abort", () => resolve({ ok: false, code: "cancelled", message: "cancelled" }));
        }),
      d,
      { progressEveryMs: 10 },
    );
    expect(exit.code).toBe(0);
  });

  it("an upload that the API cannot take is reported as upload_failed (or disk_full), not as success", async () => {
    const d = apiDouble({ failOnPart: 1 });
    const { exit } = await run(env(), async (o) => okRender(path.join(o.spec.outDir, "video.mp4")), d);
    expect(exit).toEqual({ code: 1, summary: "upload_failed" });
    expect(JSON.parse(d.seen.find((s) => s.path === "/fail")!.body as string)).toMatchObject({ code: "disk_full" });
  });

  it("network errors are retried with backoff, then the failure is reported when it can be", async () => {
    let n = 0;
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(String(url));
      n++;
      if (n <= 2) throw new Error("ECONNRESET");
      return new Response(JSON.stringify(baseClaim()), { status: 200 });
    }) as unknown as typeof fetch;
    const logs: string[] = [];
    const exit = await runGithubJob(env(), {
      log: (l) => logs.push(l),
      execute: async () => ({ ok: false, code: "browser_missing", message: "x" }),
      client: { fetchImpl, sleep: async () => undefined, attempts: 4 },
    });
    expect(exit.code).toBe(1);
    expect(n).toBeGreaterThanOrEqual(3); // 2 failures + the claim that worked + the failure report
  });

  it("refuses to start on a bad job id, a short secret, a missing run id or an insecure origin (nothing is sent)", async () => {
    const d = apiDouble();
    for (const e of [env({ JOB_ID: "../../etc/passwd" }), env({ VIDEO_RUNNER_SECRET: "short" }), env({ GITHUB_RUN_ID: "" }), env({ VIDEO_API_ORIGIN: "http://evil.example.test" }), env({ VIDEO_API_ORIGIN: "https://user:pw@api.example.test" })]) {
      const { exit } = await run(e, async () => okRender("/dev/null"), d);
      expect(exit.code).toBe(1);
    }
    expect(d.seen).toHaveLength(0);
  });

  it("http is accepted for a loopback origin only (local end-to-end runs)", () => {
    expect(checkOrigin("http://127.0.0.1:4000").hostname).toBe("127.0.0.1");
    expect(() => checkOrigin("http://api.example.test")).toThrow();
  });

  it("the spec comes from the claim: previews use the width and `at`, gifs the window", () => {
    const p = specFor(baseClaim({ kind: "preview", videoName: null, options: { at: [1], width: 320, scene: "intro" } }), "/w", "/c", 8);
    expect(p).toMatchObject({ kind: "preview", width: 320, at: [1], scene: "intro", maxOutputBytes: 600_000, concurrency: 4 });
    const g = specFor(baseClaim({ kind: "gif", videoName: "clip.gif", options: { from: 1, to: 3, loop: true } }), "/w", "/c", 1);
    expect(g).toMatchObject({ kind: "gif", outName: "clip.gif", from: 1, to: 3, loop: true, concurrency: 1 });
  });
});

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatIssues } from "../schema/issues.ts";
import { validateStoryboard } from "../validate.ts";
import type { ExecuteOutcome, ExecuteOptions } from "../worker/execute.ts";
import type { WorkerSpec } from "../worker/protocol.ts";
import { ApiRefused, RunnerClient, sha256Hex, type ClientOptions } from "./client.ts";
import { MIN_SECRET_CHARS, runnerToken, type ClaimResponse, type CompleteBody, type RunnerFailCode } from "./protocol.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RunnerEnv {
  JOB_ID?: string;
  VIDEO_RUNNER_SECRET?: string;
  VIDEO_API_ORIGIN?: string;
  GITHUB_RUN_ID?: string;
  GITHUB_RUN_ATTEMPT?: string;
  BLOG_MOTION_CACHE_DIR?: string;
  RUNNER_TEMP?: string;
}

export interface RunnerDeps {
  /** Prints one line. ONLY stage names, timings and sizes may be passed: the logs of a public repository are public. */
  log: (line: string) => void;
  execute: (opts: ExecuteOptions) => Promise<ExecuteOutcome>;
  client?: Pick<ClientOptions, "fetchImpl" | "sleep" | "attempts">;
  cpus?: number;
  progressEveryMs?: number;
  signal?: AbortSignal;
}

export type RunnerExit = { code: 0 | 1; summary: string };

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const mb = (b: number): string => `${(b / 1024 / 1024).toFixed(2)} MB`;

/** The whole runner job. Never throws; always tries to tell the API the outcome. Returns the process exit code. */
export async function runGithubJob(env: RunnerEnv, deps: RunnerDeps): Promise<RunnerExit> {
  const { log } = deps;
  const jobId = env.JOB_ID ?? "";
  if (!UUID.test(jobId)) return { code: 1, summary: "job id is not valid" };
  const secret = env.VIDEO_RUNNER_SECRET ?? "";
  if (secret.length < MIN_SECRET_CHARS) return { code: 1, summary: "VIDEO_RUNNER_SECRET is missing or too short" };
  const runId = (env.GITHUB_RUN_ID ?? "").replace(/\D/g, "").slice(0, 20);
  if (!runId) return { code: 1, summary: "GITHUB_RUN_ID is missing" };
  const attempt = Math.max(1, Number(env.GITHUB_RUN_ATTEMPT) || 1);

  let api: RunnerClient;
  try {
    api = new RunnerClient({ origin: env.VIDEO_API_ORIGIN ?? "", token: runnerToken(secret, jobId), jobId, ...deps.client });
  } catch (e) {
    return { code: 1, summary: (e as Error).message };
  }

  const t0 = Date.now();
  const report = async (code: RunnerFailCode, message: string): Promise<void> => {
    try {
      await api.json("POST", "/fail", { code, message: message.slice(0, 300) });
    } catch {
      /* the API watchdog fails the job when it hears nothing */
    }
  };

  // 1) claim
  log("stage=claim");
  let claim: ClaimResponse;
  try {
    claim = await api.json<ClaimResponse>("POST", "/claim", { runId, attempt });
  } catch (e) {
    const code = e instanceof ApiRefused ? `${e.status} ${e.code}` : "error";
    // 409/404: the job is finished, cancelled or claimed by another run: nothing to do here.
    if (e instanceof ApiRefused && (e.status === 409 || e.status === 404 || e.status === 410)) return { code: 0, summary: `claim refused (${code}); nothing to do` };
    return { code: 1, summary: `claim failed (${code})` };
  }
  log(`stage=claimed kind=${claim.kind}`);

  const work = mkdtempSync(path.join(env.RUNNER_TEMP ?? os.tmpdir(), "blog-video-"));
  const abort = new AbortController();
  if (deps.signal) {
    if (deps.signal.aborted) abort.abort();
    else deps.signal.addEventListener("abort", () => abort.abort(), { once: true });
  }
  let cancelled = false;
  let latest: { phase: string; fraction: number | null; message: string } | null = null;
  let progressBusy = false;
  const pump = setInterval(() => {
    if (progressBusy || !latest) return;
    progressBusy = true;
    const body = latest;
    void api
      .json<{ cancel?: boolean }>("POST", "/progress", body)
      .then((r) => {
        if (r.cancel) {
          cancelled = true;
          abort.abort();
        }
      })
      .catch((e: unknown) => {
        // The job is gone (cancelled, finished or expired): stop rendering.
        if (e instanceof ApiRefused && (e.status === 409 || e.status === 404)) {
          cancelled = true;
          abort.abort();
        }
      })
      .finally(() => {
        progressBusy = false;
      });
  }, deps.progressEveryMs ?? 3000);

  try {
    // 2) validate again with the engine's own validator (the API validated with the same code, but the two checkouts may differ)
    const checked = validateStoryboard(claim.storyboard);
    if (!checked.ok) {
      log("stage=validate result=engine_mismatch");
      await report("engine_mismatch", `The API accepted this storyboard but the render engine on the runner rejected it (${checked.issues.length} issue(s)). First: ${formatIssues(checked.issues.slice(0, 1))}`);
      return { code: 1, summary: "engine_mismatch" };
    }
    const spec = specFor(claim, work, env.BLOG_MOTION_CACHE_DIR ?? path.join(work, "cache"), deps.cpus ?? os.availableParallelism());
    const storyboardFile = path.join(work, "storyboard.json");
    writeFileSync(storyboardFile, JSON.stringify(claim.storyboard));
    spec.storyboardFile = storyboardFile;

    // 3) render
    log("stage=render");
    const rStart = Date.now();
    const outcome = await deps.execute({
      spec,
      input: JSON.parse(readFileSync(storyboardFile, "utf8")) as unknown,
      totalSeconds: checked.timeline.totalSeconds,
      signal: abort.signal,
      onProgress: (m) => {
        latest = { phase: m.phase, fraction: m.fraction, message: m.message.slice(0, 120) };
      },
    });
    const renderMs = Date.now() - rStart;
    if (cancelled || (!outcome.ok && outcome.code === "cancelled")) {
      log("stage=cancelled");
      if (!cancelled) await report("cancelled", "cancelled");
      return { code: 0, summary: "cancelled" };
    }
    if (!outcome.ok) {
      log(`stage=render result=${outcome.code} elapsed=${secs(renderMs)}`);
      await report(outcome.code as RunnerFailCode, outcome.message);
      return { code: 1, summary: outcome.code };
    }
    log(`stage=render result=ok elapsed=${secs(renderMs)}`);

    // 4) upload in parts, then complete
    latest = { phase: "uploading", fraction: 0, message: "uploading result" };
    const uStart = Date.now();
    const files = outcome.result.kind === "preview" ? outcome.result.stills.map((s, i) => ({ name: `still-${i + 1}.jpg`, file: s.file })) : [{ name: claim.videoName as string, file: outcome.result.file }];
    let uploaded = 0;
    try {
      for (const f of files) {
        if (abort.signal.aborted) throw new ApiRefused(409, "cancelled");
        uploaded += await uploadFile(api, f.name, f.file, claim.partBytes);
      }
    } catch (e) {
      if (cancelled || abort.signal.aborted) return { code: 0, summary: "cancelled" };
      const code = e instanceof ApiRefused ? `${e.status} ${e.code}` : "error";
      log(`stage=upload result=failed (${code})`);
      await report(e instanceof ApiRefused && e.code === "disk_full" ? "disk_full" : "upload_failed", `upload failed (${code})`);
      return { code: 1, summary: "upload_failed" };
    }
    const uploadMs = Date.now() - uStart;
    log(`stage=upload files=${files.length} size=${mb(uploaded)} elapsed=${secs(uploadMs)}`);

    const body: CompleteBody =
      outcome.result.kind === "preview"
        ? {
            kind: "preview",
            stills: outcome.result.stills.map((s, i) => ({ name: `still-${i + 1}.jpg`, seconds: s.seconds, scene: s.scene, sceneType: s.sceneType })),
            timings: { renderMs, uploadMs },
          }
        : {
            kind: outcome.result.kind,
            video: { name: claim.videoName as string, seconds: outcome.result.seconds, frames: outcome.result.frames, renderMs: outcome.result.renderMs },
            timings: { renderMs, uploadMs },
          };
    try {
      await api.json("POST", "/complete", body);
    } catch (e) {
      const code = e instanceof ApiRefused ? `${e.status} ${e.code}` : "error";
      log(`stage=complete result=failed (${code})`);
      if (e instanceof ApiRefused && e.status === 409) return { code: 0, summary: "job was already finished" };
      await report("upload_failed", `completion failed (${code})`);
      return { code: 1, summary: "complete_failed" };
    }
    log(`stage=done total=${secs(Date.now() - t0)} requests=${api.requests}`);
    return { code: 0, summary: "done" };
  } catch (e) {
    log(`stage=internal_error name=${e instanceof Error ? e.name : "unknown"}`);
    await report("runner_internal", "the runner failed unexpectedly");
    return { code: 1, summary: "runner_internal" };
  } finally {
    clearInterval(pump);
    rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

export function specFor(claim: ClaimResponse, work: string, cacheDir: string, cpus: number): WorkerSpec {
  const o = claim.options;
  return {
    kind: claim.kind,
    storyboardFile: path.join(work, "storyboard.json"),
    outDir: path.join(work, "out"),
    cacheDir,
    concurrency: Math.max(1, Math.min(claim.concurrency, cpus, 8)),
    timeoutMs: claim.timeoutSeconds * 1000,
    ...(claim.kind === "preview"
      ? { width: o.width ?? 480, ...(o.at ? { at: o.at } : {}), maxOutputBytes: claim.stillMaxBytes }
      : { outName: claim.videoName as string, maxOutputBytes: claim.videoMaxBytes }),
    ...(o.scene !== undefined ? { scene: o.scene } : {}),
    ...(claim.kind === "gif" ? { ...(o.from !== undefined ? { from: o.from } : {}), ...(o.to !== undefined ? { to: o.to } : {}), ...(o.loop ? { loop: true } : {}) } : {}),
  };
}

/** Uploads one file in parts of at most `partBytes`; every part carries its SHA-256, a retried part replaces itself. Returns the byte count. */
export async function uploadFile(api: RunnerClient, name: string, file: string, partBytes: number): Promise<number> {
  const size = statSync(file).size;
  const fd = openSync(file, "r");
  try {
    const whole = createHash("sha256");
    let n = 0;
    for (let offset = 0; offset < size || (size === 0 && n === 0); offset += partBytes, n++) {
      const len = Math.min(partBytes, size - offset);
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const r = readSync(fd, buf, got, len - got, offset + got);
        if (r === 0) break;
        got += r;
      }
      whole.update(buf);
      await api.bytes(`/files/${name}/parts/${n}`, buf, { "x-part-sha256": sha256Hex(buf) });
      if (size === 0) break;
    }
    await api.json("POST", `/files/${name}/complete`, { parts: n, bytes: size, sha256: whole.digest("hex") });
    return size;
  } finally {
    closeSync(fd);
  }
}

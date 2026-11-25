import { spawn, execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../../config.js";
import { cacheDirOf, jobDirOf, motionDir, workerEntry, xdgDirOf } from "./paths.js";

/**
 * Render ishchisini (alohida jarayon) ishga tushiruvchi va nazorat qiluvchi qatlam. Render API jarayonida HECH QACHON bajarilmaydi.
 *
 * Izolyatsiya va cheklovlar:
 *  - alohida jarayon GURUHI (`detached`): timeout, bekor qilish, xotira shifti va API to'xtashi guruhning HAMMASINI (Node + Chrome + ffmpeg) o'ldiradi;
 *  - past CPU ustuvorligi (`nice`), V8 heap chegarasi, Remotion concurrency (default 1);
 *  - xotira shifti: har soniyada guruh RSS yig'indisi o'lchanadi (`ps`), shiftdan oshsa guruh o'ldiriladi (cgroup talab qilinmaydi);
 *  - o'z vaqtinchalik (`TMPDIR`) va kesh papkalari: ish papkasi oxirida BUTUNLAY o'chiriladi;
 *  - muhit: sirlarsiz — faqat PATH, HOME/TMPDIR (ish papkasi ichida), kesh yo'llari; `DATABASE_URL`, tokenlar va boshqalar o'tmaydi;
 *  - ishchi ota jarayon o'lsa (masalan SIGKILL) o'zi to'xtaydi (`--parent-pid`).
 */

export type WorkerMessage =
  | { t: "progress"; phase: string; fraction: number | null; message: string }
  | { t: "result"; kind: "preview"; stills: Array<{ file: string; seconds: number; scene: number; sceneType: string; bytes: number }>; totalSeconds: number }
  | { t: "result"; kind: "render" | "gif"; file: string; bytes: number; frames: number; seconds: number; renderMs: number }
  | { t: "error"; code: string; message: string; issues?: unknown[] };

export interface WorkerSpec {
  kind: "preview" | "render" | "gif";
  storyboardFile: string;
  outDir: string;
  outName?: string;
  cacheDir: string;
  concurrency?: number;
  timeoutMs?: number;
  browserExecutable?: string;
  at?: number[];
  width?: number;
  quality?: number;
  scene?: string;
  from?: number;
  to?: number;
  loop?: boolean;
}

export type RunOutcome =
  | { outcome: "result"; result: Extract<WorkerMessage, { t: "result" }> }
  | { outcome: "error"; code: string; message: string; issues?: unknown[] }
  | { outcome: "timeout" }
  | { outcome: "cancelled" }
  | { outcome: "memory"; peakRssMb: number }
  | { outcome: "crashed"; message: string };

export interface RunReport {
  outcome: RunOutcome;
  peakRssMb: number;
  wallMs: number;
}

export interface WorkerLaunch {
  command: string;
  args: string[];
  cwd: string;
}

export interface RunOptions {
  jobId: string;
  spec: WorkerSpec;
  /** Ishchi tashqi devor soati chegarasi; ishchining o'z taymeri undan oldin ishlaydi. */
  timeoutMs: number;
  memoryLimitMb: number;
  signal: AbortSignal;
  onProgress: (m: Extract<WorkerMessage, { t: "progress" }>) => void;
  onSpawn?: (pid: number) => void;
}

const KILL_GRACE_MS = 4000;
const MEM_POLL_MS = 1000;
const MAX_LINE = 2 * 1024 * 1024;

/** Hozir ishlayotgan ishchilar guruhi (pid = guruh rahbari). API to'xtaganda hammasi o'ldiriladi. */
const live = new Map<number, { jobId: string }>();

export const liveWorkerCount = (): number => live.size;

let launchOverride: ((spec: WorkerSpec, specFile: string) => WorkerLaunch) | null = null;

/** Faqat testlar uchun: soxta ishchi (render o'rniga). */
export function setWorkerLaunchForTests(fn: ((spec: WorkerSpec, specFile: string) => WorkerLaunch) | null): void {
  launchOverride = fn;
}

function defaultLaunch(specFile: string): WorkerLaunch {
  return {
    command: process.execPath,
    args: [`--max-old-space-size=${config.VIDEO_WORKER_HEAP_MB}`, "--disable-warning=ExperimentalWarning", workerEntry(), specFile, "--parent-pid", String(process.pid)],
    cwd: motionDir(),
  };
}

/** Ishchi muhiti: sirlar YO'Q. */
export function workerEnv(jobDir: string): Record<string, string> {
  const nodeBin = path.dirname(process.execPath);
  return {
    PATH: `${nodeBin}:/usr/local/bin:/usr/bin:/bin`,
    HOME: path.join(jobDir, "home"),
    TMPDIR: path.join(jobDir, "tmp"),
    TMP: path.join(jobDir, "tmp"),
    TEMP: path.join(jobDir, "tmp"),
    XDG_CACHE_HOME: xdgDirOf(),
    BLOG_MOTION_CACHE_DIR: cacheDirOf(),
    LANG: "C.UTF-8",
    NODE_ENV: "production",
  };
}

const killGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal);
  } catch {
    // guruh allaqachon yo'q
  }
};

/** Bir martalik `ps` o'lchovi: guruhdagi barcha jarayonlar RSS yig'indisi (MB). */
export function groupRssMb(pgid: number): Promise<number> {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pgid=,rss="], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(0);
      let kb = 0;
      for (const line of stdout.split("\n")) {
        const [g, r] = line.trim().split(/\s+/);
        if (Number(g) === pgid) kb += Number(r) || 0;
      }
      resolve(Math.round(kb / 1024));
    });
  });
}

export async function runWorker(opts: RunOptions): Promise<RunReport> {
  const jobDir = jobDirOf(opts.jobId);
  for (const sub of ["home", "tmp", "out"]) mkdirSync(path.join(jobDir, sub), { recursive: true });
  mkdirSync(cacheDirOf(), { recursive: true });
  mkdirSync(xdgDirOf(), { recursive: true });
  const specFile = path.join(jobDir, "spec.json");
  writeFileSync(specFile, JSON.stringify(opts.spec));

  const launch = (launchOverride ?? ((_s: WorkerSpec, f: string) => defaultLaunch(f)))(opts.spec, specFile);
  const started = Date.now();
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: workerEnv(jobDir),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  if (pid === undefined) return { outcome: { outcome: "crashed", message: "the render worker could not be started" }, peakRssMb: 0, wallMs: Date.now() - started };
  live.set(pid, { jobId: opts.jobId });
  opts.onSpawn?.(pid);
  try {
    os.setPriority(pid, config.VIDEO_WORKER_NICE);
  } catch {
    // ustuvorlikni pasaytirib bo'lmadi (ruxsat yo'q) — davom etamiz
  }

  let message: Extract<WorkerMessage, { t: "result" | "error" }> | null = null;
  let buffered = "";
  let stderrTail = "";
  let reason: "timeout" | "cancelled" | "memory" | null = null;
  let peakRssMb = 0;
  let exited = false;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    if (buffered.length > MAX_LINE && !buffered.includes("\n")) buffered = "";
    let nl: number;
    while ((nl = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (!line) continue;
      let parsed: WorkerMessage;
      try {
        parsed = JSON.parse(line) as WorkerMessage;
      } catch {
        continue;
      }
      if (parsed.t === "progress") opts.onProgress(parsed);
      else if (parsed.t === "result" || parsed.t === "error") message = parsed;
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
  });

  const stop = (why: "timeout" | "cancelled" | "memory"): void => {
    if (reason || exited) return;
    reason = why;
    killGroup(pid, "SIGTERM");
    setTimeout(() => killGroup(pid, "SIGKILL"), KILL_GRACE_MS).unref();
  };

  const timer = setTimeout(() => stop("timeout"), opts.timeoutMs);
  const onAbort = (): void => stop("cancelled");
  if (opts.signal.aborted) onAbort();
  else opts.signal.addEventListener("abort", onAbort, { once: true });

  let polling = false;
  const mem = setInterval(() => {
    if (polling || exited) return;
    polling = true;
    void groupRssMb(pid)
      .then((mb) => {
        if (mb > peakRssMb) peakRssMb = mb;
        if (opts.memoryLimitMb > 0 && mb > opts.memoryLimitMb) stop("memory");
      })
      .finally(() => {
        polling = false;
      });
  }, MEM_POLL_MS);

  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code));
  });
  exited = true;
  clearTimeout(timer);
  clearInterval(mem);
  opts.signal.removeEventListener("abort", onAbort);
  // Chrome/ffmpeg bolalari qolgan bo'lishi mumkin: guruhni yakuniy o'ldirish (jarayon allaqachon tugagan bo'lsa ESRCH — jim).
  killGroup(pid, "SIGKILL");
  live.delete(pid);
  rmSync(path.join(jobDir, "tmp"), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  rmSync(path.join(jobDir, "home"), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

  const wallMs = Date.now() - started;
  const final = message as Extract<WorkerMessage, { t: "result" | "error" }> | null;
  let outcome: RunOutcome;
  if (reason === "timeout") outcome = { outcome: "timeout" };
  else if (reason === "cancelled") outcome = { outcome: "cancelled" };
  else if (reason === "memory") outcome = { outcome: "memory", peakRssMb };
  else if (final?.t === "result") outcome = { outcome: "result", result: final };
  else if (final?.t === "error") outcome = { outcome: "error", code: final.code, message: final.message, ...(final.issues ? { issues: final.issues } : {}) };
  else outcome = { outcome: "crashed", message: `the render worker ended unexpectedly (exit ${exitCode ?? "none"})${stderrTail ? `: ${stderrTail.trim().split("\n").slice(-2).join(" | ").slice(0, 300)}` : ""}` };
  return { outcome, peakRssMb, wallMs };
}

/** API to'xtaganda yoki xatoda: barcha ishchi guruhlarini SINXRON o'ldiradi (process 'exit' ichida ham ishlaydi). */
export function killAllWorkersSync(): number {
  let n = 0;
  for (const pid of live.keys()) {
    killGroup(pid, "SIGKILL");
    n++;
  }
  return n;
}

/**
 * Oldingi API jarayoni qulaganda qolib ketgan ishchi guruhini topib o'ldiradi: faqat pid HALI ham bizning ishchi buyrug'ini
 * ishlatayotgan bo'lsa (pid qayta ishlatilgan bo'lishi mumkin).
 */
export function killStaleWorker(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("ps", ["-p", String(pid), "-o", "command="], { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout.includes("worker/main.ts")) return resolve(false);
      killGroup(pid, "SIGKILL");
      resolve(true);
    });
  });
}

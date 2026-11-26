import { execFile } from "node:child_process";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { MotionStatus } from "@blog/shared";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import { motionJobs } from "../../db/schema.js";
import { cliEntry, motionDir } from "./paths.js";
import { countCreatedToday, queueCounts } from "./jobs.js";
import { getGithubConfig } from "./github.js";
import { localPreflight } from "./local-preflight.js";
import { probeResources } from "./resources.js";
import { runnerSecretConfigured } from "./runner-token.js";

export interface BrowserInfo {
  installed: boolean;
  path: string | null;
  hint: string | null;
}

let cache: { at: number; value: BrowserInfo } | null = null;
let probeOverride: (() => Promise<BrowserInfo>) | null = null;
const TTL_MS = 60_000;

/** Faqat testlar uchun. */
export function setBrowserProbeForTests(fn: (() => Promise<BrowserInfo>) | null): void {
  probeOverride = fn;
  cache = null;
}

function probeBrowser(): Promise<BrowserInfo> {
  return new Promise((resolve) => {
    const args = ["--disable-warning=ExperimentalWarning", cliEntry(), "browser", "status", "--json", ...(config.VIDEO_BROWSER_PATH ? ["--browser", config.VIDEO_BROWSER_PATH] : [])];
    // Brauzer holatini bola jarayon aytadi (API render kodini yuklamaydi); muhit — sirlarsiz.
    execFile(process.execPath, args, { cwd: motionDir(), timeout: 20_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", NODE_ENV: "production" } }, (_err, stdout) => {
      try {
        const parsed = JSON.parse(stdout) as { installed?: boolean; path?: string; hint?: string };
        resolve({ installed: parsed.installed === true, path: parsed.path ?? null, hint: parsed.installed ? null : (parsed.hint ?? "Run scripts/setup-motion-browser.sh once on the server.") });
      } catch {
        resolve({ installed: false, path: null, hint: "Could not check the browser. Run scripts/setup-motion-browser.sh once on the server." });
      }
    });
  });
}

export async function getBrowserInfo(force = false): Promise<BrowserInfo> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const value = await (probeOverride ?? probeBrowser)();
  cache = { at: Date.now(), value };
  return value;
}

async function lastSuccessAt(): Promise<string | null> {
  const [row] = await db
    .select({ at: motionJobs.finishedAt })
    .from(motionJobs)
    .where(and(eq(motionJobs.runner, "github"), eq(motionJobs.status, "ready"), isNotNull(motionJobs.finishedAt)))
    .orderBy(desc(motionJobs.finishedAt))
    .limit(1);
  return row?.at?.toISOString() ?? null;
}

/** Holat: backend, nima sozlangani (qiymatlarsiz) va oxirgi muvaffaqiyatli run. `github` backendda serverda brauzer TEKSHIRILMAYDI. */
export async function videoStatus(): Promise<MotionStatus> {
  const github = config.VIDEO_RUNNER === "github";
  const [q, today] = await Promise.all([queueCounts(), countCreatedToday()]);
  const res = probeResources();
  let githubInfo: MotionStatus["github"] = null;
  if (github) {
    const c = await getGithubConfig();
    githubInfo = { tokenConfigured: Boolean(c.token), secretConfigured: runnerSecretConfigured(), repoConfigured: Boolean(c.repo), repo: c.repo || null, lastSuccessAt: await lastSuccessAt() };
  }
  const pre = github ? null : localPreflight();
  const browser = github ? null : await getBrowserInfo();
  return {
    enabled: true,
    runner: config.VIDEO_RUNNER,
    github: githubInfo,
    local: pre ? { preflightOk: pre.ok, hint: pre.ok ? null : pre.hint } : null,
    browser: browser ? { installed: browser.installed, hint: browser.hint } : null,
    queue: { queued: q.queued, running: q.running, maxQueue: config.VIDEO_MAX_QUEUE, maxRunning: github ? config.VIDEO_MAX_RUNNING : Math.min(2, config.VIDEO_MAX_RUNNING) },
    quotas: { rendersToday: today.renders, maxRendersPerDay: config.VIDEO_MAX_RENDERS_PER_DAY, previewsToday: today.previews, maxPreviewsPerDay: config.VIDEO_MAX_PREVIEWS_PER_DAY },
    resources: { freeDiskMb: res.freeDiskMb, freeMemoryMb: github ? null : res.freeMemoryMb, minFreeDiskMb: config.VIDEO_MIN_FREE_DISK_MB, minFreeMemoryMb: github ? 0 : config.VIDEO_MIN_FREE_MEMORY_MB },
  };
}

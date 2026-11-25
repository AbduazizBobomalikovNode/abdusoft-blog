import { execFile } from "node:child_process";
import type { MotionStatus } from "@blog/shared";
import { config } from "../../config.js";
import { cliEntry, motionDir } from "./paths.js";
import { countCreatedToday, queueCounts } from "./jobs.js";
import { probeResources } from "./resources.js";

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

export async function videoStatus(): Promise<MotionStatus> {
  const [browser, q, today] = await Promise.all([getBrowserInfo(), queueCounts(), countCreatedToday()]);
  const res = probeResources();
  return {
    enabled: true,
    browser: { installed: browser.installed, hint: browser.hint },
    queue: { queued: q.queued, running: q.running, maxQueue: config.VIDEO_MAX_QUEUE, maxRunning: config.VIDEO_MAX_RUNNING },
    quotas: { rendersToday: today.renders, maxRendersPerDay: config.VIDEO_MAX_RENDERS_PER_DAY, previewsToday: today.previews, maxPreviewsPerDay: config.VIDEO_MAX_PREVIEWS_PER_DAY },
    resources: { freeDiskMb: res.freeDiskMb, freeMemoryMb: res.freeMemoryMb, minFreeDiskMb: config.VIDEO_MIN_FREE_DISK_MB, minFreeMemoryMb: config.VIDEO_MIN_FREE_MEMORY_MB },
  };
}

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SweepOptions {
  /** Directory scanned for leftover `blog-motion-*` render scratch dirs (default os.tmpdir()). */
  tmpRoot?: string;
  /** Remove EVERY stale entry of tmpRoot (per-job directories, Remotion's scratch, browser profiles), not only `blog-motion-*`. Only for a directory this program owns. */
  ownTmpRoot?: boolean;
  /** The bundle cache directory to tidy. */
  cacheDir?: string;
  /** Anything older than this is stale (default 30 min; a render never runs that long without touching its dir). */
  maxAgeMs?: number;
  /** Newest `bundle-*` directories to keep besides `keepBundle` (default 1). */
  keepBundles?: number;
  /** The bundle directory name currently in use (never removed). */
  keepBundle?: string;
  now?: number;
}

export interface SweepResult {
  removed: string[];
}

const ageOf = (p: string, now: number): number => {
  try {
    return now - statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

const rm = (p: string, removed: string[]): void => {
  try {
    rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    removed.push(p);
  } catch {
    /* in use or already gone: the next sweep retries */
  }
};

/**
 * Startup sweep: removes scratch directories a crashed or killed render left behind, abandoned half-built bundles
 * (`bundle-*.tmp-*`) and old bundle caches (every source change makes a new `bundle-<hash>`; only the newest few stay).
 * Never throws.
 */
export function sweepStale(opts: SweepOptions = {}): SweepResult {
  const removed: string[] = [];
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? 30 * 60 * 1000;
  try {
    const tmpRoot = opts.tmpRoot ?? os.tmpdir();
    if (existsSync(tmpRoot)) {
      for (const name of readdirSync(tmpRoot)) {
        const mine = name.startsWith("blog-motion-");
        const remotion = opts.ownTmpRoot === true;
        if (!mine && !remotion) continue;
        const full = path.join(tmpRoot, name);
        if (ageOf(full, now) > maxAge) rm(full, removed);
      }
    }
    if (opts.cacheDir && existsSync(opts.cacheDir)) {
      const bundles: Array<{ name: string; mtime: number }> = [];
      for (const name of readdirSync(opts.cacheDir)) {
        const full = path.join(opts.cacheDir, name);
        if (/^bundle-[0-9a-f]+\.tmp-/.test(name)) {
          if (ageOf(full, now) > 10 * 60 * 1000) rm(full, removed);
        } else if (/^bundle-[0-9a-f]+$/.test(name)) {
          try {
            bundles.push({ name, mtime: statSync(full).mtimeMs });
          } catch {
            /* gone */
          }
        }
      }
      bundles.sort((a, b) => b.mtime - a.mtime);
      const others = bundles.filter((b) => b.name !== opts.keepBundle);
      const keep = new Set(others.slice(0, opts.keepBundles ?? 1).map((b) => b.name));
      for (const b of others) if (!keep.has(b.name)) rm(path.join(opts.cacheDir, b.name), removed);
    }
  } catch {
    /* a sweep is best effort */
  }
  return { removed };
}

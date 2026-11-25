import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Remotion writes its working files (frame assets, audio mixing dirs, the encoder's scratch) under
 * os.tmpdir() and does not remove them when a render is cancelled. To guarantee cleanup, every Remotion
 * call that renders runs with TMPDIR/TMP/TEMP pointing at a private directory that is deleted afterwards,
 * whether the call finished, failed or was cancelled.
 *
 * The environment is process-wide, so calls are serialised: one rendering call at a time per process
 * (a future job queue should run renders in separate worker processes anyway). The browser itself is
 * opened outside this scope, so its profile directory is owned and removed by the browser.
 */
let queue: Promise<unknown> = Promise.resolve();

const VARS = ["TMPDIR", "TMP", "TEMP"] as const;

export function withPrivateTmp<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "blog-motion-"));
    const saved = VARS.map((v) => [v, process.env[v]] as const);
    for (const v of VARS) process.env[v] = dir;
    try {
      return await fn();
    } finally {
      for (const [v, old] of saved) {
        if (old === undefined) delete process.env[v];
        else process.env[v] = old;
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

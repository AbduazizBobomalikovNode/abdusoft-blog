import os from "node:os";

/** Frames rendered in parallel. One is the safe default for a small shared server; each extra one costs ~0.4-0.6 GB of browser memory. */
export const DEFAULT_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 8;

/** Whole-job wall clock (bundle + browser + frames + encode), library default. */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 60 * 60 * 1000;

/** Clamp a requested parallelism to 1..min(MAX_CONCURRENCY, CPU count). Non-numbers fall back to the default. */
export function clampConcurrency(requested: number | undefined | null, cpus: number = os.availableParallelism()): number {
  const ceiling = Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(cpus) || 1));
  if (requested === undefined || requested === null || !Number.isFinite(requested)) return Math.min(DEFAULT_CONCURRENCY, ceiling);
  return Math.min(ceiling, Math.max(1, Math.floor(requested)));
}

/** Clamp a requested whole-job timeout to [MIN_TIMEOUT_MS, MAX_TIMEOUT_MS]. */
export function clampTimeoutMs(requested: number | undefined | null): number {
  if (requested === undefined || requested === null || !Number.isFinite(requested)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(requested)));
}

import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { BUNDLE_ENTRY, DEFAULT_CACHE_DIR, PACKAGE_ROOT } from "./paths.ts";
import { sourceHash } from "./source-hash.ts";

export interface BundleResult {
  serveUrl: string;
  hash: string;
  cached: boolean;
  ms: number;
}

/** <cache>/bundle-<hash16>: the Remotion bundle for one exact set of engine sources. */
export const bundleDir = (cacheDir: string, hash: string): string => path.join(cacheDir, `bundle-${hash.slice(0, 16)}`);

/**
 * Webpack-bundle the composition once per source hash (~10-25 s cold); later calls reuse the directory.
 * The bundle is built into a temp directory and renamed into place, so a crash or a concurrent run never
 * leaves a half-written bundle that a later run would trust.
 */
export async function ensureBundle(cacheDir: string = DEFAULT_CACHE_DIR, onProgress?: (fraction: number) => void): Promise<BundleResult> {
  const { hash } = sourceHash();
  const dir = bundleDir(cacheDir, hash);
  if (existsSync(path.join(dir, "index.html"))) return { serveUrl: dir, hash, cached: true, ms: 0 };
  const t0 = Date.now();
  mkdirSync(cacheDir, { recursive: true });
  const tmp = `${dir}.tmp-${process.pid}-${t0}`;
  const { bundle } = await import("@remotion/bundler");
  try {
    await bundle({
      entryPoint: BUNDLE_ENTRY,
      outDir: tmp,
      rootDir: PACKAGE_ROOT,
      onProgress: (p) => onProgress?.(p / 100),
    });
    try {
      renameSync(tmp, dir);
    } catch (err) {
      if (!existsSync(path.join(dir, "index.html"))) throw err; // a concurrent bundler won the race: use theirs
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  return { serveUrl: dir, hash, cached: false, ms: Date.now() - t0 };
}

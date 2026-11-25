import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Package root (packages/motion). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BUNDLE_DIR = path.join(PACKAGE_ROOT, "src", "bundle");
export const BUNDLE_ENTRY = path.join(BUNDLE_DIR, "index.ts");
export const FONT_DIR = path.join(PACKAGE_ROOT, "assets", "fonts");

/**
 * Where the (re-creatable) webpack bundle cache lives. Never inside the package: an install or deploy that replaces
 * the package tree must not delete or be polluted by it. `BLOG_MOTION_CACHE_DIR` wins, then the XDG cache
 * directory, then the user's home. The render worker always passes an explicit directory under its data dir.
 */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BLOG_MOTION_CACHE_DIR) return path.resolve(env.BLOG_MOTION_CACHE_DIR);
  const base = env.XDG_CACHE_HOME ? path.resolve(env.XDG_CACHE_HOME) : path.join(os.homedir(), ".cache");
  return path.join(base, "blog-motion");
}

export const DEFAULT_CACHE_DIR = defaultCacheDir();

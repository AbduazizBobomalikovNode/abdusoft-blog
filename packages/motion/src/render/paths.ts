import path from "node:path";
import { fileURLToPath } from "node:url";

/** Package root (packages/motion). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BUNDLE_DIR = path.join(PACKAGE_ROOT, "src", "bundle");
export const BUNDLE_ENTRY = path.join(BUNDLE_DIR, "index.ts");
export const FONT_DIR = path.join(PACKAGE_ROOT, "assets", "fonts");
export const DEFAULT_CACHE_DIR = process.env.BLOG_MOTION_CACHE_DIR ?? path.join(PACKAGE_ROOT, ".cache");

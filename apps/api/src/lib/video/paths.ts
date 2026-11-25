import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config.js";
import { uploadsDir } from "../media/store.js";

/** `@blog/motion` paketi papkasi: `VIDEO_MOTION_DIR` yoki monorepo ichidagi `packages/motion` (yuqoriga qarab qidiriladi). */
export function motionDir(): string {
  if (config.VIDEO_MOTION_DIR) return path.resolve(config.VIDEO_MOTION_DIR);
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "packages", "motion");
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/motion");
}

/** Ishchi ma'lumotlar: `jobs/<id>/` (vaqtinchalik), `cache/` (bundle keshi), `xdg/` (shrift keshi). */
export function dataDir(): string {
  return config.VIDEO_DATA_DIR ? path.resolve(config.VIDEO_DATA_DIR) : path.resolve(uploadsDir, "..", "video");
}

export const jobsRoot = (): string => path.join(dataDir(), "jobs");
export const jobDirOf = (jobId: string): string => path.join(jobsRoot(), jobId);
export const cacheDirOf = (): string => path.join(dataDir(), "cache");
export const xdgDirOf = (): string => path.join(dataDir(), "xdg");

/** Ishchi jarayon kirish fayli (TS manba; Node 24 turlarni o'zi olib tashlaydi). */
export const workerEntry = (): string => path.join(motionDir(), "src", "worker", "main.ts");
export const cliEntry = (): string => path.join(motionDir(), "src", "cli.ts");

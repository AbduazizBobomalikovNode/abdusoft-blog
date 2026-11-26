import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_WORKER = path.join(here, "fake-video-worker.mjs");

/** A storyboard whose `title` tells the fake worker what to do. */
export const sbOf = (mode = "ok", scenes = 3): Record<string, unknown> => ({
  version: 1,
  title: mode,
  theme: "dark",
  scenes: [
    { type: "intro", id: "intro", variant: "aurora", title: "Salom dunyo", subtitle: "Sinov" },
    ...(scenes > 2 ? Array.from({ length: scenes - 2 }, (_, i) => ({ type: "bullets", id: `b${i + 1}`, heading: `Bo'lim ${i + 1}`, items: ["Birinchi", "Ikkinchi"] })) : []),
    { type: "closing", id: "bye", variant: "aurora", cta: "Oʻqing", url: "blog.abdusoft.uz" },
  ],
});

export interface VideoTestEnv {
  dir: string;
  cwd: string;
  cleanup: () => void;
}

/** Temp data dir + working dir for the fake worker; `VIDEO_DATA_DIR` must be set in `vi.hoisted` to `dir`. */
export function makeVideoDir(): VideoTestEnv {
  const dir = mkdtempSync(path.join(os.tmpdir(), "video-test-"));
  const cwd = path.join(dir, "cwd");
  mkdirSync(cwd, { recursive: true });
  return { dir, cwd, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const readPid = (cwd: string, name: string): number | null => {
  try {
    return Number(readFileSync(path.join(cwd, name), "utf8"));
  } catch {
    return null;
  }
};

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 15_000, step = 50): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, step));
  }
}

export { eq };

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Smallest glibc the Remotion compositor binary runs on (Ubuntu 22.04 has 2.35, Ubuntu 20.04 has 2.31). */
export const MIN_GLIBC = [2, 35] as const;

export interface PreflightResult {
  ok: boolean;
  /** One line per step: "name: ok" or "name: FAILED - reason". */
  steps: string[];
  /** A clear instruction when it failed. */
  message: string | null;
  glibc: string | null;
}

/** glibc of the running Node (Linux only). `null` elsewhere. */
export function glibcVersion(): string | null {
  if (process.platform !== "linux") return null;
  try {
    const header = (process.report.getReport() as unknown as { header?: { glibcVersionRuntime?: string } }).header;
    return header?.glibcVersionRuntime ?? null;
  } catch {
    return null;
  }
}

export const glibcSupported = (version: string | null): boolean => {
  if (version === null) return true; // not Linux/glibc (macOS, musl): the compositor step below decides
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > MIN_GLIBC[0] || (major === MIN_GLIBC[0] && minor >= MIN_GLIBC[1]);
};

/**
 * Proves, on THIS machine, that local rendering can work: glibc is new enough, the compositor binary starts, and one tiny still
 * renders to a real JPEG. Used by `scripts/setup-motion-browser.sh`; the API's `local` backend refuses to start jobs until it passed.
 */
export async function runPreflight(opts: { browserExecutable?: string; cacheDir?: string } = {}): Promise<PreflightResult> {
  const steps: string[] = [];
  const glibc = glibcVersion();
  if (!glibcSupported(glibc)) {
    steps.push(`glibc ${glibc}: FAILED`);
    return {
      ok: false,
      steps,
      glibc,
      message: `This machine has glibc ${glibc}, but the Remotion compositor needs glibc >= ${MIN_GLIBC.join(".")} (Ubuntu 22.04 or newer). Local rendering cannot work here: use VIDEO_RUNNER=github (GitHub-hosted runners) or upgrade the OS.`,
    };
  }
  steps.push(`glibc ${glibc ?? "n/a"}: ok`);

  const { enterDedicatedRenderProcess } = await import("./render/private-tmp.ts");
  enterDedicatedRenderProcess();
  const renderer = await import("@remotion/renderer");

  try {
    await renderer.RenderInternals.callFf({ bin: "ffmpeg", args: ["-version"], indent: false, logLevel: "error", binariesDirectory: null, cancelSignal: undefined });
    steps.push("compositor binary: ok");
  } catch (e) {
    steps.push("compositor binary: FAILED");
    const text = e instanceof Error ? e.message : String(e);
    return { ok: false, steps, glibc, message: `The Remotion compositor binary does not start on this machine${/GLIBC/i.test(text) ? " (it needs a newer glibc: Ubuntu 22.04+)" : ""}. Use VIDEO_RUNNER=github. Detail: ${text.replace(/\s+/g, " ").slice(0, 200)}` };
  }

  const out = mkdtempSync(path.join(os.tmpdir(), "blog-motion-preflight-"));
  try {
    const { MotionRenderer } = await import("./render/index.ts");
    const { browserStatus } = await import("./render/browser.ts");
    const b = await browserStatus(opts.browserExecutable ? { browserExecutable: opts.browserExecutable } : {});
    if (!b.installed) {
      steps.push("browser: FAILED");
      return { ok: false, steps, glibc, message: `The headless browser is not installed. ${b.hint ?? ""}`.trim() };
    }
    const r = await MotionRenderer.create({ allowBrowserDownload: false, concurrency: 1, timeoutMs: 120_000, ...(opts.browserExecutable ? { browserExecutable: opts.browserExecutable } : {}), ...(opts.cacheDir ? { cacheDir: opts.cacheDir } : {}) });
    try {
      const stills = await r.stills({ version: 1, title: "preflight", theme: "dark", scenes: [{ type: "title", title: "ok" }] }, { outDir: out, width: 160, quality: 50 });
      const file = stills[0]?.file;
      if (!file || !existsSync(file) || statSync(file).size < 200) throw new Error("the still is missing or empty");
      steps.push("tiny still: ok");
    } finally {
      await r.close();
    }
  } catch (e) {
    steps.push("tiny still: FAILED");
    return { ok: false, steps, glibc, message: `A tiny test render failed: ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 300)}` };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  return { ok: true, steps, glibc, message: null };
}

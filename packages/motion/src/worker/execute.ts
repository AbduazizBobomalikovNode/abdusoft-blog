import { mkdirSync } from "node:fs";
import path from "node:path";
import type { StoryboardIssue } from "../schema/issues.ts";
import type { WorkerErrorCode, WorkerMessage, WorkerSpec } from "./protocol.ts";

/** What a render attempt produced: a protocol `result` line or a typed error. Never throws. */
export type ExecuteOutcome = { ok: true; result: Extract<WorkerMessage, { t: "result" }> } | { ok: false; code: WorkerErrorCode; message: string; issues?: StoryboardIssue[] };

export interface ExecuteOptions {
  spec: WorkerSpec;
  /** The ALREADY validated storyboard value. */
  input: unknown;
  totalSeconds: number;
  signal: AbortSignal;
  onProgress: (m: Extract<WorkerMessage, { t: "progress" }>) => void;
  /** Returns the absolute path of a file this call wrote, so a caller can delete it; optional. */
  launchHook?: <T>(launch: () => Promise<T>) => Promise<T>;
}

const isDiskFull = (e: unknown): boolean => {
  const code = (e as { code?: unknown } | null)?.code;
  const msg = e instanceof Error ? e.message : String(e);
  return code === "ENOSPC" || /ENOSPC|no space left on device/i.test(msg);
};

/**
 * The one place that turns a `WorkerSpec` + validated storyboard into files, shared by the local worker process and the
 * GitHub runner script. The CALLER owns process-level concerns (dedicated render process, signals, exit).
 */
export async function executeSpec(opts: ExecuteOptions): Promise<ExecuteOutcome> {
  const { spec, input, signal } = opts;
  const { MotionRenderer, MotionError, BrowserMissingError, ensureBundle, browserStatus } = await import("../render/index.ts");
  let renderer: Awaited<ReturnType<typeof MotionRenderer.create>> | null = null;
  try {
    mkdirSync(spec.outDir, { recursive: true });
    // Fail fast (before the bundle) when there is no browser; the renderer never downloads one.
    const browser = await browserStatus(spec.browserExecutable ? { browserExecutable: spec.browserExecutable } : {});
    if (!browser.installed) throw new BrowserMissingError();
    // The bundle build (10-25 s cold) happens BEFORE the job clock starts: a cold first job must not eat its own timeout.
    opts.onProgress({ t: "progress", phase: "bundle", fraction: 0, message: "bundling composition" });
    await ensureBundle(spec.cacheDir, (f) => opts.onProgress({ t: "progress", phase: "bundle", fraction: f, message: "bundling composition" }));
    if (signal.aborted) return { ok: false, code: "cancelled", message: "cancelled" };
    renderer = await MotionRenderer.create({
      signal,
      cacheDir: spec.cacheDir,
      sweepOnStart: false,
      allowBrowserDownload: false,
      ...(opts.launchHook ? { launchHook: opts.launchHook } : {}),
      ...(spec.browserExecutable ? { browserExecutable: spec.browserExecutable } : {}),
      ...(spec.concurrency !== undefined ? { concurrency: spec.concurrency } : {}),
      ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
      onProgress: (p) => opts.onProgress({ t: "progress", phase: p.phase, fraction: p.fraction, message: p.message }),
    });
    if (spec.kind === "preview") {
      const stills = await renderer.stills(input, {
        outDir: spec.outDir,
        width: spec.width ?? 640,
        quality: spec.quality ?? 72,
        ...(spec.at ? { at: spec.at } : {}),
        ...(spec.scene !== undefined ? { scene: spec.scene } : {}),
      });
      const big = spec.maxOutputBytes === undefined ? undefined : stills.find((s) => s.bytes > (spec.maxOutputBytes as number));
      if (big) return { ok: false, code: "too_large", message: `a preview frame is ${big.bytes} bytes; the limit is ${spec.maxOutputBytes}` };
      return {
        ok: true,
        result: {
          t: "result",
          kind: "preview",
          stills: stills.map((s) => ({ file: s.file, seconds: s.seconds, scene: s.scene, sceneType: s.sceneType, bytes: s.bytes })),
          totalSeconds: opts.totalSeconds,
        },
      };
    }
    const file = path.join(spec.outDir, spec.outName as string);
    const r =
      spec.kind === "render"
        ? await renderer.video(input, file, spec.scene !== undefined ? { scene: spec.scene } : {})
        : await renderer.gif(input, file, {
            ...(spec.from !== undefined ? { from: spec.from } : {}),
            ...(spec.to !== undefined ? { to: spec.to } : {}),
            ...(spec.scene !== undefined ? { scene: spec.scene } : {}),
            ...(spec.loop ? { loop: true } : {}),
          });
    if (spec.maxOutputBytes !== undefined && r.bytes > spec.maxOutputBytes) {
      return { ok: false, code: "too_large", message: `the ${spec.kind === "gif" ? "GIF" : "MP4"} is ${Math.round(r.bytes / 1024 / 1024)} MB; the limit is ${Math.round(spec.maxOutputBytes / 1024 / 1024)} MB. Shorten the storyboard.` };
    }
    return { ok: true, result: { t: "result", kind: spec.kind, file: r.file, bytes: r.bytes, frames: r.frames, seconds: r.seconds, renderMs: r.renderMs } };
  } catch (e) {
    if (isDiskFull(e)) return { ok: false, code: "disk_full", message: "the disk is full while rendering" };
    if (e instanceof MotionError) {
      const code: WorkerErrorCode = e.code === "process_not_dedicated" ? "render_failed" : e.code;
      return { ok: false, code, message: e.message };
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (/^(no scene|scene \d+ does not)/.test(msg)) return { ok: false, code: "scene_not_found", message: msg };
    return { ok: false, code: "render_failed", message: msg };
  } finally {
    await renderer?.close();
  }
}

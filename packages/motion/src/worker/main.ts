#!/usr/bin/env node
/**
 * Render worker: ONE job, ONE process. Started by the API's job runner (never inside the API process), it reads a
 * `WorkerSpec`, validates the storyboard again, renders and prints JSON lines (see protocol.ts). It owns this
 * process's signals: SIGTERM/SIGINT cancel the render, clean up and exit.
 */
import { mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { INPUT_LIMITS } from "../limits.ts";
import { formatIssues } from "../schema/issues.ts";
import { validateStoryboardJson } from "../validate.ts";
import { enterDedicatedRenderProcess } from "../render/private-tmp.ts";
import type { WorkerErrorCode, WorkerMessage, WorkerSpec } from "./protocol.ts";

enterDedicatedRenderProcess();

const out = (m: WorkerMessage): void => void process.stdout.write(`${JSON.stringify(m)}\n`);
const err = (s: string): void => void process.stderr.write(`${s}\n`);

function fail(code: WorkerErrorCode, message: string, issues?: unknown[]): number {
  out({ t: "error", code, message: message.slice(0, 2000), ...(issues ? { issues } : {}) });
  return 1;
}

function readSpec(): WorkerSpec | string {
  const file = process.argv[2];
  if (!file) return "missing spec file argument";
  let raw: unknown;
  try {
    if (statSync(file).size > 64 * 1024) return "spec file too large";
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return `cannot read spec: ${(e as Error).message}`;
  }
  const s = raw as Partial<WorkerSpec>;
  if (!s || typeof s !== "object") return "spec is not an object";
  if (s.kind !== "preview" && s.kind !== "render" && s.kind !== "gif") return "spec.kind must be preview, render or gif";
  for (const k of ["storyboardFile", "outDir", "cacheDir"] as const) {
    if (typeof s[k] !== "string" || !path.isAbsolute(s[k] as string)) return `spec.${k} must be an absolute path`;
  }
  if (s.kind !== "preview" && (typeof s.outName !== "string" || s.outName !== path.basename(s.outName))) return "spec.outName must be a plain file name";
  return s as WorkerSpec;
}

async function main(): Promise<number> {
  const spec = readSpec();
  if (typeof spec === "string") return fail("invalid_spec", spec);

  // Untrusted input, third validation (API tool, API job creation, here): size first, then the schema.
  let text: string;
  try {
    const size = statSync(spec.storyboardFile).size;
    if (size > INPUT_LIMITS.maxStoryboardBytes) return fail("invalid_storyboard", `the storyboard file is ${size} bytes; the limit is ${INPUT_LIMITS.maxStoryboardBytes}`);
    text = readFileSync(spec.storyboardFile, "utf8");
  } catch (e) {
    return fail("invalid_spec", `cannot read the storyboard: ${(e as Error).message}`);
  }
  const checked = validateStoryboardJson(text);
  if (!checked.ok) return fail("invalid_storyboard", `Invalid storyboard:\n${formatIssues(checked.issues)}`, checked.issues);
  const input = JSON.parse(text) as unknown;

  const abort = new AbortController();
  let signalled = 0;
  const onSignal = (): void => {
    if (++signalled > 1) process.exit(143);
    abort.abort();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  process.on("SIGHUP", onSignal);

  // The parent (API) may be killed without being able to signal us (SIGKILL, crash, OOM): stop when it is gone.
  const parentArg = process.argv.indexOf("--parent-pid");
  const parentPid = parentArg > 0 ? Number(process.argv[parentArg + 1]) : 0;
  if (parentPid > 0) {
    setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        abort.abort();
        setTimeout(() => process.exit(143), 5000).unref();
      }
    }, 2000).unref();
  }

  const { MotionRenderer, MotionError } = await import("../render/index.ts");
  const { isolateBrowserSignals } = await import("../render/cli-signals.ts");
  let renderer: Awaited<ReturnType<typeof MotionRenderer.create>> | null = null;
  try {
    mkdirSync(spec.outDir, { recursive: true });
    renderer = await MotionRenderer.create({
      signal: abort.signal,
      cacheDir: spec.cacheDir,
      sweepOnStart: false,
      allowBrowserDownload: false,
      launchHook: isolateBrowserSignals,
      ...(spec.browserExecutable ? { browserExecutable: spec.browserExecutable } : {}),
      ...(spec.concurrency !== undefined ? { concurrency: spec.concurrency } : {}),
      ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
      onProgress: (p) => out({ t: "progress", phase: p.phase, fraction: p.fraction, message: p.message }),
    });
    if (spec.kind === "preview") {
      const stills = await renderer.stills(input, {
        outDir: spec.outDir,
        width: spec.width ?? 640,
        quality: spec.quality ?? 72,
        ...(spec.at ? { at: spec.at } : {}),
        ...(spec.scene !== undefined ? { scene: spec.scene } : {}),
      });
      out({
        t: "result",
        kind: "preview",
        stills: stills.map((s) => ({ file: s.file, seconds: s.seconds, scene: s.scene, sceneType: s.sceneType, bytes: s.bytes })),
        totalSeconds: checked.timeline.totalSeconds,
      });
    } else {
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
      out({ t: "result", kind: spec.kind, file: r.file, bytes: r.bytes, frames: r.frames, seconds: r.seconds, renderMs: r.renderMs });
    }
    return 0;
  } catch (e) {
    if (e instanceof MotionError) {
      const code: WorkerErrorCode = e.code === "process_not_dedicated" ? "render_failed" : e.code;
      return fail(code, e.message);
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (/^(no scene|scene \d+ does not)/.test(msg)) return fail("scene_not_found", msg);
    err(e instanceof Error ? (e.stack ?? msg) : msg);
    return fail("render_failed", msg);
  } finally {
    await renderer?.close();
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    process.off("SIGHUP", onSignal);
  }
}

main().then(
  (code) => {
    // Remotion can leave handles open (browser pipes); the job is over, so end the process explicitly.
    process.exit(code);
  },
  (e: unknown) => {
    err(e instanceof Error ? (e.stack ?? e.message) : String(e));
    out({ t: "error", code: "render_failed", message: "the render worker crashed" });
    process.exit(1);
  },
);

#!/usr/bin/env node
/**
 * Render worker: ONE job, ONE process. Started by the API's job runner (never inside the API process), it reads a
 * `WorkerSpec`, validates the storyboard again, renders and prints JSON lines (see protocol.ts). It owns this
 * process's signals: SIGTERM/SIGINT cancel the render, clean up and exit.
 */
import { readFileSync, statSync } from "node:fs";
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

  try {
    const { isolateBrowserSignals } = await import("../render/cli-signals.ts");
    const { executeSpec } = await import("./execute.ts");
    const outcome = await executeSpec({
      spec,
      input,
      totalSeconds: checked.timeline.totalSeconds,
      signal: abort.signal,
      onProgress: out,
      launchHook: isolateBrowserSignals,
    });
    if (outcome.ok) {
      out(outcome.result);
      return 0;
    }
    if (outcome.code === "render_failed") err(outcome.message);
    return fail(outcome.code, outcome.message);
  } finally {
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

#!/usr/bin/env node
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { GIF_LIMITS, INPUT_LIMITS, LIMITS } from "./limits.ts";
import { storyboardJsonSchema } from "./json-schema.ts";
import { formatIssues } from "./schema/issues.ts";
import { PRESETS } from "./theme/tokens.ts";
import { FPS } from "./timing.ts";
import { validateStoryboardJson } from "./validate.ts";

const HELP = `blog-motion: deterministic storyboard -> silent video (no AI, no network at render time)

Usage: blog-motion <command> [options]

Commands
  validate <storyboard.json>            check a storyboard; exit 1 with machine-readable fixes on errors
  timeline <storyboard.json>            print per-scene start/end frames and the total (no rendering)
  schema [--out file.json]              print the storyboard JSON Schema
  stills <storyboard.json> --out <dir>  small JPEG previews (960x540); one per scene, or --at 1.5,4,9 (seconds)
  render <storyboard.json> --out <f.mp4>   silent H.264 MP4, 1920x1080 @ 30 fps
  preflight [--out marker.json]         prove local rendering works on THIS machine (glibc >= 2.35, compositor starts, one tiny still); writes the marker the API's local backend requires
  browser [status|install]              status: is the headless browser installed (--json). install: download Chrome Headless Shell once (the ONLY command that downloads)
  gif <storyboard.json> --out <f.gif> [--from s --to s]
                                        GIF for short clips only (<= ${GIF_LIMITS.maxSeconds} s, ${GIF_LIMITS.maxWidth} px wide, ${GIF_LIMITS.fps} fps)

Options
  --scene <id|n>       stills/render/gif of one scene only (its id, or 1-based position); stills write start/early/middle/end frames
  --loop               gif only, with --scene <closing scene>: just the final hold, which loops seamlessly
  --preset <name>      override the storyboard's style preset (default|vivid|blueprint|neon)
  --theme light|dark   override the storyboard's theme
  --json               machine-readable output (validate, timeline, stills, render, gif)
  --cache-dir <dir>    bundle cache directory (default $BLOG_MOTION_CACHE_DIR, else ~/.cache/blog-motion)
  --browser <path>     use this Chrome/Chromium instead of Remotion's managed Chrome Headless Shell
  --download-browser   stills/render/gif: download Chrome Headless Shell when it is missing (default: fail with install instructions)
  --concurrency <n>    parallel frames (default: half the cores, at most 4; the render worker uses 1)
  --timeout <s>        whole-job time limit in seconds (default 600)
  -h, --help
Limits: <= ${LIMITS.maxTotalSeconds} s total, <= ${LIMITS.maxScenes} scenes. Exit codes: 0 ok, 1 invalid storyboard or render error, 2 usage, 130 cancelled.
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    at: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    theme: { type: "string" },
    scene: { type: "string" },
    loop: { type: "boolean", default: false },
    preset: { type: "string" },
    json: { type: "boolean", default: false },
    "cache-dir": { type: "string" },
    browser: { type: "string" },
    concurrency: { type: "string" },
    timeout: { type: "string" },
    "download-browser": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [command, file] = positionals;
const json = values.json === true;
const log = (s: string): void => void process.stderr.write(`${s}\n`);
const print = (v: unknown): void => void process.stdout.write(`${typeof v === "string" ? v : JSON.stringify(v, null, 2)}\n`);
const usage = (msg: string): never => {
  log(`error: ${msg}\n`);
  log(HELP);
  process.exit(2);
};

/** Reads the storyboard text; a file larger than the limit is refused BEFORE it is read or parsed. */
function readStoryboard(): { text: string } {
  if (!file) usage(`${command}: missing storyboard file`);
  const full = path.resolve(file as string);
  const size = statSync(full).size;
  if (size > INPUT_LIMITS.maxStoryboardBytes) throw new Error(`storyboard is ${size} bytes; the limit is ${INPUT_LIMITS.maxStoryboardBytes} bytes`);
  return { text: readFileSync(full, "utf8") };
}

function withTheme(value: unknown): unknown {
  if (values.theme === undefined && values.preset === undefined) return value;
  if (values.theme !== undefined && values.theme !== "light" && values.theme !== "dark") return usage("--theme must be light or dark");
  if (values.preset !== undefined && !(PRESETS as readonly string[]).includes(values.preset)) return usage(`--preset must be one of: ${PRESETS.join(", ")}`);
  return value && typeof value === "object"
    ? { ...(value as object), ...(values.theme !== undefined ? { theme: values.theme } : {}), ...(values.preset !== undefined ? { preset: values.preset } : {}) }
    : value;
}

async function browserCommand(): Promise<number> {
  const sub = file ?? "status";
  if (sub !== "status" && sub !== "install") return usage('browser: use "status" or "install"');
  const { browserStatus, installBrowser } = await import("./render/browser.ts");
  if (sub === "status") {
    const st = await browserStatus(values.browser ? { browserExecutable: values.browser } : {});
    if (json) print(st);
    else log(st.installed ? `browser installed: ${st.path ?? "(managed)"}` : `browser NOT installed. ${st.hint ?? ""}`);
    return st.installed ? 0 : 1;
  }
  let last = -1;
  const st = await installBrowser((p) => {
    const step = Math.floor(p * 10);
    if (!json && step !== last) {
      last = step;
      log(`downloading Chrome Headless Shell ${Math.round(p * 100)}%`);
    }
  });
  if (json) print(st);
  else log(`browser ready: ${st.path ?? "(managed)"}`);
  return 0;
}

async function main(): Promise<number> {
  if (values.help || !command) {
    process.stdout.write(HELP);
    return command || values.help ? 0 : 2;
  }
  if (command === "schema") {
    const text = JSON.stringify(storyboardJsonSchema(), null, 2);
    if (values.out) {
      mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
      writeFileSync(values.out, `${text}\n`);
    } else print(text);
    return 0;
  }
  if (command === "browser") return browserCommand();
  if (command === "preflight") {
    const { runPreflight } = await import("./preflight.ts");
    const r = await runPreflight({ ...(values.browser ? { browserExecutable: values.browser } : {}), ...(values["cache-dir"] ? { cacheDir: values["cache-dir"] } : {}) });
    for (const line of r.steps) log(line);
    if (values.out) {
      const target = path.resolve(values.out);
      mkdirSync(path.dirname(target), { recursive: true });
      if (r.ok) writeFileSync(target, `${JSON.stringify({ ok: true, at: new Date().toISOString(), glibc: r.glibc })}\n`);
      else writeFileSync(target, `${JSON.stringify({ ok: false, at: new Date().toISOString(), glibc: r.glibc })}\n`);
    }
    if (json) print({ ok: r.ok, steps: r.steps, message: r.message });
    if (!r.ok) log(`PREFLIGHT FAILED: ${r.message ?? ""}`);
    else log("preflight passed: this machine can render locally.");
    return r.ok ? 0 : 1;
  }
  if (command !== "validate" && command !== "timeline" && command !== "stills" && command !== "render" && command !== "gif") usage(`unknown command "${command}"`);

  let text: string;
  try {
    text = readStoryboard().text;
  } catch (err) {
    log(`error: cannot read storyboard: ${(err as Error).message.replace(/^Unexpected/, "invalid JSON, unexpected")}`);
    return 1;
  }
  const parsed = validateStoryboardJson(values.theme !== undefined || values.preset !== undefined ? JSON.stringify(withTheme(JSON.parse(text))) : text);
  if (!parsed.ok) {
    if (json) print({ ok: false, issues: parsed.issues });
    else log(`Storyboard is invalid (${parsed.issues.length} problem${parsed.issues.length === 1 ? "" : "s"}):\n${formatIssues(parsed.issues)}`);
    return 1;
  }
  const { timeline } = parsed;
  if (command === "validate") {
    if (json) print({ ok: true, scenes: timeline.scenes.length, totalSeconds: timeline.totalSeconds });
    else log(`ok: ${timeline.scenes.length} scenes, ${timeline.totalSeconds.toFixed(1)} s (limit ${LIMITS.maxTotalSeconds} s)`);
    return 0;
  }
  if (command === "timeline") {
    print(json ? timeline : timeline.scenes.map((s) => `${String(s.index).padStart(2)} ${s.type.padEnd(8)} ${(s.startFrame / FPS).toFixed(2).padStart(6)} s -> ${(s.endFrame / FPS).toFixed(2).padStart(6)} s  (${s.durationFrames} frames${s.explicit ? ", explicit" : ""})`).join("\n") + `\ntotal ${timeline.totalSeconds.toFixed(2)} s, ${timeline.totalFrames} frames`);
    return 0;
  }

  if (!values.out) usage(`${command}: --out is required`);
  // This process exists to render: opt in to the process-wide temp-dir handling the renderer needs.
  const { enterDedicatedRenderProcess } = await import("./render/private-tmp.ts");
  enterDedicatedRenderProcess();
  const abort = new AbortController();
  // A persistent listener (not `once`): Node restores the default action when the last listener goes away
  // mid-handler, which would kill the process before cleanup. A second signal exits at once.
  let signals = 0;
  const onSignal = (): void => {
    if (++signals > 1) process.exit(130);
    abort.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const { MotionRenderer, RenderCancelledError, RenderTimeoutError, BrowserMissingError, GifLimitError, isolateBrowserSignals } = await import("./render/index.ts");
  let lastLine = "";
  const renderer = await MotionRenderer.create({
    signal: abort.signal,
    launchHook: isolateBrowserSignals,
    allowBrowserDownload: values["download-browser"] === true,
    concurrency: values.concurrency ? Number(values.concurrency) : Math.min(4, Math.max(1, Math.floor(os.availableParallelism() / 2))),
    ...(values.timeout ? { timeoutMs: Number(values.timeout) * 1000 } : {}),
    ...(values["cache-dir"] ? { cacheDir: path.resolve(values["cache-dir"]) } : {}),
    ...(values.browser ? { browserExecutable: values.browser } : {}),
    ...(values.theme === "light" || values.theme === "dark" ? { themeOverride: values.theme } : {}),
    ...(values.preset !== undefined ? { presetOverride: values.preset as (typeof PRESETS)[number] } : {}),
    onProgress: (p) => {
      if (json) return;
      const line = `[${p.phase}] ${p.message}${p.fraction !== null ? ` ${Math.round(p.fraction * 100)}%` : ""}`;
      // one line per phase change, then one per 10 % while rendering
      const key = p.phase === "render" || p.phase === "encode" || p.phase === "stills" ? `${p.phase}:${Math.floor((p.fraction ?? 0) * 10)}` : line;
      if (key !== lastLine) {
        lastLine = key;
        process.stderr.write(`${line}\n`);
      }
    },
  });
  try {
    const input = JSON.parse(text) as unknown;
    if (command === "stills") {
      const at = values.at ? values.at.split(",").map((v) => Number(v.trim())) : undefined;
      if (at?.some((v) => !Number.isFinite(v) || v < 0)) usage("--at must be a comma-separated list of seconds, e.g. 1.5,4,9");
      const res = await renderer.stills(input, { outDir: path.resolve(values.out as string), ...(at ? { at } : {}), ...(values.scene !== undefined ? { scene: values.scene } : {}) });
      if (json) print(res);
      else for (const r of res) print(`${r.file}  scene ${r.scene + 1} (${r.sceneType}) @ ${r.seconds.toFixed(2)} s  ${(r.bytes / 1024).toFixed(0)} KiB`);
    } else if (command === "render") {
      const res = await renderer.video(input, path.resolve(values.out as string), values.scene !== undefined ? { scene: values.scene } : {});
      print(json ? res : `${res.file}  ${res.seconds.toFixed(1)} s  ${(res.bytes / 1024 / 1024).toFixed(2)} MiB  rendered in ${(res.renderMs / 1000).toFixed(1)} s`);
    } else {
      const res = await renderer.gif(input, path.resolve(values.out as string), {
        ...(values.from !== undefined ? { from: Number(values.from) } : {}),
        ...(values.to !== undefined ? { to: Number(values.to) } : {}),
        ...(values.scene !== undefined ? { scene: values.scene } : {}),
        ...(values.loop ? { loop: true } : {}),
      });
      print(json ? res : `${res.file}  ${res.seconds.toFixed(1)} s  ${(res.bytes / 1024 / 1024).toFixed(2)} MiB  rendered in ${(res.renderMs / 1000).toFixed(1)} s`);
    }
    return 0;
  } catch (err) {
    if (err instanceof RenderCancelledError) {
      log("cancelled");
      return 130;
    }
    if (err instanceof RenderTimeoutError || err instanceof BrowserMissingError) {
      log(`error: ${err.message}`);
      return 1;
    }
    if (err instanceof GifLimitError || (values.scene !== undefined && /^(no scene|scene \d+ does not)/.test((err as Error)?.message ?? ""))) {
      log(`error: ${(err as Error).message}`);
      return 1;
    }
    throw err;
  } finally {
    await renderer.close();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    log(`error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exitCode = 1;
  },
);

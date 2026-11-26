/* global process, Buffer, setTimeout, setInterval */
// A stand-in for packages/motion's render worker, used by the service tests (no browser, no Remotion).
// It speaks the same JSON-lines protocol; the storyboard's `title` selects the behaviour.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const sb = JSON.parse(readFileSync(spec.storyboardFile, "utf8"));
const mode = sb.title;
const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 1x1 JPEG
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");

if (mode === "stubborn") process.on("SIGTERM", () => undefined);

out({ t: "progress", phase: "bundle", fraction: 0.5, message: "bundling composition" });

if (mode === "fail") {
  process.stderr.write("stack /Users/secret/stack.js\n");
  out({ t: "error", code: "render_failed", message: `boom while rendering ${spec.outDir}/frame.png at /home/abdusoft/secret/path` });
  process.exit(1);
}
if (mode === "browser_missing") {
  out({ t: "error", code: "browser_missing", message: "Headless browser (Chrome Headless Shell) is not installed. Install it once with `bash scripts/setup-motion-browser.sh`" });
  process.exit(1);
}
if (mode === "crash") {
  process.stderr.write("segfault-ish\n");
  process.exit(3);
}
if (mode === "env") {
  out({ t: "error", code: "render_failed", message: `ENV ${Object.keys(process.env).sort().join(",")} NICE=${os.getPriority()} CWD=${process.cwd()}` });
  process.exit(1);
}
if (mode === "hang" || mode === "stubborn" || mode === "child" || mode === "memory") {
  if (mode === "child") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(path.join(process.cwd(), "child.pid"), String(child.pid));
  }
  if (mode === "memory") {
    // Touch every page repeatedly so the resident set really grows (macOS compresses idle pages).
    const hold = Buffer.alloc(400 * 1024 * 1024, 1);
    globalThis.hold = hold;
    setInterval(() => {
      for (let i = 0; i < hold.length; i += 4096) hold[i] = (hold[i] + 1) & 255;
    }, 200);
  }
  writeFileSync(path.join(process.cwd(), `${mode}.pid`), String(process.pid));
  setInterval(() => out({ t: "progress", phase: "render", fraction: 0.3, message: "frame 3/90" }), 500);
  await new Promise(() => undefined);
}
if (mode === "slow") {
  for (const f of [0.2, 0.5, 0.8]) {
    out({ t: "progress", phase: "render", fraction: f, message: `frame at ${f}` });
    await sleep(1300);
  }
}

mkdirSync(spec.outDir, { recursive: true });
if (spec.kind === "preview") {
  const seconds = spec.at ?? sb.scenes.map((_, i) => i * 3);
  const stills = seconds.map((s, i) => {
    const file = path.join(spec.outDir, `still-${i}.jpg`);
    writeFileSync(file, mode === "bigstill" ? Buffer.concat([JPEG, Buffer.alloc(700_000)]) : JPEG);
    return { file, seconds: s, scene: Math.min(i, sb.scenes.length - 1), sceneType: sb.scenes[Math.min(i, sb.scenes.length - 1)].type, bytes: JPEG.length };
  });
  out({ t: "result", kind: "preview", stills, totalSeconds: 10 });
} else {
  const file = mode === "escape" ? path.join(os.tmpdir(), "..", "escaped.mp4") : path.join(spec.outDir, spec.outName);
  const bytes = spec.kind === "gif" ? Buffer.from("GIF89a-fake") : mode === "big" ? Buffer.alloc(5000, 7) : Buffer.concat([Buffer.from("....ftypisom"), Buffer.alloc(1500, 1)]);
  writeFileSync(file, bytes);
  out({ t: "progress", phase: "encode", fraction: 1, message: "done" });
  out({ t: "result", kind: spec.kind, file, bytes: bytes.length, frames: 90, seconds: 3, renderMs: 1234 });
}
process.exit(0);

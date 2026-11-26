import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { INPUT_LIMITS } from "./limits.ts";
import { base, PKG } from "./test-helpers.ts";
import type { WorkerMessage, WorkerSpec } from "./worker/protocol.ts";

const dir = mkdtempSync(path.join(tmpdir(), "motion-worker-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Runs the real worker entry as a child process (no browser involved: every case here fails before rendering). */
function run(spec: Partial<WorkerSpec> | string, storyboard?: string): { code: number | null; messages: WorkerMessage[] } {
  const sbFile = path.join(dir, "sb.json");
  if (storyboard !== undefined) writeFileSync(sbFile, storyboard);
  const specFile = path.join(dir, "spec.json");
  writeFileSync(specFile, typeof spec === "string" ? spec : JSON.stringify({ kind: "preview", storyboardFile: sbFile, outDir: path.join(dir, "out"), cacheDir: path.join(dir, "cache"), ...spec }));
  const r = spawnSync(process.execPath, [path.join(PKG, "src", "worker", "main.ts"), specFile], { encoding: "utf8", cwd: PKG, timeout: 60_000 });
  const messages = r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as WorkerMessage);
  return { code: r.status, messages };
}

describe("render worker (protocol and validation, no browser)", () => {
  it("rejects a malformed spec with a typed error line and exit 1", () => {
    for (const spec of ["{", JSON.stringify({ kind: "nope" }), JSON.stringify({ kind: "preview", storyboardFile: "rel.json", outDir: "/a", cacheDir: "/b" }), JSON.stringify({ kind: "render", storyboardFile: "/a.json", outDir: "/a", cacheDir: "/b", outName: "../x.mp4" })]) {
      const r = run(spec);
      expect(r.code).toBe(1);
      expect(r.messages).toMatchObject([{ t: "error", code: "invalid_spec" }]);
    }
  });

  it("re-validates the storyboard inside the worker and returns the precise issues", () => {
    const r = run({}, JSON.stringify({ ...base([{ type: "title", title: "x".repeat(200) }]) }));
    expect(r.code).toBe(1);
    const m = r.messages[0];
    expect(m).toMatchObject({ t: "error", code: "invalid_storyboard" });
    expect((m as { issues?: Array<{ path: string }> }).issues?.[0]?.path).toBe("scenes[0].title");
  });

  it("refuses an oversized storyboard file by size before parsing it", () => {
    const r = run({}, " ".repeat(INPUT_LIMITS.maxStoryboardBytes + 1));
    expect(r.messages).toMatchObject([{ t: "error", code: "invalid_storyboard" }]);
    expect((r.messages[0] as { message: string }).message).toMatch(/limit is 262144/);
  });

  it("fails fast with browser_missing (never downloads, never bundles) when the browser does not exist", () => {
    const t0 = Date.now();
    const r = run({ browserExecutable: "/nonexistent/chrome" }, JSON.stringify(base()));
    expect(r.code).toBe(1);
    expect(r.messages.at(-1)).toMatchObject({ t: "error", code: "browser_missing" });
    expect((r.messages.at(-1) as { message: string }).message).toMatch(/setup-motion-browser\.sh/);
    expect(Date.now() - t0).toBeLessThan(30_000);
  });
});

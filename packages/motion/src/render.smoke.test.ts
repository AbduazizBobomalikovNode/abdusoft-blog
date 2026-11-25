import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MotionRenderer } from "./render/renderer.ts";
import { base } from "./test-helpers.ts";

/**
 * Opt-in: boots a headless browser and renders real pixels. Off by default so `pnpm test` and CI never
 * download a browser or render video. Run:  MOTION_RENDER_TESTS=1 pnpm --filter @blog/motion test:render
 */
const enabled = process.env.MOTION_RENDER_TESTS === "1";

const storyboard = (theme: "light" | "dark") => ({
  ...base([
    { type: "title", title: "Oʻzbekcha sinov", subtitle: "maʼlumot, gʻoya", durationSeconds: 3 },
    { type: "code", language: "typescript", code: "const a = 1;\nconst b = 2;", typing: true, steps: [{ lines: { from: 1, to: 1 }, durationSeconds: 2 }] },
  ]),
  theme,
});

/** Top-level MP4 boxes in file order. */
function boxes(file: string): string[] {
  const buf = readFileSync(file);
  const out: string[] = [];
  for (let i = 0; i + 8 <= buf.length; ) {
    const size = buf.readUInt32BE(i);
    out.push(buf.toString("latin1", i + 4, i + 8));
    if (size < 8) break;
    i += size;
  }
  return out;
}

describe.skipIf(!enabled)("render smoke (opt-in: MOTION_RENDER_TESTS=1)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "motion-smoke-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("renders stills, a faststart MP4 and a GIF, and cleans up", async () => {
    const renderer = await MotionRenderer.create();
    try {
      const stills = await renderer.stills(storyboard("dark"), { outDir: path.join(dir, "stills") });
      expect(stills).toHaveLength(2);
      for (const s of stills) {
        const head = readFileSync(s.file).subarray(0, 3);
        expect([...head]).toEqual([0xff, 0xd8, 0xff]); // JPEG
        expect(s.bytes).toBeGreaterThan(2_000);
        expect(s.bytes).toBeLessThan(200_000);
      }

      const mp4 = path.join(dir, "out.mp4");
      const v = await renderer.video(storyboard("light"), mp4);
      expect(existsSync(mp4)).toBe(true);
      expect(v.frames).toBeGreaterThan(60);
      const b = boxes(mp4);
      expect(b[0]).toBe("ftyp");
      expect(b.indexOf("moov")).toBeGreaterThan(-1);
      expect(b.indexOf("moov")).toBeLessThan(b.indexOf("mdat")); // +faststart

      const gif = path.join(dir, "out.gif");
      await renderer.gif(storyboard("dark"), gif, { from: 0, to: 2 });
      expect(readFileSync(gif).subarray(0, 6).toString("latin1")).toMatch(/^GIF8[79]a$/);
      expect(statSync(gif).size).toBeGreaterThan(1_000);
    } finally {
      await renderer.close();
    }
    // no half-written temp output left behind
    expect(existsSync(path.join(dir, "out.mp4.tmp"))).toBe(false);
  }, 240_000);

  it("cancellation stops the render and removes partial output", async () => {
    const ctl = new AbortController();
    const renderer = await MotionRenderer.create({
      signal: ctl.signal,
      onProgress: (p) => {
        if (p.phase === "render" && (p.fraction ?? 0) > 0.05) ctl.abort();
      },
    });
    const out = path.join(dir, "cancelled.mp4");
    try {
      await expect(renderer.video(storyboard("dark"), out)).rejects.toThrowError(/cancel/);
    } finally {
      await renderer.close();
    }
    expect(existsSync(out)).toBe(false);
  }, 240_000);
});

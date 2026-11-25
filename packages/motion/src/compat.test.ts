import { describe, expect, it } from "vitest";
import { createTheme } from "./theme/tokens.ts";
import { readFixture } from "./test-helpers.ts";
import { validateStoryboard } from "./validate.ts";

/**
 * Backward compatibility: the numbers below were measured on the first release of the engine
 * (commit 8c76cb8, before intros, new scene types, presets and new transitions). A version 1 storyboard
 * that validated then must validate now with an identical timeline, so its rendered frames stay put.
 * Columns: startFrame, endFrame, previewFrame, doneAt, minFrames, autoFrames.
 */
const BASELINE = {
  "blog-post.json": {
    total: 1430,
    scenes: [
      [0, 226, 86, 82, 112, 226],
      [211, 438, 387, 162, 200, 227],
      [423, 943, 693, 482, 520, 520],
      [928, 1325, 1078, 359, 397, 397],
      [1310, 1430, 1370, 46, 69, 120],
    ],
  },
  "repository.json": {
    total: 1343,
    scenes: [
      [0, 223, 83, 79, 112, 223],
      [205, 604, 538, 324, 366, 399],
      [586, 1240, 972, 612, 654, 654],
      [1222, 1343, 1283, 46, 70, 121],
    ],
  },
} as const;

describe("backward compatibility with the first release", () => {
  for (const [name, expected] of Object.entries(BASELINE)) {
    it(`${name} validates and its timeline is unchanged`, () => {
      const r = validateStoryboard(readFixture(name));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.timeline.totalFrames).toBe(expected.total);
      expect(r.timeline.scenes.map((s) => [s.startFrame, s.endFrame, s.previewFrame, s.doneAt, s.minFrames, s.autoFrames])).toEqual(expected.scenes);
      expect(r.timeline.scenes.every((s) => s.loop === null)).toBe(true);
    });
  }

  it("the default preset reproduces the first release's theme values", () => {
    const dark = createTheme("dark");
    expect(dark.accentText).toBe("color-mix(in oklab, oklch(0.488 0.243 264.376) 62%, white)");
    expect(dark.accentWash).toBe("color-mix(in srgb, oklch(0.488 0.243 264.376) 22%, transparent)");
    expect(dark.background).toBe("#0b0b0d");
    expect(dark.backdrop).toEqual({ mesh: false, grid: null, ambient: 0 });
    const light = createTheme("light", "#4f46e5");
    expect(light.accentText).toBe("#4f46e5");
    expect(light.glow).toBeNull();
    expect(light.dim).toBe(0.5);
  });

  it("version 1 scenes written without any new field keep validating", () => {
    const r = validateStoryboard({
      version: 1,
      title: "t",
      theme: "light",
      defaultTransition: "slide",
      scenes: [
        { type: "title", title: "A" },
        { type: "bullets", heading: "H", items: ["x"] },
        { type: "outro", cta: "c", url: "a.b" },
      ],
    });
    expect(r.ok).toBe(true);
  });
});

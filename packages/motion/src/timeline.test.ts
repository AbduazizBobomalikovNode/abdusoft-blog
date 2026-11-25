import { describe, expect, it } from "vitest";
import { storyboardSchema } from "./schema/storyboard.ts";
import { base, readFixture } from "./test-helpers.ts";
import { computeTimeline } from "./timeline.ts";
import { CODE_TYPE_MAX_SECONDS, FPS, hash01, TRANSITION_FRAMES, typedCount, typingSchedule } from "./timing.ts";

const parse = (scenes: unknown[], extra: Record<string, unknown> = {}) => storyboardSchema.parse({ ...base(scenes), ...extra });

describe("computeTimeline", () => {
  it("places scenes back to back with transition overlap", () => {
    const sb = parse(
      [
        { type: "title", title: "A", durationSeconds: 5 },
        { type: "title", title: "B", durationSeconds: 5 },
        { type: "title", title: "C", durationSeconds: 5, transition: "cut" },
        { type: "title", title: "D", durationSeconds: 5, transition: "slide" },
      ],
      { defaultTransition: "fade" },
    );
    const tl = computeTimeline(sb);
    const [a, b, c, d] = tl.scenes;
    expect(a?.startFrame).toBe(0);
    expect(a?.endFrame).toBe(150);
    expect(b?.startFrame).toBe(150 - TRANSITION_FRAMES.fade);
    expect(b?.enter).toEqual({ kind: "fade", frames: 15 });
    expect(c?.startFrame).toBe(b?.endFrame); // cut: no overlap
    expect(d?.startFrame).toBe((c?.endFrame ?? 0) - TRANSITION_FRAMES.slide);
    expect(tl.totalFrames).toBe(d?.endFrame);
    expect(tl.totalSeconds).toBe(tl.totalFrames / FPS);
    expect(a?.exit).toEqual({ kind: "fade", frames: 15 });
    expect(d?.exit).toEqual({ kind: "cut", frames: 0 });
  });

  it("ignores the transition of the first scene", () => {
    const tl = computeTimeline(parse([{ type: "title", title: "A", transition: "slide" }]));
    expect(tl.scenes[0]?.enter).toEqual({ kind: "cut", frames: 0 });
    expect(tl.scenes[0]?.startFrame).toBe(0);
  });

  it("derives automatic durations from content and clamps them", () => {
    const short = computeTimeline(parse([{ type: "title", title: "A" }])).scenes[0];
    const long = computeTimeline(
      parse([{ type: "title", title: "A".repeat(80), subtitle: "b".repeat(120), tags: ["a", "b", "c", "d", "e"] }]),
    ).scenes[0];
    expect(short?.explicit).toBe(false);
    expect((short?.durationFrames ?? 0) / FPS).toBeGreaterThanOrEqual(3);
    expect((long?.durationFrames ?? 0) / FPS).toBeLessThanOrEqual(8);
    expect(long?.durationFrames).toBeGreaterThan(short?.durationFrames ?? 0);
  });

  it("longer bullets and more items take longer", () => {
    const two = computeTimeline(parse([{ type: "bullets", heading: "H", items: ["aaaa", "bbbb"] }])).scenes[0];
    const six = computeTimeline(parse([{ type: "bullets", heading: "H", items: ["a", "b", "c", "d", "e", "f"].map((x) => x.repeat(40)) }])).scenes[0];
    expect(six?.durationFrames).toBeGreaterThan(two?.durationFrames ?? 0);
    const c = six?.content;
    expect(c?.type).toBe("bullets");
    if (c?.type === "bullets") {
      expect(c.itemAt).toHaveLength(6);
      for (let i = 1; i < c.itemAt.length; i++) expect(c.itemAt[i]).toBeGreaterThan(c.itemAt[i - 1] ?? 0);
    }
  });

  it("typing adds time and per-character schedule; steps follow typing", () => {
    const code = "const a = 1;\nconst b = 2;\n";
    const still = computeTimeline(parse([{ type: "code", language: "typescript", code, steps: [{ lines: { from: 1, to: 1 } }] }])).scenes[0];
    const typed = computeTimeline(parse([{ type: "code", language: "typescript", code, typing: true, steps: [{ lines: { from: 1, to: 1 } }] }])).scenes[0];
    expect(typed?.durationFrames).toBeGreaterThan(still?.durationFrames ?? 0);
    if (typed?.content.type === "code" && still?.content.type === "code") {
      expect(typed.content.typing?.schedule.length).toBe([...code].length);
      expect(still.content.typing).toBeNull();
      expect(typed.content.steps[0]?.start).toBeGreaterThan(typed.content.typing?.schedule.at(-1) ?? 0);
    }
  });

  it("long code never takes longer than the typing cap", () => {
    const code = Array.from({ length: 14 }, (_, i) => `  const value${i} = compute(input, options, context, extra${i});`).join("\n");
    const tl = computeTimeline(parse([{ type: "code", language: "typescript", code, typing: true }]));
    const c = tl.scenes[0]?.content;
    expect(c?.type).toBe("code");
    if (c?.type === "code") expect((c.typing?.schedule.at(-1) ?? 0) / FPS).toBeLessThanOrEqual(CODE_TYPE_MAX_SECONDS + 1e-6);
  });

  it("honours an explicit step duration", () => {
    const tl = computeTimeline(parse([{ type: "code", language: "text", code: "a\nb", steps: [{ lines: { from: 1, to: 2 }, durationSeconds: 4 }] }]));
    const c = tl.scenes[0]?.content;
    if (c?.type === "code") expect((c.steps[0]?.end ?? 0) - (c.steps[0]?.start ?? 0)).toBe(4 * FPS);
  });

  it("terminal entries are ordered and honour waitSeconds", () => {
    const sb = parse([
      {
        type: "terminal",
        lines: [
          { kind: "command", text: "pnpm install" },
          { kind: "output", text: "Done", waitSeconds: 2 },
          { kind: "command", text: "pnpm dev" },
        ],
      },
    ]);
    const c = computeTimeline(sb).scenes[0]?.content;
    expect(c?.type).toBe("terminal");
    if (c?.type === "terminal") {
      const starts = c.entries.map((e) => e.startAt);
      expect([...starts].sort((a, b) => a - b)).toEqual(starts);
      expect(starts[1]! - (c.entries[0]!.enterAt ?? 0)).toBeGreaterThanOrEqual(2 * FPS);
    }
  });

  it("every scene has a preview frame inside its own visible span", () => {
    for (const name of ["blog-post.json", "repository.json"]) {
      const tl = computeTimeline(storyboardSchema.parse(readFixture(name)));
      for (const s of tl.scenes) {
        expect(s.previewFrame).toBeGreaterThanOrEqual(s.startFrame + s.leadFrames);
        expect(s.previewFrame).toBeLessThan(s.endFrame - s.exit.frames);
      }
    }
  });

  it("is deterministic and JSON-stable", () => {
    const sb = storyboardSchema.parse(readFixture("blog-post.json"));
    expect(JSON.stringify(computeTimeline(sb))).toBe(JSON.stringify(computeTimeline(sb)));
  });

  it("fixtures stay within 30-60 s", () => {
    for (const name of ["blog-post.json", "repository.json"]) {
      const { totalSeconds } = computeTimeline(storyboardSchema.parse(readFixture(name)));
      expect(totalSeconds).toBeGreaterThanOrEqual(30);
      expect(totalSeconds).toBeLessThanOrEqual(60);
    }
  });
});

describe("typing schedule", () => {
  const opts = { cps: 30, newlinePause: 5, wordPause: 2, instantIndent: true, seed: 1 };
  it("is non-decreasing, deterministic and has one entry per character", () => {
    const text = "const a = 1;\n  return a;\n";
    const a = typingSchedule(text, opts);
    expect(a).toEqual(typingSchedule(text, opts));
    expect(a).toHaveLength([...text].length);
    for (let i = 1; i < a.length; i++) expect(a[i]).toBeGreaterThanOrEqual(a[i - 1] ?? 0);
  });
  it("pauses after a line break and types indentation at once", () => {
    const a = typingSchedule("ab\n  cd", { ...opts, wordPause: 0 });
    expect((a[3] ?? 0) - (a[2] ?? 0)).toBeCloseTo(opts.newlinePause, 5); // the beat after the line break
    expect(a[4]).toBe(a[3]); // indent typed at once
    expect((a[5] ?? 0) - (a[4] ?? 0)).toBeGreaterThan(0);
  });
  it("typedCount agrees with the schedule", () => {
    const a = typingSchedule("hello", opts);
    expect(typedCount(a, -1)).toBe(0);
    expect(typedCount(a, a.at(-1) ?? 0)).toBe(5);
    expect(typedCount(a, (a[1] ?? 0) + 0.001)).toBeGreaterThanOrEqual(2);
  });
  it("hash01 stays in [0,1)", () => {
    for (let i = 0; i < 1000; i++) {
      const h = hash01(i);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
  });
});

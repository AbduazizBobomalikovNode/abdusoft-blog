import { describe, expect, it } from "vitest";
import { GIF_LIMITS } from "./limits.ts";
import { checkGifRange } from "./render/gif-limits.ts";
import { storyboardSchema } from "./schema/storyboard.ts";
import { base } from "./test-helpers.ts";
import { computeTimeline } from "./timeline.ts";

const timelineOf = (seconds: number) =>
  computeTimeline(storyboardSchema.parse(base([{ type: "title", title: "A", durationSeconds: seconds }])));

describe("GIF limits", () => {
  it("accepts a short clip and reports the reduced size and frame rate", () => {
    const r = checkGifRange(timelineOf(10));
    expect(r).toMatchObject({ from: 0, to: 10, seconds: 10, width: GIF_LIMITS.maxWidth, fps: 15, startFrame: 0, endFrame: 299 });
  });

  it("refuses more than 15 s and tells the author to use MP4", () => {
    expect(() => checkGifRange(timelineOf(20))).toThrowError(
      "GIF clips are limited to 15 s but 20.0 s was requested. GIF files grow too large for longer clips: render an MP4 instead, or choose a range of at most 15 s (--from/--to).",
    );
  });

  it("lets a long storyboard export a short range", () => {
    const r = checkGifRange(timelineOf(30), { from: 5, to: 12 });
    expect(r).toMatchObject({ startFrame: 150, endFrame: 359, seconds: 7 });
  });

  it("rejects ranges outside the storyboard", () => {
    expect(() => checkGifRange(timelineOf(10), { from: 8, to: 12 })).toThrowError(/invalid for a 10\.0 s storyboard/);
    expect(() => checkGifRange(timelineOf(10), { from: 5, to: 5 })).toThrowError(/invalid/);
    expect(() => checkGifRange(timelineOf(10), { from: -1, to: 3 })).toThrowError(/invalid/);
  });

  it("MotionRenderer.gif refuses before touching the bundle or a browser", async () => {
    const { MotionRenderer } = await import("./render/renderer.ts");
    const events: string[] = [];
    const r = await MotionRenderer.create({ onProgress: (p) => events.push(p.phase) });
    try {
      await expect(r.gif(base([{ type: "title", title: "A", durationSeconds: 20 }]), "/nonexistent/x.gif")).rejects.toThrowError(/render an MP4 instead/);
      expect(events).toEqual([]);
    } finally {
      await r.close();
    }
  });
});

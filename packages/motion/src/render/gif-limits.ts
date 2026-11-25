import { GIF_LIMITS } from "../limits.ts";
import type { Timeline } from "../timeline.ts";
import { FPS } from "../timing.ts";
import { GifLimitError } from "./errors.ts";

export interface GifRange {
  from: number;
  to: number;
  startFrame: number;
  endFrame: number;
  seconds: number;
  /** Output width in px after scaling to the GIF limit. */
  width: number;
  fps: number;
}

/** Enforce the GIF limits before any browser work; the error tells the author to use MP4 instead. */
export function checkGifRange(timeline: Timeline, req: { from?: number; to?: number } = {}): GifRange {
  const from = req.from ?? 0;
  const to = req.to ?? timeline.totalSeconds;
  const seconds = to - from;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > timeline.totalSeconds + 1e-9 || seconds <= 0) {
    throw new GifLimitError(`GIF range ${from}-${to} s is invalid for a ${timeline.totalSeconds.toFixed(1)} s storyboard; use 0 <= from < to <= ${timeline.totalSeconds.toFixed(1)}.`);
  }
  if (seconds > GIF_LIMITS.maxSeconds + 1e-9) {
    throw new GifLimitError(
      `GIF clips are limited to ${GIF_LIMITS.maxSeconds} s but ${seconds.toFixed(1)} s was requested. GIF files grow too large for longer clips: render an MP4 instead, or choose a range of at most ${GIF_LIMITS.maxSeconds} s (--from/--to).`,
    );
  }
  const startFrame = Math.round(from * FPS);
  const endFrame = Math.min(timeline.totalFrames - 1, Math.round(to * FPS) - 1);
  return { from, to, startFrame, endFrame, seconds, width: Math.min(GIF_LIMITS.maxWidth, timeline.width), fps: GIF_LIMITS.fps };
}

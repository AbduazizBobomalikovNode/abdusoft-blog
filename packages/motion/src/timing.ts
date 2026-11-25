/**
 * Pace of the animation in one place: reading speed, typing speed, stagger gaps. All values are in
 * frames at 30 fps unless the name says otherwise. Pure functions only (no React, no Node), shared by
 * the timeline computation and by the scenes that animate to it.
 */
export const FPS = 30;

/** Comfortable on-screen reading speed, characters per second. */
export const READ_CPS = 18;
export const CODE_TYPE_CPS = 42;
/** Code typing never takes longer than this; speed rises for long snippets. */
export const CODE_TYPE_MAX_SECONDS = 7;
export const TERMINAL_TYPE_CPS = 22;

export const sec = (s: number): number => Math.round(s * FPS);
export const readFrames = (chars: number): number => Math.round((chars / READ_CPS) * FPS);

/** Transition overlap in frames: both scenes are on screen while it runs. */
export const TRANSITION_FRAMES = { cut: 0, fade: 15, slide: 18 } as const;

/** Deterministic pseudo-random in [0, 1) from an integer: typing jitter must be identical every render. */
export function hash01(n: number): number {
  let x = (n + 0x9e3779b9) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export interface TypingOptions {
  cps: number;
  /** Extra frames after a line break (the "think" before the next line). */
  newlinePause: number;
  /** Extra frames after a space or punctuation (word rhythm). */
  wordPause: number;
  /** Leading indentation appears at once, like an editor's auto-indent. */
  instantIndent: boolean;
  seed: number;
}

/**
 * Frame offset (from typing start, fractional) at which each character of `text` appears.
 * Natural rhythm: a base interval with ±35 % jitter, a beat after words and a longer one after lines.
 */
export function typingSchedule(text: string, opts: TypingOptions): number[] {
  const chars = [...text];
  const base = FPS / opts.cps;
  const out: number[] = [];
  let t = 0;
  let atLineStart = true;
  chars.forEach((ch, i) => {
    const jitter = 0.65 + 0.7 * hash01(opts.seed * 7919 + i);
    if (ch === "\n") {
      t += base * jitter;
      out.push(t);
      t += opts.newlinePause;
      atLineStart = true;
      return;
    }
    if (atLineStart && ch === " " && opts.instantIndent) {
      out.push(t);
      return;
    }
    atLineStart = false;
    t += base * jitter;
    out.push(t);
    if (ch === " " || ch === "," || ch === "(" || ch === ".") t += opts.wordPause * (0.5 + hash01(opts.seed * 104729 + i));
  });
  return out;
}

/** Number of characters already typed at `frame` (schedule is non-decreasing). */
export function typedCount(schedule: readonly number[], frame: number): number {
  let lo = 0;
  let hi = schedule.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((schedule[mid] as number) <= frame) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

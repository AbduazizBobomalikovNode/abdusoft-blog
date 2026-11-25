import { Easing, interpolate } from "remotion";

/** Fast ease-out (expo-like): the signature curve of entrances. */
export const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
/** Symmetric ease for movement between two resting places (highlight band, crossfades). */
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** 0 -> 1 over `dur` frames starting at `at` (content clock), eased. */
export function progress(t: number, at: number, dur = 18, easing: (n: number) => number = easeOut): number {
  return interpolate(t, [at, at + dur], [0, 1], { ...clamp, easing });
}

export const lerp = (a: number, b: number, p: number): number => a + (b - a) * p;
export const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

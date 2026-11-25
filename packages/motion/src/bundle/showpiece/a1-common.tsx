import type { CSSProperties } from "react";
import { fitTitle } from "../../fit.ts";
import { LOOP_FRAMES } from "../../timing.ts";
import type { Theme } from "../../theme/tokens.ts";
import { useStage } from "../context.tsx";

export const TAU = Math.PI * 2;

/** sin with an integer number of cycles per LOOP_FRAMES: identical at t and t + LOOP_FRAMES. */
export const periodic = (t: number, cycles: number, phase = 0): number => Math.sin((TAU * cycles * t) / LOOP_FRAMES + phase);
export const periodicCos = (t: number, cycles: number, phase = 0): number => Math.cos((TAU * cycles * t) / LOOP_FRAMES + phase);

/** Closing call-to-action size (design units) by length. */
export const ctaSize = (len: number): number => (len <= 24 ? 120 : len <= 36 ? 104 : len <= 48 ? 88 : 72);

/** Intro title size: steps down the type scale; narrower widths pass a smaller `widthUnits`. */
export const introSize = (len: number, widthUnits: number): number => fitTitle(len, widthUnits);

export const mixed = (color: string, pct: number): string => `color-mix(in srgb, ${color} ${Math.round(pct)}%, transparent)`;

/** Text halo in the background colour so lines/particles behind text never hurt legibility. */
export const halo = (theme: Theme, px: (n: number) => number): string =>
  `0 0 ${px(18)}px ${theme.background}, 0 0 ${px(6)}px ${theme.background}, 0 0 ${px(2)}px ${theme.background}`;

/** Text gradient accentText -> accent2Text (both are contrast-checked against the background). */
export const textGradient = (theme: Theme): CSSProperties => ({
  backgroundImage: `linear-gradient(100deg, ${theme.accentText} 0%, ${theme.accent2Text} 100%)`,
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
  color: "transparent",
  WebkitTextFillColor: "transparent",
});

/** The content box every showpiece lays out inside (safe area minus the header row). */
export function useBox(): { box: CSSProperties; width: number; height: number; px: (n: number) => number; sp: (n: number) => number; theme: Theme; unit: number } {
  const { layout, theme } = useStage();
  const { content, px, sp } = layout;
  return {
    box: { position: "absolute", left: content.x, top: content.y, width: content.width, height: content.height },
    width: content.width,
    height: content.height,
    px,
    sp,
    theme,
    unit: layout.unit,
  };
}

/** Word list for a title, keeping the exact words (no HTML, React children only). */
export const words = (s: string): string[] => s.split(/\s+/).filter(Boolean);

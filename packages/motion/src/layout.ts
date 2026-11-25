/**
 * Layout abstraction. Scenes never use raw pixel numbers: every size comes from a Layout built from the
 * format, scaled from the SHORT side (1080 = 1 unit), and every gap sits on an 8-unit grid. Adding
 * `vertical` or `square` later means adding it to ENABLED_FORMATS; scenes already adapt through
 * `orientation`, `content` and the scale helpers.
 */
export const FORMATS = {
  landscape: { width: 1920, height: 1080, fps: 30 },
  vertical: { width: 1080, height: 1920, fps: 30 },
  square: { width: 1080, height: 1080, fps: 30 },
} as const;

export type FormatId = keyof typeof FORMATS;

/** Formats the storyboard schema accepts today. */
export const ENABLED_FORMATS = ["landscape"] as const satisfies readonly FormatId[];

/** Reference short side every design number is authored against. */
const BASE_SHORT = 1080;

/** Safe-area insets in design units (scaled by the short side). */
const SAFE_INSETS: Record<FormatId, { x: number; top: number; bottom: number }> = {
  landscape: { x: 128, top: 88, bottom: 88 },
  vertical: { x: 80, top: 200, bottom: 240 }, // keeps clear of app UI overlays
  square: { x: 88, top: 88, bottom: 88 },
};

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Layout {
  format: FormatId;
  width: number;
  height: number;
  fps: number;
  orientation: "landscape" | "portrait" | "square";
  /** short side / 1080. */
  unit: number;
  /** Scale a design number (authored on a 1080 short side) to pixels. */
  px(n: number): number;
  /** 8-unit grid spacing: sp(3) = 24 units. */
  sp(n: number): number;
  /** Area every scene must stay inside. */
  safe: Box;
  /** Persistent brand row (wordmark, counter) inside the safe area. */
  header: Box;
  /** Where scene content lives: safe area minus the header row. */
  content: Box;
}

export function createLayout(format: FormatId): Layout {
  const f = FORMATS[format];
  const unit = Math.min(f.width, f.height) / BASE_SHORT;
  const px = (n: number) => Math.round(n * unit);
  const sp = (n: number) => 8 * n * unit;
  const inset = SAFE_INSETS[format];
  const safe: Box = {
    x: px(inset.x),
    y: px(inset.top),
    width: f.width - 2 * px(inset.x),
    height: f.height - px(inset.top) - px(inset.bottom),
  };
  const headerH = px(48);
  const header: Box = { x: safe.x, y: safe.y, width: safe.width, height: headerH };
  const gap = px(32);
  const content: Box = {
    x: safe.x,
    y: safe.y + headerH + gap,
    width: safe.width,
    height: safe.height - headerH - gap,
  };
  return {
    format,
    width: f.width,
    height: f.height,
    fps: f.fps,
    orientation: f.width === f.height ? "square" : f.width > f.height ? "landscape" : "portrait",
    unit,
    px,
    sp,
    safe,
    header,
    content,
  };
}

/**
 * Type scale in design units (a 1.25-ish modular scale snapped to even numbers). Scenes pick a
 * step, never a free number; the auto-fit helpers may step DOWN the scale, never between steps.
 */
export const TYPE_SCALE = {
  caption: 24,
  small: 28,
  body: 36,
  lead: 44,
  h2: 56,
  h1: 72,
  display: 96,
  hero: 120,
} as const;

export type TypeStep = keyof typeof TYPE_SCALE;

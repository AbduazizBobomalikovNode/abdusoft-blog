/**
 * The blog's visual identity in ONE module: colour tokens, radius scale, fonts, code themes, the
 * Open Graph wordmark and the prose type rhythm. Values are copied verbatim from the web app and
 * `theme.test.ts` re-reads the sources and fails when they drift:
 *
 *  - colours / radius ........ apps/web/src/app/globals.css (`:root` and `.dark`)
 *  - fonts ................... apps/web/src/app/layout.tsx (Geist, Geist Mono)
 *  - code themes ............. apps/api/src/lib/content/render.ts (github-light / github-dark)
 *  - OG card ................. apps/web/src/app/(site)/[slug]/opengraph-image.tsx
 *  - prose typography ........ apps/web/src/styles/prose.css
 *
 * The blog is neutral monochrome with no brand accent. Its only chromatic token is the dark-mode
 * `--sidebar-primary` (blue-violet); it becomes the default accent and is used sparingly.
 * This file has no browser or Node imports so both the bundle and Node can use it.
 */
import { ensureContrast, parseColor, rotateHue, toHex } from "./color.ts";
import { PRESET_PALETTES } from "./presets.ts";

export type ThemeMode = "light" | "dark";

/** Every colour variable of globals.css, keyed by variable name without the leading `--`. */
export const SITE_TOKENS: Record<ThemeMode, Record<string, string>> = {
  light: {
    background: "#faf9f7",
    foreground: "oklch(0.145 0 0)",
    card: "oklch(1 0 0)",
    "card-foreground": "oklch(0.145 0 0)",
    popover: "oklch(1 0 0)",
    "popover-foreground": "oklch(0.145 0 0)",
    primary: "oklch(0.205 0 0)",
    "primary-foreground": "oklch(0.985 0 0)",
    secondary: "oklch(0.97 0 0)",
    "secondary-foreground": "oklch(0.205 0 0)",
    muted: "oklch(0.97 0 0)",
    "muted-foreground": "oklch(0.556 0 0)",
    accent: "oklch(0.97 0 0)",
    "accent-foreground": "oklch(0.205 0 0)",
    destructive: "oklch(0.577 0.245 27.325)",
    border: "oklch(0.922 0 0)",
    input: "oklch(0.922 0 0)",
    ring: "oklch(0.708 0 0)",
    "chart-1": "oklch(0.205 0 0)",
    "chart-2": "oklch(0.556 0 0)",
    "chart-3": "oklch(0.439 0 0)",
    "chart-4": "oklch(0.371 0 0)",
    "chart-5": "oklch(0.269 0 0)",
    sidebar: "oklch(0.985 0 0)",
    "sidebar-foreground": "oklch(0.145 0 0)",
    "sidebar-primary": "oklch(0.205 0 0)",
    "sidebar-primary-foreground": "oklch(0.985 0 0)",
    "sidebar-accent": "oklch(0.97 0 0)",
    "sidebar-accent-foreground": "oklch(0.205 0 0)",
    "sidebar-border": "oklch(0.922 0 0)",
    "sidebar-ring": "oklch(0.708 0 0)",
  },
  dark: {
    background: "#0b0b0d",
    foreground: "oklch(0.985 0 0)",
    card: "oklch(0.205 0 0)",
    "card-foreground": "oklch(0.985 0 0)",
    popover: "oklch(0.205 0 0)",
    "popover-foreground": "oklch(0.985 0 0)",
    primary: "oklch(0.922 0 0)",
    "primary-foreground": "oklch(0.205 0 0)",
    secondary: "oklch(0.269 0 0)",
    "secondary-foreground": "oklch(0.985 0 0)",
    muted: "oklch(0.269 0 0)",
    "muted-foreground": "oklch(0.708 0 0)",
    accent: "oklch(0.269 0 0)",
    "accent-foreground": "oklch(0.985 0 0)",
    destructive: "oklch(0.704 0.191 22.216)",
    border: "oklch(1 0 0 / 10%)",
    input: "oklch(1 0 0 / 15%)",
    ring: "oklch(0.556 0 0)",
    "chart-1": "oklch(0.87 0 0)",
    "chart-2": "oklch(0.556 0 0)",
    "chart-3": "oklch(0.439 0 0)",
    "chart-4": "oklch(0.371 0 0)",
    "chart-5": "oklch(0.269 0 0)",
    sidebar: "oklch(0.205 0 0)",
    "sidebar-foreground": "oklch(0.985 0 0)",
    "sidebar-primary": "oklch(0.488 0.243 264.376)",
    "sidebar-primary-foreground": "oklch(0.985 0 0)",
    "sidebar-accent": "oklch(0.269 0 0)",
    "sidebar-accent-foreground": "oklch(0.985 0 0)",
    "sidebar-border": "oklch(1 0 0 / 10%)",
    "sidebar-ring": "oklch(0.556 0 0)",
  },
};

/** `--radius` in globals.css (rem). The scale below mirrors the `@theme inline` multipliers. */
export const RADIUS_BASE_REM = 0.625;
export const RADIUS_SCALE = { sm: 0.6, md: 0.8, lg: 1, xl: 1.4, "2xl": 1.8, "3xl": 2.2, "4xl": 2.6 } as const;
export type RadiusStep = keyof typeof RADIUS_SCALE;

/** The site's chromatic accent: dark-mode `--sidebar-primary`. */
export const DEFAULT_ACCENT = SITE_TOKENS.dark["sidebar-primary"] as string;

/** Shiki themes used by the blog's code blocks (light / dark pair). */
export const CODE_THEMES = { light: "github-light", dark: "github-dark" } as const;

/** Code surface colours of the shiki themes above (read from shiki by the tokenizer, pinned here for tests). */
export const CODE_SURFACE: Record<ThemeMode, { bg: string; fg: string }> = {
  light: { bg: "#fff", fg: "#24292e" },
  dark: { bg: "#24292e", fg: "#e1e4e8" },
};

/** Fonts the site loads through next/font/google. */
export const SITE_FONTS = { sans: "Geist", mono: "Geist Mono" } as const;

/** Families as registered inside the render (see fonts.ts); Geist plus a fallback face for U+02BB. */
export const FONT_FAMILY = { sans: "Blog Geist", mono: "Blog Geist Mono" } as const;
export const FONT_STACK = {
  sans: `"${FONT_FAMILY.sans}", system-ui, sans-serif`,
  mono: `"${FONT_FAMILY.mono}", ui-monospace, monospace`,
} as const;

/** Open Graph card: dark surface, uppercase tracked wordmark at 70% opacity, pill tags with a 30% outline. */
export const OG_CARD = {
  background: "#0b0b0d",
  foreground: "#fafafa",
  wordmarkLetterSpacingEm: 2 / 28,
  wordmarkOpacity: 0.7,
  tagBorder: "rgba(250,250,250,0.3)",
  tagOpacity: 0.85,
  titleWeight: 600,
  titleLineHeight: 1.2,
} as const;

/** prose.css rhythm: article body 1.125rem / 1.65, h2 600 with -0.01em tracking, inline code .875em, code line-height 1.6. */
export const PROSE = {
  bodyRem: 1.125,
  bodyLineHeight: 1.65,
  headingWeight: 600,
  headingTracking: "-0.01em",
  codeEm: 0.875,
  codeLineHeight: 1.6,
} as const;

/** Resolved colours a scene paints with. CSS colour strings (oklch is understood by the render browser). */
export interface Theme {
  mode: ThemeMode;
  background: string;
  foreground: string;
  card: string;
  muted: string;
  mutedForeground: string;
  border: string;
  primary: string;
  primaryForeground: string;
  /** Accent as a fill (bars, markers, caret). */
  accent: string;
  /** Accent lightened for text/strokes on the dark surface so it stays legible. */
  accentText: string;
  /** Text colour on top of an accent fill. */
  onAccent: string;
  /** Translucent accent wash (line highlight). */
  accentWash: string;
  code: { bg: string; fg: string; header: string; headerFg: string; gutter: string };
  /** Terminal tones, taken from the GitHub shiki palettes so they match the code blocks. */
  tone: { success: string; error: string };
  /** Style preset the theme was built for. */
  preset: PresetId;
  /** Second hue for gradients (derived from the accent unless the preset fixes it). */
  accent2: string;
  /** accent2 lightened/darkened to stay legible as text on the background. */
  accent2Text: string;
  /** Accent-to-accent2 gradient as a CSS value (fills, bars, big display type). */
  gradient: string;
  /** Neon glow colour for text-shadow / box-shadow, or null when the preset has none. */
  glow: string | null;
  /** Ambient backdrop description; drawn by the Explainer (nothing for the default preset). */
  backdrop: { mesh: boolean; grid: { color: string; major: string } | null; ambient: number };
  /** Opacity of the lines a code scene dims (all code surfaces are the blog's shiki themes). */
  dim: number;
}

export const HEX_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
export const isHexColor = (v: string): boolean => HEX_PATTERN.test(v);

export function createTheme(mode: ThemeMode, accentOverride?: string, preset: PresetId = "default"): Theme {
  const t = SITE_TOKENS[mode] as Record<string, string>;
  const get = (k: string): string => {
    const v = t[k];
    if (v === undefined) throw new Error(`theme token --${k} missing for ${mode}`);
    return v;
  };
  const pal = PRESET_PALETTES[preset]?.[mode] ?? null;
  const accent = accentOverride ?? pal?.accent ?? DEFAULT_ACCENT;
  const dark = mode === "dark";
  const surface = CODE_SURFACE[mode];
  const background = pal?.background ?? get("background");
  const accentHex = toHex(parseColor(accent).rgb);
  const accent2 = pal?.accent2 && !accentOverride ? pal.accent2 : rotateHue(accentHex, 55);
  const towards = dark ? "white" : "black";
  // The default preset keeps the original expressions (pixel-identical to the first release).
  const accentText = pal === null ? (dark ? `color-mix(in oklab, ${accent} 62%, white)` : `${accent}`) : ensureContrast(accentHex, [background, pal.card], 4.6, towards);
  const accent2Text = ensureContrast(toHex(parseColor(accent2).rgb), pal ? [background, pal.card] : background, 4.6, towards);
  const mutedForeground = pal?.mutedForeground ?? get("muted-foreground");
  return {
    mode,
    background,
    foreground: pal?.foreground ?? get("foreground"),
    card: pal?.card ?? get("card"),
    muted: pal?.muted ?? get("muted"),
    mutedForeground,
    border: pal?.border ?? get("border"),
    primary: get("primary"),
    primaryForeground: get("primary-foreground"),
    accent,
    accentText,
    onAccent: "#ffffff",
    accentWash: `color-mix(in srgb, ${accent} ${dark ? 22 : 14}%, transparent)`,
    code: {
      bg: surface.bg,
      fg: surface.fg,
      header: pal?.muted ?? get("muted"),
      headerFg: pal?.mutedForeground ?? get("muted-foreground"),
      gutter: dark ? "rgba(225,228,232,0.35)" : "rgba(36,41,46,0.35)",
    },
    tone: dark ? { success: "#85e89d", error: "#f97583" } : { success: "#22863a", error: "#cb2431" },
    preset,
    accent2,
    accent2Text,
    gradient: `linear-gradient(100deg, ${accent} 0%, ${accent2} 100%)`,
    glow: pal?.glow ? `color-mix(in srgb, ${accent} 70%, transparent)` : null,
    backdrop: { mesh: pal?.mesh ?? false, grid: pal?.grid ?? null, ambient: pal?.ambient ?? 0 },
    dim: dark ? DIM_DARK : DIM_LIGHT,
  };
}

/** Opacity of the lines a code scene dims (kept from the first release). */
export const DIM_DARK = 0.34;
export const DIM_LIGHT = 0.5;

/** Radius in px for a step, given the rem size of the layout (1rem = 16 css px * `remPx / 16`). */
export function radius(step: RadiusStep, remPx: number): number {
  return Math.round(RADIUS_BASE_REM * RADIUS_SCALE[step] * remPx);
}

/** Style presets (theme layer); "default" is the blog's own minimal look. Defined in theme/presets.ts. */
export const PRESETS = ["default", "vivid", "blueprint", "neon"] as const;
export type PresetId = (typeof PRESETS)[number];

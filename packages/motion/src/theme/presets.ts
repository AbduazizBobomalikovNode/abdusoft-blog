import type { PresetId, ThemeMode } from "./tokens.ts";

/**
 * Style presets: alternative palettes and backdrops for the whole storyboard, applied in the theme
 * layer so every scene (old and new) follows them. Fonts, the radius scale and the code highlighting
 * (shiki github-light / github-dark) are NOT touched: a preset only changes surfaces, ink, accent
 * defaults and the ambient backdrop. `default` has no palette: it is the blog's own tokens.
 *
 * Contrast is enforced in theme.test.ts: body text >= 7:1, muted text >= 4.5:1, accent text >= 4.5:1 on
 * every preset and mode, and dimmed code lines never lower than the default look.
 */
export interface Palette {
  background: string;
  foreground: string;
  card: string;
  muted: string;
  mutedForeground: string;
  border: string;
  /** Accent when the storyboard does not set one. */
  accent: string;
  /** Second hue for gradients; derived from the accent when null. */
  accent2: string | null;
  /** Neon glow around accent elements. */
  glow: boolean;
  /** Ambient backdrop: gradient mesh (vivid), engineering grid (blueprint). */
  mesh: boolean;
  grid: { color: string; major: string } | null;
  /** Amplitude 0..1 of the slow ambient drift of the backdrop (0 = static). */
  ambient: number;
}

export const PRESET_PALETTES: Record<PresetId, Record<ThemeMode, Palette> | null> = {
  default: null,
  vivid: {
    dark: {
      background: "#09081a",
      foreground: "#f8f7ff",
      card: "#17143a",
      muted: "#201c4a",
      mutedForeground: "#c2bee8",
      border: "rgba(190, 175, 255, 0.22)",
      accent: "#7a5cff",
      accent2: "#ff5fa8",
      glow: false,
      mesh: true,
      grid: null,
      ambient: 1,
    },
    light: {
      background: "#fbf9ff",
      foreground: "#17132b",
      card: "#ffffff",
      muted: "#f0ebff",
      mutedForeground: "#524d72",
      border: "rgba(70, 40, 160, 0.16)",
      accent: "#5b3df5",
      accent2: "#e0398c",
      glow: false,
      mesh: true,
      grid: null,
      ambient: 1,
    },
  },
  blueprint: {
    dark: {
      background: "#071a2e",
      foreground: "#eaf4ff",
      card: "#0b2540",
      muted: "#0f3052",
      mutedForeground: "#a5c7e6",
      border: "rgba(130, 195, 255, 0.34)",
      accent: "#4cc9f0",
      accent2: "#ffd166",
      glow: false,
      mesh: false,
      grid: { color: "rgba(120, 190, 255, 0.10)", major: "rgba(120, 190, 255, 0.22)" },
      ambient: 0.5,
    },
    light: {
      background: "#f2f7fc",
      foreground: "#0b2a4a",
      card: "#ffffff",
      muted: "#e3edf8",
      mutedForeground: "#3b5f82",
      border: "rgba(20, 90, 160, 0.30)",
      accent: "#1565c0",
      accent2: "#d9480f",
      glow: false,
      mesh: false,
      grid: { color: "rgba(20, 90, 160, 0.08)", major: "rgba(20, 90, 160, 0.18)" },
      ambient: 0.5,
    },
  },
  neon: {
    dark: {
      background: "#04040a",
      foreground: "#ffffff",
      card: "#0d0d1c",
      muted: "#15152c",
      mutedForeground: "#bfc1dc",
      border: "rgba(255, 255, 255, 0.26)",
      accent: "#16e0ff",
      accent2: "#ff2bd6",
      glow: true,
      mesh: false,
      grid: { color: "rgba(22, 224, 255, 0.07)", major: "rgba(255, 43, 214, 0.14)" },
      ambient: 0.8,
    },
    light: {
      background: "#ffffff",
      foreground: "#07070d",
      card: "#ffffff",
      muted: "#f1f1f7",
      mutedForeground: "#383848",
      border: "rgba(7, 7, 13, 0.55)",
      accent: "#6a00f4",
      accent2: "#d6006f",
      glow: false,
      mesh: false,
      grid: null,
      ambient: 0.4,
    },
  },
};

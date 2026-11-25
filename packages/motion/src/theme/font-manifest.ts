/**
 * Font files bundled with the package (no network at render time). Geist and Geist Mono come from the
 * fontsource variable builds (SIL OFL 1.1); the Geist glyph set has NO U+02BB (okina, `ʻ`), which Uzbek
 * needs in `oʻzbek` / `gʻoya`, so a one-glyph Noto Sans subset is registered under the SAME family and
 * the browser takes only that code point from it (unicode-range). The look of every other glyph is Geist.
 *
 * Plain data: Node tests read it to verify glyph coverage; fonts.ts (bundle only) imports the files.
 */
export interface FontFaceSpec {
  family: "sans" | "mono";
  /** File name inside assets/fonts. */
  file: string;
  unicodeRange: string;
  /** CSS font-weight range of the variable axis. */
  weight: string;
  label: string;
}

const LATIN =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT =
  "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";

/**
 * The latin range is fontsource's minus U+02BB, so exactly one face claims U+02BB: the fallback (Geist
 * itself has no such glyph).
 */
export const FONT_FACES: readonly FontFaceSpec[] = [
  { family: "sans", file: "geist-latin-wght-normal.woff2", unicodeRange: LATIN, weight: "100 900", label: "Geist latin" },
  { family: "sans", file: "geist-latin-ext-wght-normal.woff2", unicodeRange: LATIN_EXT, weight: "100 900", label: "Geist latin-ext" },
  { family: "sans", file: "noto-sans-uz-fallback-wght-normal.woff2", unicodeRange: "U+02BB", weight: "100 900", label: "Noto Sans U+02BB fallback" },
  { family: "mono", file: "geist-mono-latin-wght-normal.woff2", unicodeRange: LATIN, weight: "100 900", label: "Geist Mono latin" },
  { family: "mono", file: "geist-mono-latin-ext-wght-normal.woff2", unicodeRange: LATIN_EXT, weight: "100 900", label: "Geist Mono latin-ext" },
  { family: "mono", file: "noto-sans-uz-fallback-wght-normal.woff2", unicodeRange: "U+02BB", weight: "100 900", label: "Noto Sans U+02BB fallback" },
];

/** Expand a CSS unicode-range string to inclusive [from, to] pairs. */
export function parseUnicodeRange(range: string): Array<[number, number]> {
  return range.split(",").map((part) => {
    const m = /^U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?$/.exec(part.trim());
    if (!m) throw new Error(`bad unicode-range part: ${part}`);
    const from = parseInt(m[1] as string, 16);
    return [from, m[2] ? parseInt(m[2], 16) : from];
  });
}

export const inRange = (cp: number, ranges: Array<[number, number]>): boolean => ranges.some(([a, b]) => cp >= a && cp <= b);

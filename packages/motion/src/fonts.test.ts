import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { FONT_FACES, inRange, parseUnicodeRange } from "./theme/font-manifest.ts";
import { PKG } from "./test-helpers.ts";

const require = createRequire(import.meta.url);
const fontkit = require("fontkit") as typeof import("fontkit");
const FONT_DIR = path.join(PKG, "assets", "fonts");

/** Code points Uzbek (Latin) and the engine's own UI need. */
const UZBEK = "ʻʼ’‘'“”«»–—…·gʻoyaGʻOʻ"; // U+02BB, U+02BC, typographic quotes, dashes
const WORDS = ["oʻzbek", "gʻoya", "maʼlumot", "toʻgʻri", "Oʻzbekiston", "sogʻlom", "kitob’i", "‘ha’", "do’st"];
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:;!?()[]{}<>/\\-_=+*&%$#@\"'`~|^";
const SIGNS = "·–—…’‘“”";

const cps = (s: string): number[] => [...s].map((c) => c.codePointAt(0) as number);

/** Which face the browser takes a code point from: the unique face claiming it in this family. */
function face(family: "sans" | "mono", cp: number) {
  const claimants = FONT_FACES.filter((f) => f.family === family && inRange(cp, parseUnicodeRange(f.unicodeRange)));
  return claimants;
}

describe("bundled fonts", () => {
  it("every manifest file exists, and no font file is unreferenced", () => {
    for (const f of FONT_FACES) expect(existsSync(path.join(FONT_DIR, f.file)), f.file).toBe(true);
    const files = readdirSync(FONT_DIR).filter((n) => n.endsWith(".woff2"));
    expect(new Set(files)).toEqual(new Set(FONT_FACES.map((f) => f.file)));
  });

  it("fonts.ts imports every manifest file (the bundle can load them)", () => {
    const src = readFileSync(path.join(PKG, "src", "bundle", "fonts.ts"), "utf8");
    for (const f of FONT_FACES) expect(src, f.file).toContain(f.file);
    expect(src).toContain("delayRender");
    expect(src).toContain("continueRender");
  });

  it("licences ship next to the fonts", () => {
    for (const n of ["LICENSE-Geist.txt", "LICENSE-GeistMono.txt", "LICENSE-NotoSans.txt"]) {
      expect(readFileSync(path.join(FONT_DIR, n), "utf8")).toContain("SIL Open Font License");
    }
  });
});

describe("glyph coverage (real font files)", () => {
  const open = (file: string) => fontkit.openSync(path.join(FONT_DIR, file)) as import("fontkit").Font;

  it("Geist itself lacks U+02BB, so the fallback face is required (documents WHY it exists)", () => {
    for (const file of ["geist-latin-wght-normal.woff2", "geist-latin-ext-wght-normal.woff2", "geist-mono-latin-wght-normal.woff2", "geist-mono-latin-ext-wght-normal.woff2"]) {
      expect(open(file).hasGlyphForCodePoint(0x2bb), file).toBe(false);
    }
  });

  it.each(["sans", "mono"] as const)("every Uzbek and UI character is drawn by exactly one %s face that has the glyph", (family) => {
    const wanted = [...new Set([...cps(UZBEK), ...cps(WORDS.join("")), ...cps(ALPHABET), ...cps(SIGNS)])];
    const missing: string[] = [];
    for (const cp of wanted) {
      const claimants = face(family, cp);
      const ok = claimants.length === 1 && open((claimants[0] as { file: string }).file).hasGlyphForCodePoint(cp);
      if (!ok) missing.push(`U+${cp.toString(16).toUpperCase().padStart(4, "0")} ${String.fromCodePoint(cp)} (${claimants.length} claimants)`);
    }
    expect(missing).toEqual([]);
  });

  it("U+02BB comes from the Noto fallback and U+02BC from Geist", () => {
    expect(face("sans", 0x2bb).map((f) => f.file)).toEqual(["noto-sans-uz-fallback-wght-normal.woff2"]);
    expect(face("mono", 0x2bb).map((f) => f.file)).toEqual(["noto-sans-uz-fallback-wght-normal.woff2"]);
    expect(face("sans", 0x2bc).map((f) => f.file)).toEqual(["geist-latin-wght-normal.woff2"]);
  });

  it("the fallback face is a variable font with a weight axis, so semibold titles match", () => {
    const f = open("noto-sans-uz-fallback-wght-normal.woff2");
    expect(Object.keys(f.variationAxes ?? {})).toContain("wght");
    expect(f.hasGlyphForCodePoint(0x2bb)).toBe(true);
  });
});

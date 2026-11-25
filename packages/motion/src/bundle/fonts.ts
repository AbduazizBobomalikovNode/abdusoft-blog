// Bundle-only module (imports .woff2 files). Registers Geist, Geist Mono and the one-glyph Noto Sans
// fallback for U+02BB, then holds the render with delayRender until EVERY face is loaded, so no frame is
// ever drawn with a fallback font. Face list and unicode ranges live in theme/font-manifest.ts, which
// Node tests use to verify glyph coverage; font-manifest.test.ts checks this file imports each of them.
import geistLatin from "../../assets/fonts/geist-latin-wght-normal.woff2";
import geistLatinExt from "../../assets/fonts/geist-latin-ext-wght-normal.woff2";
import geistMonoLatin from "../../assets/fonts/geist-mono-latin-wght-normal.woff2";
import geistMonoLatinExt from "../../assets/fonts/geist-mono-latin-ext-wght-normal.woff2";
import notoFallback from "../../assets/fonts/noto-sans-uz-fallback-wght-normal.woff2";
import { cancelRender, continueRender, delayRender } from "remotion";
import { FONT_FACES } from "../theme/font-manifest.ts";
import { FONT_FAMILY } from "../theme/tokens.ts";

const URLS: Record<string, string> = {
  "geist-latin-wght-normal.woff2": geistLatin,
  "geist-latin-ext-wght-normal.woff2": geistLatinExt,
  "geist-mono-latin-wght-normal.woff2": geistMonoLatin,
  "geist-mono-latin-ext-wght-normal.woff2": geistMonoLatinExt,
  "noto-sans-uz-fallback-wght-normal.woff2": notoFallback,
};

const handle = delayRender("fonts: Geist, Geist Mono, U+02BB fallback");

Promise.all(
  FONT_FACES.map((face) => {
    const url = URLS[face.file];
    if (!url) throw new Error(`font file not imported in fonts.ts: ${face.file}`);
    return new FontFace(FONT_FAMILY[face.family], `url(${url}) format('woff2')`, {
      weight: face.weight,
      unicodeRange: face.unicodeRange,
    })
      .load()
      .then((loaded) => {
        document.fonts.add(loaded);
      });
  }),
)
  .then(() => document.fonts.ready)
  .then(() => continueRender(handle))
  .catch((err: unknown) => cancelRender(err instanceof Error ? err : new Error(String(err))));

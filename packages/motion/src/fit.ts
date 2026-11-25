/**
 * Pure auto-fit helpers. Text is measured by average advance (em) instead of a browser, so the same
 * numbers decide the font size in Node tests and in the render. Sizes only ever step down a fixed list
 * (the type scale), never between steps.
 */
export const MONO_ADVANCE = 0.6; // Geist Mono: 600/1000 em
export const SANS_ADVANCE = 0.56; // Geist average incl. spaces; deliberately a bit pessimistic

export const CODE_SIZES = [44, 40, 36, 32, 28, 26, 24, 22] as const;
export const CODE_LINE_HEIGHT = 1.6; // prose.css: pre line-height 1.6

/** Largest code size where `maxChars` columns fit `width` and `lineCount` rows fit `height`. */
export function fitMono(o: { lineCount: number; maxChars: number; width: number; height: number; sizes?: readonly number[] }): number {
  const sizes = o.sizes ?? CODE_SIZES;
  for (const s of sizes) {
    if (o.maxChars * s * MONO_ADVANCE <= o.width && o.lineCount * s * CODE_LINE_HEIGHT <= o.height) return s;
  }
  return sizes[sizes.length - 1] as number;
}

/** Like fitMono, but reserves the line-number gutter (`digits` columns plus a 24-unit gap) that grows with the size. */
export function fitCode(o: { lineCount: number; maxChars: number; digits: number; width: number; height: number }): number {
  for (const s of CODE_SIZES) {
    const gutter = o.digits * s * MONO_ADVANCE + 24;
    if (o.maxChars * s * MONO_ADVANCE <= o.width - gutter && o.lineCount * s * CODE_LINE_HEIGHT <= o.height) return s;
  }
  return CODE_SIZES[CODE_SIZES.length - 1] as number;
}

export function estimateLines(chars: number, size: number, width: number, advance = SANS_ADVANCE): number {
  const perLine = Math.max(1, Math.floor(width / (size * advance)));
  return Math.max(1, Math.ceil(chars / perLine));
}

/** Largest size from `sizes` (descending) where the stacked rows fit `height`. */
export function fitRows(o: {
  texts: readonly string[];
  width: number;
  height: number;
  sizes: readonly number[];
  lineHeight: number;
  rowPadding: (size: number) => number;
}): number {
  for (const s of o.sizes) {
    const total = o.texts.reduce((acc, t) => acc + estimateLines(t.length, s, o.width) * s * o.lineHeight + o.rowPadding(s), 0);
    if (total <= o.height) return s;
  }
  return o.sizes[o.sizes.length - 1] as number;
}

/** Title size by length (design units): short titles are big, long ones step down. */
export function fitTitle(chars: number, widthUnits: number): number {
  const sizes = [120, 96, 72, 64];
  for (const s of sizes) {
    if (estimateLines(chars, s, widthUnits, 0.52) <= (s >= 120 ? 2 : 3)) return s;
  }
  return 64;
}

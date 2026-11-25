/**
 * Small, pure colour toolkit (no dependencies): parses the colour spellings the theme uses (#hex,
 * rgb()/rgba(), oklch(), color-mix(in oklab|srgb, ...)) into sRGB so that the theme can derive
 * accent variants and tests can check WCAG contrast. Gamut handling is a plain clamp.
 */
export type RGB = [number, number, number]; // 0..255
export interface RGBA {
  rgb: RGB;
  a: number;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

const toLinear = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (l: number): number => {
  const v = l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055;
  return clamp(v, 0, 1) * 255;
};

export function parseHex(hex: string): RGB {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`not a hex colour: ${hex}`);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function toHex(rgb: RGB): string {
  return `#${rgb.map((c) => Math.round(clamp(c, 0, 255)).toString(16).padStart(2, "0")).join("")}`;
}

type Lab = [number, number, number];

export function rgbToOklab(rgb: RGB): Lab {
  const [r, g, b] = rgb.map(toLinear) as RGB;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

export function oklabToRgb(lab: Lab): RGB {
  const [L, a, b] = lab;
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

export function oklchToRgb(L: number, C: number, hDeg: number): RGB {
  const h = (hDeg * Math.PI) / 180;
  return oklabToRgb([L, C * Math.cos(h), C * Math.sin(h)]);
}

/** Split a CSS argument list on top-level commas. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Parse a colour string into sRGB plus alpha. Throws on a spelling it does not know. */
export function parseColor(input: string): RGBA {
  const v = input.trim();
  if (v.startsWith("#")) return { rgb: parseHex(v), a: 1 };
  if (v === "white") return { rgb: [255, 255, 255], a: 1 };
  if (v === "black") return { rgb: [0, 0, 0], a: 1 };
  if (v === "transparent") return { rgb: [0, 0, 0], a: 0 };
  let m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a };
  }
  m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { rgb: oklchToRgb(Number(m[1]), Number(m[2]), Number(m[3])), a };
  }
  m = /^color-mix\(\s*in\s+(oklab|srgb)\s*,(.*)\)$/.exec(v);
  if (m) {
    const parts = splitArgs(m[2] as string).map((p) => {
      const pm = /^(.*?)(?:\s+([\d.]+)%)?$/.exec(p) as RegExpExecArray;
      return { color: parseColor(pm[1] as string), pct: pm[2] === undefined ? undefined : parseFloat(pm[2]) };
    });
    if (parts.length !== 2) throw new Error(`color-mix needs two colours: ${v}`);
    const [x, y] = parts as [(typeof parts)[number], (typeof parts)[number]];
    const px = x.pct ?? (y.pct === undefined ? 50 : 100 - y.pct);
    const t = 1 - px / 100; // weight of y
    return mix(x.color, y.color, t, m[1] as "oklab" | "srgb");
  }
  throw new Error(`unsupported colour: ${input}`);
}

/** Mix a and b; t is the weight of b. Alpha is mixed linearly. */
export function mix(a: RGBA, b: RGBA, t: number, space: "oklab" | "srgb" = "oklab"): RGBA {
  const alpha = a.a * (1 - t) + b.a * t;
  if (space === "srgb") return { rgb: [0, 1, 2].map((i) => (a.rgb[i] as number) * (1 - t) + (b.rgb[i] as number) * t) as RGB, a: alpha };
  const la = rgbToOklab(a.rgb);
  const lb = rgbToOklab(b.rgb);
  return { rgb: oklabToRgb([0, 1, 2].map((i) => (la[i] as number) * (1 - t) + (lb[i] as number) * t) as Lab), a: alpha };
}

/** Composite `fg` (with its alpha) over an opaque backdrop. */
export function over(fg: RGBA, bg: RGB): RGB {
  return [0, 1, 2].map((i) => (fg.rgb[i] as number) * fg.a + bg[i]! * (1 - fg.a)) as RGB;
}

/** WCAG relative luminance. */
export function luminance(rgb: RGB): number {
  const [r, g, b] = rgb.map(toLinear) as RGB;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRgb(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** WCAG contrast of `fg` over `bg` (a translucent fg is composited over bg first). */
export function contrast(fg: string, bg: string): number {
  const b = parseColor(bg);
  const backdrop = b.a < 1 ? over(b, [255, 255, 255]) : b.rgb;
  return contrastRgb(over(parseColor(fg), backdrop), backdrop);
}

/** Rotate the OKLCH hue of a colour (hex in, hex out). */
export function rotateHue(color: string, deg: number): string {
  const [L, a, b] = rgbToOklab(parseColor(color).rgb);
  const C = Math.hypot(a, b);
  const h = Math.atan2(b, a) + (deg * Math.PI) / 180;
  return toHex(oklabToRgb([L, C * Math.cos(h), C * Math.sin(h)]));
}

/**
 * Move `color` toward white (dark surface) or black (light surface) in OKLab until its contrast against
 * every surface in `bg` reaches `min`. Returns hex; the colour is untouched if it already passes.
 */
export function ensureContrast(color: string, bg: string | readonly string[], min: number, towards: "white" | "black"): string {
  const bgs = typeof bg === "string" ? [bg] : bg;
  const target: RGBA = { rgb: towards === "white" ? [255, 255, 255] : [0, 0, 0], a: 1 };
  const base = parseColor(color);
  for (let step = 0; step <= 20; step++) {
    const c = toHex(mix(base, target, step / 20).rgb);
    if (bgs.every((b) => contrast(c, b) >= min)) return c;
  }
  return towards === "white" ? "#ffffff" : "#000000";
}

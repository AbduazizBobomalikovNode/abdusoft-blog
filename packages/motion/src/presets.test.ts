import { describe, expect, it } from "vitest";
import { contrast, contrastRgb, ensureContrast, over, parseColor, rotateHue, toHex } from "./theme/color.ts";
import { PRESET_PALETTES } from "./theme/presets.ts";
import { CODE_SURFACE, createTheme, DEFAULT_ACCENT, PRESETS, type PresetId, type Theme, type ThemeMode } from "./theme/tokens.ts";

const MODES: ThemeMode[] = ["light", "dark"];
const ACCENTS: Array<string | undefined> = [undefined, "#ff0066", "#4f46e5", "#ffd400", "#0a0a0a", "#ffffff"];

/** Every colour string a scene may paint text with, and the surface it sits on. */
function textPairs(t: Theme): Array<[string, string, string, number]> {
  // The default preset IS the blog's own tokens (the site's light muted text is 4.50:1 on its background and 4.34:1 on the code header),
  // kept verbatim for backward compatibility; every other preset must reach 4.5:1.
  const muted = t.preset === "default" ? 4.3 : 4.5;
  const pairs: Array<[string, string, string, number]> = [
    ["foreground on background", t.foreground, t.background, 7],
    ["foreground on card", t.foreground, t.card, 7],
    ["mutedForeground on background", t.mutedForeground, t.background, muted],
    ["mutedForeground on card", t.mutedForeground, t.card, muted],
    ["code header text on header", t.code.headerFg, t.code.header, muted],
    ["code text on code surface", t.code.fg, t.code.bg, 7],
  ];
  // The default preset keeps the first release's accent text spelling for ANY accent (an unreadable accent such as
  // near-black on dark is the author's choice there); the new presets derive accent text that always passes.
  if (t.preset !== "default" || accentIsSane(t)) {
    pairs.push(
      ["accentText on background", t.accentText, t.background, 4.5],
      ["accentText on card", t.accentText, t.card, 4.5],
      ["accent2Text on background", t.accent2Text, t.background, 4.5],
    );
  }
  return pairs;
}
const accentIsSane = (t: Theme): boolean => t.accent === "#4f46e5" || t.accent === DEFAULT_ACCENT;

describe("colour toolkit", () => {
  it("parses hex, rgb, oklch and color-mix", () => {
    expect(parseColor("#fff").rgb).toEqual([255, 255, 255]);
    expect(parseColor("rgba(0, 0, 0, 0.5)").a).toBe(0.5);
    expect(toHex(parseColor("oklch(0.985 0 0)").rgb)).toBe("#fafafa");
    const mixed = parseColor("color-mix(in srgb, #000000 50%, #ffffff)");
    expect(mixed.rgb.map(Math.round)).toEqual([128, 128, 128]);
    expect(() => parseColor("hsl(1 2% 3%)")).toThrow(/unsupported colour/);
  });

  it("computes WCAG contrast (black on white is 21:1)", () => {
    expect(contrast("#000", "#fff")).toBeCloseTo(21, 5);
    expect(contrastRgb([119, 119, 119], [255, 255, 255])).toBeCloseTo(4.48, 1);
  });

  it("composites translucent colours over the backdrop", () => {
    expect(over({ rgb: [0, 0, 0], a: 0.5 }, [255, 255, 255]).map(Math.round)).toEqual([128, 128, 128]);
  });

  it("rotates hue without changing lightness much and ensureContrast reaches its target", () => {
    expect(rotateHue("#4f46e5", 55)).not.toBe("#4f46e5");
    expect(contrast(ensureContrast("#4f46e5", "#0b0b0d", 4.5, "white"), "#0b0b0d")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(ensureContrast("#ffd400", "#ffffff", 4.5, "black"), "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("style presets: token coverage", () => {
  it("lists default, vivid, blueprint and neon, each with a palette for both modes (default uses the blog tokens)", () => {
    expect([...PRESETS]).toEqual(["default", "vivid", "blueprint", "neon"]);
    expect(PRESET_PALETTES.default).toBeNull();
    for (const p of PRESETS.filter((x) => x !== "default")) {
      for (const m of MODES) expect(PRESET_PALETTES[p]?.[m], `${p}/${m}`).toBeDefined();
    }
  });

  it("every preset resolves every theme field, in both modes and with any accent", () => {
    for (const preset of PRESETS) {
      for (const mode of MODES) {
        for (const accent of ACCENTS) {
          const t = createTheme(mode, accent, preset);
          const where = `${preset}/${mode}/${accent ?? "default"}`;
          for (const [k, v] of Object.entries(t)) {
            if (k !== "glow") expect(v, `${where}.${k}`).not.toBeNull();
            expect(v, `${where}.${k}`).not.toBeUndefined();
          }
          for (const k of ["background", "foreground", "card", "muted", "mutedForeground", "border", "accent", "accentText", "accent2", "accent2Text", "gradient", "accentWash"] as const) {
            expect(typeof t[k], `${where}.${k}`).toBe("string");
            expect((t[k] as string).length, `${where}.${k}`).toBeGreaterThan(0);
          }
          expect(t.preset).toBe(preset);
          expect(t.mode).toBe(mode);
          expect(t.dim).toBeGreaterThan(0);
          expect(t.dim).toBeLessThan(1);
        }
      }
    }
  });

  it("keeps the blog's code surface and highlighting in every preset", () => {
    for (const preset of PRESETS) {
      for (const mode of MODES) {
        const t = createTheme(mode, undefined, preset);
        expect(t.code.bg).toBe(CODE_SURFACE[mode].bg);
        expect(t.code.fg).toBe(CODE_SURFACE[mode].fg);
      }
    }
  });

  it("a custom accent replaces only the accent family, not the surfaces", () => {
    for (const preset of PRESETS) {
      const a = createTheme("dark", undefined, preset);
      const b = createTheme("dark", "#ff0066", preset);
      expect(b.accent).toBe("#ff0066");
      expect(b.background).toBe(a.background);
      expect(b.foreground).toBe(a.foreground);
      expect(b.card).toBe(a.card);
    }
  });

  it("the neon preset glows in dark mode only; the default preset never does", () => {
    expect(createTheme("dark", undefined, "neon").glow).not.toBeNull();
    expect(createTheme("light", undefined, "neon").glow).toBeNull();
    expect(createTheme("dark").glow).toBeNull();
  });

  it("only the blueprint and neon presets draw a grid; only vivid draws a mesh", () => {
    const has = (p: PresetId, m: ThemeMode) => createTheme(m, undefined, p).backdrop;
    expect(has("vivid", "dark").mesh).toBe(true);
    expect(has("blueprint", "dark").grid).not.toBeNull();
    expect(has("neon", "dark").grid).not.toBeNull();
    expect(has("default", "dark")).toEqual({ mesh: false, grid: null, ambient: 0 });
  });
});

describe("style presets: legibility", () => {
  for (const preset of PRESETS) {
    for (const mode of MODES) {
      for (const accent of ACCENTS) {
        it(`${preset} / ${mode} / ${accent ?? "default accent"}: text contrast`, () => {
          const t = createTheme(mode, accent, preset);
          for (const [name, fg, bg, min] of textPairs(t)) {
            expect(contrast(fg, bg), `${name}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
          }
        });
      }
    }
  }

  it("dimmed code lines are never less legible than the first release's (same dim, same surface)", () => {
    const first = (mode: ThemeMode): number => {
      const s = CODE_SURFACE[mode];
      const a = mode === "dark" ? 0.34 : 0.5;
      return contrastRgb(over({ rgb: parseColor(s.fg).rgb, a }, parseColor(s.bg).rgb), parseColor(s.bg).rgb);
    };
    for (const preset of PRESETS) {
      for (const mode of MODES) {
        const t = createTheme(mode, undefined, preset);
        const eff = contrastRgb(over({ rgb: parseColor(t.code.fg).rgb, a: t.dim }, parseColor(t.code.bg).rgb), parseColor(t.code.bg).rgb);
        expect(eff, `${preset}/${mode}`).toBeGreaterThanOrEqual(first(mode) - 1e-9);
        expect(eff, `${preset}/${mode} dimmed code line`).toBeGreaterThanOrEqual(2.2);
      }
    }
  });

  it("the default accent keeps its first-release spelling", () => {
    expect(createTheme("dark").accent).toBe(DEFAULT_ACCENT);
  });
});

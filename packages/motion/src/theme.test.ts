import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODE_THEMES,
  createTheme,
  DEFAULT_ACCENT,
  OG_CARD,
  PROSE,
  RADIUS_BASE_REM,
  RADIUS_SCALE,
  radius,
  SITE_FONTS,
  SITE_TOKENS,
} from "./theme/tokens.ts";
import { REPO } from "./test-helpers.ts";

const read = (...p: string[]): string => readFileSync(path.join(REPO, ...p), "utf8");

/** Variables declared inside `selector { ... }` of globals.css. */
function cssVars(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`selector ${selector} not found in globals.css`);
  const end = css.indexOf("}", start);
  const out: Record<string, string> = {};
  for (const m of css.slice(start, end).matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[m[1] as string] = (m[2] as string).trim();
  return out;
}

describe("theme parity with the blog (apps/web/src/app/globals.css)", () => {
  const css = read("apps", "web", "src", "app", "globals.css");
  const root = cssVars(css, ":root");
  const dark = cssVars(css, ".dark");

  it("light tokens equal :root", () => {
    const { radius: _r, ...colours } = root;
    void _r;
    expect(SITE_TOKENS.light).toEqual(colours);
  });

  it("dark tokens equal .dark", () => {
    expect(SITE_TOKENS.dark).toEqual(dark);
  });

  it("the tokens the engine paints with resolve to the site's values", () => {
    for (const mode of ["light", "dark"] as const) {
      const vars = mode === "light" ? root : dark;
      const t = createTheme(mode);
      expect(t.background).toBe(vars.background);
      expect(t.foreground).toBe(vars.foreground);
      expect(t.card).toBe(vars.card);
      expect(t.muted).toBe(vars.muted);
      expect(t.mutedForeground).toBe(vars["muted-foreground"]);
      expect(t.border).toBe(vars.border);
      expect(t.primary).toBe(vars.primary);
      expect(t.primaryForeground).toBe(vars["primary-foreground"]);
    }
  });

  it("the default accent is the dark-mode --sidebar-primary, the blog's only chromatic token", () => {
    expect(DEFAULT_ACCENT).toBe(dark["sidebar-primary"]);
    const chromatic = (v: string): boolean => /oklch\(\s*[\d.]+\s+(?!0[ )])[\d.]+/.test(v) && !/oklch\([\d.]+ 0 0/.test(v);
    const colourful = Object.entries({ ...root, ...dark })
      .filter(([k, v]) => k !== "radius" && chromatic(v) && !/^(destructive|chart)/.test(k))
      .map(([k]) => k);
    expect(colourful).toEqual(["sidebar-primary"]);
  });

  it("radius scale mirrors @theme inline", () => {
    expect(parseFloat(root.radius ?? "")).toBe(RADIUS_BASE_REM);
    for (const [step, mult] of Object.entries(RADIUS_SCALE)) {
      const expected = step === "lg" ? "var(--radius)" : `calc(var(--radius) * ${mult})`;
      expect(css, step).toContain(`--radius-${step}: ${expected};`);
    }
    expect(radius("lg", 16)).toBe(10);
  });

  it("an accent override changes only the accent colours", () => {
    const a = createTheme("dark");
    const b = createTheme("dark", "#ff0066");
    expect(b.accent).toBe("#ff0066");
    expect(b.background).toBe(a.background);
    expect(b.accentWash).toContain("#ff0066");
  });
});

describe("theme parity: fonts, code themes, OG card, prose", () => {
  it("uses the fonts layout.tsx loads", () => {
    const layout = read("apps", "web", "src", "app", "layout.tsx");
    expect(layout).toContain("Geist, Geist_Mono");
    expect(SITE_FONTS).toEqual({ sans: "Geist", mono: "Geist Mono" });
  });

  it("uses the shiki themes of the markdown renderer", () => {
    const render = read("apps", "api", "src", "lib", "content", "render.ts");
    expect(render).toContain(`themes: { light: "${CODE_THEMES.light}", dark: "${CODE_THEMES.dark}" }`);
  });

  it("matches the Open Graph card", () => {
    const og = read("apps", "web", "src", "app", "(site)", "[slug]", "opengraph-image.tsx");
    expect(og).toContain(`backgroundColor: "${OG_CARD.background}"`);
    expect(og).toContain(`color: "${OG_CARD.foreground}"`);
    expect(og).toContain(`letterSpacing: 2`);
    expect(og).toContain(`fontSize: 28`);
    expect(og).toContain(`opacity: ${OG_CARD.wordmarkOpacity}`);
    expect(og).toContain(`border: "1px solid ${OG_CARD.tagBorder}"`);
    expect(og).toContain(`opacity: ${OG_CARD.tagOpacity}`);
    expect(og).toContain(`fontWeight: ${OG_CARD.titleWeight}`);
    expect(og).toContain(`lineHeight: ${OG_CARD.titleLineHeight}`);
    expect(og).toContain("site.name.toUpperCase()");
    expect(OG_CARD.wordmarkLetterSpacingEm).toBeCloseTo(2 / 28, 6);
  });

  it("matches the prose typography", () => {
    const prose = read("apps", "web", "src", "styles", "prose.css");
    expect(prose).toContain(`font-size: ${PROSE.bodyRem}rem;`);
    expect(prose).toContain(`line-height: ${PROSE.bodyLineHeight};`);
    expect(prose).toContain(`font-weight: ${PROSE.headingWeight};`);
    expect(prose).toContain(`letter-spacing: ${PROSE.headingTracking};`);
    expect(prose).toContain(`font-size: ${PROSE.codeEm}em;`);
    expect(prose).toContain(`line-height: ${PROSE.codeLineHeight};`);
  });
});

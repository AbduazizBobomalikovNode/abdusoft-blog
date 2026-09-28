import { describe, expect, it } from "vitest";
import { slugify } from "./slugify";

// Uzbek oʻ/gʻ digraph apostrophe variants used across the codebase/content:
// U+2018 (‘), straight apostrophe ('), and U+02BB (modifier letter turned comma, ʻ).
const RIGHT_QUOTE = "‘";
const MODIFIER = "ʻ";

describe("slugify", () => {
  it("lowercases and dash-separates plain ascii text", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("handles the Uzbek oʻ/gʻ digraphs written with different apostrophe variants", () => {
    expect(slugify(`Bug${RIGHT_QUOTE}doy`)).toBe("bugdoy");
    expect(slugify("Bug'doy")).toBe("bugdoy");
    expect(slugify(`Bug${MODIFIER}doy`)).toBe("bugdoy");
    expect(slugify(`O${MODIFIER}zbekiston`)).toBe("ozbekiston");
    expect(slugify("Toshkent shahri")).toBe("toshkent-shahri");
  });

  it("strips stray apostrophes and diacritics", () => {
    expect(slugify("O'zbekiston tarixi")).toBe("ozbekiston-tarixi");
    expect(slugify("café")).toBe("cafe");
  });

  it("collapses non-alphanumeric runs into single dashes", () => {
    expect(slugify("AI, AGI va   LLM!!!")).toBe("ai-agi-va-llm");
  });

  it("trims leading and trailing dashes", () => {
    expect(slugify("  --Salom Dunyo--  ")).toBe("salom-dunyo");
  });

  it("returns an empty string for input with no sluggable characters", () => {
    expect(slugify("!!! ??? ---")).toBe("");
  });
});

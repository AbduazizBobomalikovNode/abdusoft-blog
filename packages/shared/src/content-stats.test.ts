import { describe, expect, it } from "vitest";
import { countWords, docPlainText, docStats, readingMinutes } from "./content-stats.js";

describe("content stats", () => {
  it("separates block nodes with spaces", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "bir" }] },
        { type: "paragraph", content: [{ type: "text", text: "ikki" }, { type: "hardBreak" }, { type: "text", text: "uch" }] },
      ],
    };
    expect(docPlainText(doc)).toBe("bir ikki uch");
    expect(docStats(doc).words).toBe(3);
  });

  it("does not split words across inline marks", () => {
    const doc = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "qa" }, { type: "text", text: "lin", marks: [{ type: "bold" }] }] }],
    };
    expect(countWords(docPlainText(doc))).toBe(1);
  });

  it("empty doc has 0 words and 1 minute minimum", () => {
    expect(docStats({ type: "doc", content: [{ type: "paragraph" }] })).toEqual({ words: 0, characters: 0, readingMinutes: 1 });
    expect(docStats(null).words).toBe(0);
  });

  it("uses 200 wpm rounded up", () => {
    expect(readingMinutes(200)).toBe(1);
    expect(readingMinutes(201)).toBe(2);
    expect(readingMinutes(450)).toBe(3);
  });
});

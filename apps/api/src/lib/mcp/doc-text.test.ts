import { describe, expect, it } from "vitest";
import { markdownToDoc } from "@blog/shared";
import { docToReadableText } from "./doc-text.js";

describe("docToReadableText", () => {
  it("renders blocks separated by blank lines, headings with #, lists and tables", () => {
    const { doc } = markdownToDoc(
      ["## Sarlavha", "", "Birinchi **qalin** abzats, [havola](https://example.com).", "", "- bir", "- ikki", "", "1. bitta", "2. ikkita", "", "```ts", "const a = 1;", "```", "", "| A | B |", "|---|---|", "| 1 | 2 |"].join("\n"),
    );
    const text = docToReadableText(doc as never);
    expect(text).toContain("## Sarlavha\n\nBirinchi qalin abzats, havola.");
    expect(text).toContain("- bir\n- ikki");
    expect(text).toContain("1. bitta\n2. ikkita");
    expect(text).toContain("const a = 1;");
    expect(text).toContain("A | B");
    expect(text).not.toMatch(/\*\*|\]\(/);
  });

  it("keeps Uzbek letters, apostrophes and emoji untouched; handles empty input", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "G'oya o'zgardi — ma'no 🚀 ʻoʻ" }] }] };
    expect(docToReadableText(doc as never)).toBe("G'oya o'zgardi — ma'no 🚀 ʻoʻ");
    expect(docToReadableText(null)).toBe("");
    expect(docToReadableText({ type: "doc" })).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import { extractOutline } from "./editor-outline.js";

const h = (level: number, text?: string) => ({ type: "heading", attrs: { level }, content: text ? [{ type: "text", text }] : undefined });

describe("extractOutline", () => {
  it("lists only H2/H3 in document order with sequential indexes", () => {
    const out = extractOutline({
      type: "doc",
      content: [h(2, "Kirish"), { type: "paragraph" }, h(3, "Tarix"), h(4, "Yashirin"), h(2, "Xulosa")],
    });
    expect(out).toEqual([
      { index: 0, level: 2, text: "Kirish" },
      { index: 1, level: 3, text: "Tarix" },
      { index: 2, level: 2, text: "Xulosa" },
    ]);
  });

  it("includes empty headings (text is empty) and nested ones", () => {
    const out = extractOutline({ type: "doc", content: [h(2), { type: "blockquote", content: [h(3, "Ichki")] }] });
    expect(out.map((i) => i.text)).toEqual(["", "Ichki"]);
  });

  it("handles missing doc", () => {
    expect(extractOutline(null)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { TEMPLATES, buildTemplate, docHintTexts, isHintText } from "./editor-templates.js";
import { extractOutline } from "./editor-outline.js";

describe("templates", () => {
  it("every template builds non-empty content with hints", () => {
    for (const t of TEMPLATES) {
      const nodes = buildTemplate(t.id);
      expect(nodes.length).toBeGreaterThan(2);
      expect(docHintTexts({ type: "doc", content: nodes }).length).toBeGreaterThan(0);
    }
  });

  it("article template is intro -> 3 sections -> conclusion", () => {
    const outline = extractOutline({ type: "doc", content: buildTemplate("article") });
    expect(outline.map((o) => o.text)).toEqual(["1-bo'lim", "2-bo'lim", "3-bo'lim", "Xulosa"]);
  });

  it("detects remaining hints and ignores written text", () => {
    const nodes = buildTemplate("news");
    nodes[0] = { type: "paragraph", content: [{ type: "text", text: "Yozilgan xabar" }] };
    expect(docHintTexts({ type: "doc", content: nodes })).toHaveLength(2);
    expect(isHintText("  Yozilgan xabar ")).toBe(false);
  });
});

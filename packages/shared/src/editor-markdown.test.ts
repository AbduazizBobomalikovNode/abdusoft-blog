import { describe, expect, it } from "vitest";
import type { ContentNode as JSONContent } from "./content-stats.js";
import { isImageUrl, looksLikeMarkdown, markdownToDoc } from "./editor-markdown.js";

const types = (nodes: JSONContent[] | undefined) => (nodes ?? []).map((n) => n.type);

describe("markdownToDoc", () => {
  it("pulls the first # heading out as title and maps ##/### to h2/h3", () => {
    const { title, doc } = markdownToDoc("# Mening postim\n\n## Kirish\n\nMatn\n\n#### Chuqur");
    expect(title).toBe("Mening postim");
    expect(types(doc.content)).toEqual(["heading", "paragraph", "heading"]);
    expect(doc.content?.[0]?.attrs).toEqual({ level: 2 });
    expect(doc.content?.[2]?.attrs).toEqual({ level: 3 });
  });

  it("converts inline bold / italic / code / strike / links", () => {
    const { doc } = markdownToDoc("Bu **qalin**, *kursiv*, `kod`, ~~o'chirilgan~~ va [havola](https://example.com).");
    const inline = doc.content?.[0]?.content ?? [];
    const markOf = (text: string) => inline.find((n) => n.text === text)?.marks?.map((m) => m.type);
    expect(markOf("qalin")).toEqual(["bold"]);
    expect(markOf("kursiv")).toEqual(["italic"]);
    expect(markOf("kod")).toEqual(["code"]);
    expect(markOf("o'chirilgan")).toEqual(["strike"]);
    const link = inline.find((n) => n.text === "havola");
    expect(link?.marks?.[0]).toEqual({ type: "link", attrs: { href: "https://example.com" } });
  });

  it("keeps surrounding text intact after bold/strike (no stray markers, no lost spaces)", () => {
    const text = (md: string) => (markdownToDoc(md).doc.content?.[0]?.content ?? []).map((n) => n.text).join("");
    expect(text("Matn **qalin** [havola](https://example.org)")).toBe("Matn qalin havola");
    expect(text("a **b** va ~~c~~ d")).toBe("a b va c d");
    expect(text("**x**, **y**.")).toBe("x, y.");
  });

  it("does not treat snake_case or math stars as emphasis", () => {
    const { doc } = markdownToDoc("snake_case_name va 2 * 3 * 4");
    const inline = doc.content?.[0]?.content ?? [];
    expect(inline).toHaveLength(1);
    expect(inline[0]?.marks).toBeUndefined();
  });

  it("builds nested bullet and ordered lists", () => {
    const { doc } = markdownToDoc("- bir\n  - ichki\n- ikki\n\n1. a\n2. b");
    expect(types(doc.content)).toEqual(["bulletList", "orderedList"]);
    const first = doc.content?.[0]?.content ?? [];
    expect(first).toHaveLength(2);
    expect(types(first[0]?.content)).toEqual(["paragraph", "bulletList"]);
  });

  it("builds code fences with normalized language", () => {
    const { doc } = markdownToDoc("```ts\nconst a = 1;\n\nconst b = 2;\n```");
    expect(doc.content?.[0]).toEqual({
      type: "codeBlock",
      attrs: { language: "typescript" },
      content: [{ type: "text", text: "const a = 1;\n\nconst b = 2;" }],
    });
  });

  it("builds tables with a header row", () => {
    const { doc } = markdownToDoc("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 |");
    const table = doc.content?.[0];
    expect(table?.type).toBe("table");
    expect(types(table?.content?.[0]?.content)).toEqual(["tableHeader", "tableHeader"]);
    expect(types(table?.content?.[2]?.content)).toEqual(["tableCell", "tableCell"]);
  });

  it("maps blockquotes and GitHub alerts to the callout convention", () => {
    const { doc } = markdownToDoc("> oddiy iqtibos\n\n> [!TIP]\n> foydali maslahat");
    expect(types(doc.content)).toEqual(["blockquote", "blockquote"]);
    const tip = doc.content?.[1]?.content?.[0]?.content?.[0];
    expect(tip?.text).toBe("💡 ");
  });

  it("splits inline images into block images", () => {
    const { doc } = markdownToDoc("oldin ![rasm](https://x.test/a.png \"izoh\") keyin");
    expect(types(doc.content)).toEqual(["paragraph", "image", "paragraph"]);
    expect(doc.content?.[1]?.attrs).toEqual({ src: "https://x.test/a.png", alt: "rasm", title: "izoh" });
  });

  it("rejects javascript: links and keeps text", () => {
    const { doc } = markdownToDoc("[x](javascript:alert(1))");
    expect(JSON.stringify(doc)).not.toContain('"link"');
  });

  it("produces only node types the converters know", () => {
    const known = new Set(["doc", "paragraph", "heading", "text", "bulletList", "orderedList", "listItem", "blockquote", "codeBlock", "horizontalRule", "image", "table", "tableRow", "tableCell", "tableHeader", "hardBreak"]);
    const { doc } = markdownToDoc("# T\n\n## H\n\ntext\n\n- a\n\n> q\n\n---\n\n```js\nx\n```\n\n| a |\n|---|\n| b |\n\n![a](https://x.test/i.png)");
    const walk = (n: JSONContent) => {
      expect(known.has(n.type ?? "")).toBe(true);
      (n.content ?? []).forEach(walk);
    };
    walk(doc);
  });

  it("returns an empty paragraph doc for empty input", () => {
    expect(markdownToDoc("").doc.content).toEqual([{ type: "paragraph" }]);
  });
});

describe("looksLikeMarkdown", () => {
  it("detects markdown and ignores plain prose", () => {
    expect(looksLikeMarkdown("## Sarlavha\n\nmatn")).toBe(true);
    expect(looksLikeMarkdown("- a\n- b")).toBe(true);
    expect(looksLikeMarkdown("Oddiy gap, hech qanday belgisiz.\nIkkinchi qator.")).toBe(false);
    expect(looksLikeMarkdown("narxi 5 - 3 = 2")).toBe(false);
  });
});

describe("isImageUrl", () => {
  it("matches image URLs only", () => {
    expect(isImageUrl("https://x.test/a/b.PNG")).toBe(true);
    expect(isImageUrl("https://x.test/page")).toBe(false);
    expect(isImageUrl("https://x.test/a.png?w=1 trailing")).toBe(false);
  });
});

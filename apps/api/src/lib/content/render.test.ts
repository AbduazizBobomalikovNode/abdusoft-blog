import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/core";
import { renderPost } from "./render";

function doc(...content: JSONContent[]): JSONContent {
  return { type: "doc", content };
}

function paragraph(text: string): JSONContent {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function heading(level: number, text: string): JSONContent {
  return { type: "heading", attrs: { level }, content: [{ type: "text", text }] };
}

describe("renderPost", () => {
  it("slugs headings and collects a table of contents for h2/h3 only", async () => {
    const result = await renderPost(
      doc(heading(2, "Kirish"), paragraph("Matn"), heading(3, "Tarix"), heading(4, "Chuqurroq")),
    );

    expect(result.toc).toEqual([
      { id: "kirish", text: "Kirish", level: 2 },
      { id: "tarix", text: "Tarix", level: 3 },
    ]);
    expect(result.html).toContain('id="kirish"');
    expect(result.html).toContain('id="tarix"');
  });

  it("computes reading time from word count at 200 wpm, minimum 1 minute", async () => {
    const short = await renderPost(doc(paragraph("Bir ikki uch")));
    expect(short.readingTime).toBe(1);

    const longText = Array.from({ length: 450 }, (_, i) => `soz${i}`).join(" ");
    const long = await renderPost(doc(paragraph(longText)));
    expect(long.readingTime).toBe(Math.ceil(450 / 200));
  });

  it("builds a truncated excerpt with an ellipsis when text exceeds the limit", async () => {
    const longText = "a".repeat(200);
    const result = await renderPost(doc(paragraph(longText)));
    expect(result.excerpt.length).toBe(161); // 160 chars + ellipsis
    expect(result.excerpt.endsWith("…")).toBe(true);
  });

  it("converts `> ℹ️/⚠️/💡 ...` blockquotes into callout variants and strips the marker", async () => {
    const info = await renderPost(
      doc({ type: "blockquote", content: [paragraph("ℹ️ Diqqat qiling")] }),
    );
    expect(info.html).toContain("callout callout-info");
    expect(info.html).not.toContain("ℹ️");
    expect(info.html).toContain("Diqqat qiling");

    const warning = await renderPost(
      doc({ type: "blockquote", content: [paragraph("⚠️ Ehtiyot bo'ling")] }),
    );
    expect(warning.html).toContain("callout-warning");

    const tip = await renderPost(doc({ type: "blockquote", content: [paragraph("💡 Maslahat")] }));
    expect(tip.html).toContain("callout-tip");
  });

  it("leaves ordinary blockquotes (no emoji marker) unmodified", async () => {
    const result = await renderPost(doc({ type: "blockquote", content: [paragraph("Oddiy iqtibos")] }));
    expect(result.html).not.toContain("callout");
    expect(result.html).toContain("Oddiy iqtibos");
  });

  it("lifts a `// filename.ext` first line of a code block into a data-filename wrapper", async () => {
    const codeBlock = {
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [{ type: "text", text: "// app.ts\nconst x = 1;" }],
    };
    const result = await renderPost(doc(codeBlock));
    expect(result.html).toContain('data-filename="app.ts"');
    expect(result.html).not.toContain("// app.ts");
    // Post-Shiki the code text is split across per-token <span>s, so check the
    // pre-Shiki plain-text extraction instead of the highlighted HTML.
    expect(result.text).toContain("const x = 1;");
  });

  it("does not add a filename wrapper when the code block has no filename comment", async () => {
    const codeBlock = {
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [{ type: "text", text: "const x = 1;" }],
    };
    const result = await renderPost(doc(codeBlock));
    expect(result.html).not.toContain("data-filename");
  });

  it("emits Shiki dual-theme (light/dark) classes for code blocks", async () => {
    const codeBlock = {
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [{ type: "text", text: "const x = 1;" }],
    };
    const result = await renderPost(doc(codeBlock));
    // @shikijs/rehype with themes:{light,dark} + defaultColor:false emits
    // shiki-light-bg / shiki-dark-bg (and per-token shiki-light/shiki-dark) classes.
    expect(result.html).toMatch(/shiki-light/);
    expect(result.html).toMatch(/shiki-dark/);
  });

  it("returns plain text stripped of HTML for search/reading-time purposes", async () => {
    const result = await renderPost(doc(heading(2, "Sarlavha"), paragraph("Gap matni")));
    expect(result.text).toContain("Sarlavha");
    expect(result.text).toContain("Gap matni");
    expect(result.text).not.toContain("<");
  });
});

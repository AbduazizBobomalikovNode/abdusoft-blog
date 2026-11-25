import { describe, expect, it } from "vitest";
import { getSchema, type JSONContent } from "@tiptap/core";
import { DOC_MARK_TYPES, DOC_NODE_TYPES, TEMPLATES, buildTemplate, markdownToDoc, validateDocument, type TemplateId } from "@blog/shared";
import { tiptapExtensions } from "./render.js";
import { samplePostOne, samplePostTwo } from "./sample.js";
import { validateConnectorDocument, validatePanelDocument } from "./validate.js";

const cell = (attrs: Record<string, unknown> = {}) => ({ type: "tableCell", attrs, content: [{ type: "paragraph" }] });
const table = (rows: unknown[]) => ({ type: "doc", content: [{ type: "table", content: rows }] });
const para = (text = "x") => ({ type: "paragraph", content: [{ type: "text", text }] });

function deep(levels: number): unknown {
  let node: Record<string, unknown> = para();
  for (let i = 0; i < levels; i++) node = { type: "blockquote", content: [node] };
  return { type: "doc", content: [node] };
}

const crashing: [string, unknown][] = [
  ["colspan 1e6", table([{ type: "tableRow", content: [cell({ colspan: 1_000_000 })] }])],
  ["colspan 1e9", table([{ type: "tableRow", content: [cell({ colspan: 1_000_000_000 })] }])],
  ["rowspan 1e9", table([{ type: "tableRow", content: [cell({ rowspan: 1_000_000_000 })] }])],
  ["colspan as numeric string", table([{ type: "tableRow", content: [cell({ colspan: "1000000" })] }])],
  ["colspan float", table([{ type: "tableRow", content: [cell({ colspan: 1.5 })] }])],
  ["colspan negative", table([{ type: "tableRow", content: [cell({ colspan: -1 })] }])],
  ["colwidth huge", table([{ type: "tableRow", content: [cell({ colwidth: new Array(100_000).fill(1) })] }])],
  ["huge row count", table(new Array(200_000).fill({ type: "tableRow", content: [cell()] }))],
  ["huge cells per row", table([{ type: "tableRow", content: new Array(200_000).fill(cell()) }])],
  ["deep nesting", deep(5000)],
  ["orderedList start 1e12", { type: "doc", content: [{ type: "orderedList", attrs: { start: 1e12 }, content: [{ type: "listItem", content: [para()] }] }] }],
  ["heading level 99", { type: "doc", content: [{ type: "heading", attrs: { level: 99 }, content: [{ type: "text", text: "x" }] }] }],
  ["giant string attribute", { type: "doc", content: [{ type: "image", attrs: { src: "x".repeat(1_000_000) } }] }],
];

describe("panel-level validation rejects documents that crash the renderer, before rendering", () => {
  it.each(crashing)("%s", (_name, doc) => {
    const started = performance.now();
    const heapBefore = process.memoryUsage().heapUsed;
    const result = validatePanelDocument(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(5);
    expect(performance.now() - started).toBeLessThan(500);
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(64 * 1024 * 1024);
  });

  it("rejects unknown node and mark types and non-documents", () => {
    expect(validatePanelDocument({ type: "doc", content: [{ type: "iframe" }] }).ok).toBe(false);
    expect(validatePanelDocument({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a", marks: [{ type: "highlight" }] }] }] }).ok).toBe(false);
    expect(validatePanelDocument(null).ok).toBe(false);
    expect(validatePanelDocument("doc").ok).toBe(false);
    expect(validatePanelDocument({ type: "paragraph" }).ok).toBe(false);
  });
});

const markdownSample = "## A\n\ntext **b** `c` [d](https://example.com)\n\n- x\n  - y\n\n1. a\n\n> q\n\n```ts\nconst a = 1;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n---\n\n![alt](https://example.com/i.png)\n";
const corpus: [string, JSONContent][] = [
  ["samplePostOne", samplePostOne],
  ["samplePostTwo", samplePostTwo],
  ["markdown import", markdownToDoc(markdownSample).doc as JSONContent],
  ...TEMPLATES.map((t): [string, JSONContent] => [`template ${t.id}`, { type: "doc", content: buildTemplate(t.id as TemplateId) } as JSONContent]),
  ["empty doc", { type: "doc", content: [{ type: "paragraph" }] }],
  ["doc without content", { type: "doc" }],
  ["table with spans and widths", table([{ type: "tableRow", content: [{ type: "tableHeader", attrs: { colspan: 2, rowspan: 1, colwidth: [100, 120], align: null }, content: [para()] }] }]) as JSONContent],
  ["editor link attrs", { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "l", marks: [{ type: "link", attrs: { href: "https://e.com", target: "_blank", rel: "noopener noreferrer nofollow", class: null } }] }] }] }],
];

describe("everything the editor and the fixtures produce still validates (panel level)", () => {
  it.each(corpus)("%s", (_name, doc) => {
    expect(validatePanelDocument(doc).ok).toBe(true);
    // panel level never rewrites the document
    const r = validateDocument(doc, { mode: "panel" });
    expect(r.ok && r.doc === doc).toBe(true);
  });

  it("the node and mark lists equal the renderer's schema", () => {
    const schema = getSchema(tiptapExtensions);
    expect([...DOC_NODE_TYPES].sort()).toEqual(Object.keys(schema.nodes).sort());
    expect([...DOC_MARK_TYPES].sort()).toEqual(Object.keys(schema.marks).sort());
  });
});

describe("connector-level validation", () => {
  const ownImage = (src: string) => ({ type: "doc", content: [{ type: "image", attrs: { src, alt: "a" } }] });

  it("accepts the corpus without own-image nodes and returns a clean copy", async () => {
    const plain = { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "T" }] }, para("hello")] };
    const r = await validateConnectorDocument(plain);
    expect(r.ok).toBe(true);
    const link = await validateConnectorDocument(corpus.find(([n]) => n === "editor link attrs")![1]);
    expect(link.ok).toBe(true);
    // default target/rel/class are dropped, href kept
    expect(JSON.stringify((link as { doc: unknown }).doc)).toContain('"attrs":{"href":"https://e.com"}');
  });

  it("rejects attributes outside the allow-list, unsafe URLs and foreign images", async () => {
    const m = (attrs: Record<string, unknown>) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "l", marks: [{ type: "link", attrs }] }] }] });
    expect((await validateConnectorDocument(m({ href: "javascript:alert(1)" }))).ok).toBe(false);
    expect((await validateConnectorDocument(m({ href: "//evil.example/x" }))).ok).toBe(false);
    expect((await validateConnectorDocument(m({ href: "https://e.com", class: "x" }))).ok).toBe(false);
    expect((await validateConnectorDocument(m({ href: "https://e.com", rel: "me" }))).ok).toBe(false);
    expect((await validateConnectorDocument(m({ href: "https://e.com", target: "_self" }))).ok).toBe(false);
    expect((await validateConnectorDocument({ type: "doc", content: [{ type: "paragraph", attrs: { class: "x" }, content: [] }] })).ok).toBe(false);
    expect((await validateConnectorDocument({ type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "x" }] }] })).ok).toBe(false);
    expect((await validateConnectorDocument(ownImage("https://evil.example/a.png"))).ok).toBe(false);
    expect((await validateConnectorDocument(ownImage("http://127.0.0.1:9/a.png"))).ok).toBe(false);
    expect((await validateConnectorDocument(ownImage("data:image/png;base64,AAAA"))).ok).toBe(false);
  });

  it("accepts the blog's own upload URLs but not traversal out of /uploads", async () => {
    const { config } = await import("../../config.js");
    expect((await validateConnectorDocument(ownImage(`${config.API_ORIGIN}/uploads/2026/a.webp`))).ok).toBe(true);
    expect((await validateConnectorDocument(ownImage(`${config.API_ORIGIN}/uploads/../secret.png`))).ok).toBe(false);
    expect((await validateConnectorDocument(ownImage(`${config.API_ORIGIN}/uploads/%2e%2e/secret.png`))).ok).toBe(false);
    expect((await validateConnectorDocument(ownImage(`${config.API_ORIGIN}/other/a.png`))).ok).toBe(false);
  });

  it("rejects content-model violations (list item without paragraph, table row outside a table)", async () => {
    expect((await validateConnectorDocument({ type: "doc", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "blockquote", content: [para()] }] }] }] })).ok).toBe(false);
    expect((await validateConnectorDocument({ type: "doc", content: [{ type: "tableRow", content: [] }] })).ok).toBe(false);
    expect((await validateConnectorDocument({ type: "doc", content: [] })).ok).toBe(false);
  });

  it("rejects every crashing payload quickly too", async () => {
    for (const [name, doc] of crashing) {
      const started = performance.now();
      expect((await validateConnectorDocument(doc)).ok, name).toBe(false);
      expect(performance.now() - started, name).toBeLessThan(500);
    }
  });
});

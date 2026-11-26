import { beforeAll, describe, expect, it, vi } from "vitest";
import { getSchema, type JSONContent } from "@tiptap/core";
import { TEMPLATES, buildTemplate, markdownToDoc, type TemplateId } from "@blog/shared";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { tiptapExtensions } from "./render.js";
import { samplePostOne, samplePostTwo } from "./sample.js";
import { validatePanelDocument } from "./validate.js";

// `renderPost`ga kirilgan-kirilmaganini kuzatamiz (asl funksiya saqlanadi).
const renderSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("./render.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./render.js")>();
  return {
    ...original,
    renderPost: (...args: Parameters<typeof original.renderPost>) => {
      renderSpy.calls += 1;
      return original.renderPost(...args);
    },
  };
});

const span = (n: number, type = "tableCell") => Array.from({ length: n }, () => ({ type, attrs: { colspan: 32 }, content: [{ type: "paragraph" }] }));
const doc = (...c: unknown[]) => ({ type: "doc", content: c });
/** Reviewer shape 1: table > [tableCell > [tableCell(colspan 32) x N]] (first child is not a row). */
const cellInCell = (n: number) => doc({ type: "table", content: [{ type: "tableCell", content: span(n) }] });
/** Reviewer shape 2: table > [paragraph > tableHeader x N]. */
const headersInParagraph = (n: number) => doc({ type: "table", content: [{ type: "paragraph", content: span(n, "tableHeader") }] });

describe("panel validation is structurally strict about node nesting (the editor's own schema)", () => {
  beforeAll(async () => {
    await migrateTestDb();
  });

  it.each([
    ["cells inside a cell, N=3 (small: passes every size limit)", cellInCell(3)],
    ["headers inside a paragraph, N=3", headersInParagraph(3)],
    ["cells inside a cell, N=1,000", cellInCell(1000)],
    ["headers inside a paragraph, N=1,000", headersInParagraph(1000)],
    ["cells inside a cell, N=11,000 (~612 KB of JSON)", cellInCell(11_000)],
    ["headers inside a paragraph, N=11,000", headersInParagraph(11_000)],
  ])("rejects %s in milliseconds, never reaching the renderer", async (_name, d) => {
    const before = renderSpy.calls;
    const t = performance.now();
    const r = validatePanelDocument(d);
    expect(performance.now() - t).toBeLessThan(300);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message.length).toBeGreaterThan(10);
    // the write service stops at the validator, before renderPost
    const { createDraft } = await import("../posts/write.js");
    const t2 = performance.now();
    const res = await createDraft({ userId: null, role: "system", via: "scheduler" }, { title: "Buzuq jadval", contentJson: d });
    expect(res.ok).toBe(false);
    expect(performance.now() - t2).toBeLessThan(1000);
    expect(renderSpy.calls).toBe(before);
  });

  it("small malformed shapes get a clear structural message", () => {
    const r = validatePanelDocument(cellInCell(3));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/table|structure|not allowed/i);
  });

  it.each([
    ["a row outside a table", doc({ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph" }] }] })],
    ["a list item directly in the document", doc({ type: "listItem", content: [{ type: "paragraph" }] })],
    ["a paragraph directly in a bullet list", doc({ type: "bulletList", content: [{ type: "paragraph" }] })],
    ["a cell directly in a table", doc({ type: "table", content: [{ type: "tableCell", content: [{ type: "paragraph" }] }] })],
    ["a table inside a paragraph", doc({ type: "paragraph", content: [{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph" }] }] }] }] })],
    ["an empty blockquote", doc({ type: "blockquote" })],
  ])("rejects %s", (_n, d) => {
    expect(validatePanelDocument(d).ok).toBe(false);
  });

  it("still accepts the empty shapes the product itself stores (no content / empty content on the root)", () => {
    expect(validatePanelDocument({ type: "doc" }).ok).toBe(true);
    expect(validatePanelDocument({ type: "doc", content: [] }).ok).toBe(true);
    expect(validatePanelDocument({ type: "doc", content: [{ type: "paragraph" }] }).ok).toBe(true);
  });
});

/**
 * Every document the editor can hold is valid in the schema BY CONSTRUCTION (ProseMirror enforces it on every transaction), and
 * `editor.getJSON()` is `doc.toJSON()`. So documents generated from the schema itself stand in for "saved by the real editor".
 */
describe("no document the editor can produce is rejected by the structural rule", () => {
  const schema = getSchema(tiptapExtensions);
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  type PMNode = ReturnType<typeof schema.text>;
  function gen(typeName: string, depth: number): PMNode {
    const type = schema.nodes[typeName]!;
    if (typeName === "text") return schema.text("t " + Math.floor(rnd() * 100));
    const attrs = typeName === "image" ? { src: "https://example.com/a.png" } : null;
    const children: PMNode[] = [];
    let match = type.contentMatch;
    const wanted = depth > 4 ? 0 : Math.floor(rnd() * 4);
    for (let i = 0; i < wanted && match.edgeCount > 0; i++) {
      const edge = match.edge(Math.floor(rnd() * match.edgeCount));
      children.push(gen(edge.type.name, depth + 1));
      match = edge.next;
    }
    const node = type.createAndFill(attrs, children);
    if (!node) throw new Error(`cannot fill ${typeName}`);
    return node as PMNode;
  }

  it("500 randomly generated schema-valid documents all pass", () => {
    let withTables = 0;
    for (let i = 0; i < 500; i++) {
      const node = gen("doc", 0);
      node.check();
      const json = node.toJSON() as JSONContent;
      if (JSON.stringify(json).includes('"table"')) withTables += 1;
      const r = validatePanelDocument(json);
      expect(r.ok, `${JSON.stringify(json).slice(0, 300)} -> ${r.ok ? "" : r.message}`).toBe(true);
    }
    expect(withTables).toBeGreaterThan(5);
  });

  const markdown = "# T\n\n## A\n\ntext **b** `c` [d](https://example.com)\n\n- x\n  - y\n\n1. a\n\n> q\n\n```ts\nconst a = 1;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n---\n\n![alt](https://example.com/i.png)\n";
  const corpus: [string, JSONContent][] = [
    ["samplePostOne", samplePostOne],
    ["samplePostTwo", samplePostTwo],
    ["markdown import", markdownToDoc(markdown).doc as JSONContent],
    ...TEMPLATES.map((t): [string, JSONContent] => [`template ${t.id}`, { type: "doc", content: buildTemplate(t.id as TemplateId) } as JSONContent]),
  ];
  it.each(corpus)("fixture/template/sample %s passes", (_n, d) => {
    expect(validatePanelDocument(d).ok).toBe(true);
  });
});

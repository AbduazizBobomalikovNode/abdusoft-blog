import { describe, expect, it } from "vitest";
import { DOC_LIMITS, validateDocument } from "./doc-validate.js";

const doc = (...content: unknown[]) => ({ type: "doc", content });
const cell = (attrs: Record<string, unknown> = {}) => ({ type: "tableCell", attrs, content: [{ type: "paragraph" }] });
const row = (n: number, attrs: Record<string, unknown> = {}) => ({ type: "tableRow", content: Array.from({ length: n }, () => cell(attrs)) });
const table = (rows: unknown[]) => ({ type: "table", content: rows });
const panel = (d: unknown) => validateDocument(d, { mode: "panel" });

/** Every table column becomes a `<col>` element; the reviewer's two documents cost about 3.5 s CPU / 1.1 GB to render. */
describe("table column groups count toward the render budget", () => {
  it("2,900 one-cell tables with colspan 32 are rejected in milliseconds", () => {
    const d = doc(...Array.from({ length: 2900 }, () => table([row(1, { colspan: 32 })])));
    const t = Date.now();
    const r = panel(d);
    expect(r.ok).toBe(false);
    expect(Date.now() - t).toBeLessThan(500);
  });
  it("93 tables of 32 cells with colspan 32 are rejected in milliseconds", () => {
    const d = doc(...Array.from({ length: 93 }, () => table([row(32, { colspan: 32 })])));
    const t = Date.now();
    expect(panel(d).ok).toBe(false);
    expect(Date.now() - t).toBeLessThan(500);
  });
  it("a table's columns are counted as render elements (first row spans)", () => {
    const wide = doc(...Array.from({ length: 12 }, () => table([row(32, { colspan: 32 })])));
    const r = panel(wide);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/table columns/);
    expect(panel(doc(...Array.from({ length: 5 }, () => table([row(32, { colspan: 32 })])))).ok).toBe(true);
  });
  it("ordinary tables are unaffected (only the first row's spans are columns)", () => {
    expect(panel(doc(table(Array.from({ length: 100 }, () => row(30))))).ok).toBe(true);
    expect(DOC_LIMITS.maxRenderElements).toBe(12_000);
  });
});

/** The renderer emits a `<col>` per spanned column of the table's FIRST child, whatever its type is. */
describe("table columns are counted from whatever the renderer would use (first child of any type)", () => {
  const spanned = (n: number) => Array.from({ length: n }, () => ({ type: "tableCell", attrs: { colspan: 32 }, content: [{ type: "paragraph" }] }));
  it("a first child that is not a tableRow but holds spanned cells is still counted", () => {
    const t = Date.now();
    for (const first of [{ type: "tableCell", content: spanned(1000) }, { type: "paragraph", content: spanned(1000).map((c) => ({ ...c, type: "tableHeader" })) }]) {
      const r = panel(doc({ type: "table", content: [first] }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/table columns|cells/);
    }
    expect(Date.now() - t).toBeLessThan(500);
  });
});

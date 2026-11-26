import { describe, expect, it } from "vitest";
import { DOC_LIMITS, RENDER_COST, estimateRenderCost, validateDocument } from "./doc-validate.js";

const para = (text = "x", marks?: unknown[]) => ({ type: "paragraph", content: [{ type: "text", text, ...(marks ? { marks } : {}) }] });
const doc = (...content: unknown[]) => ({ type: "doc", content });
const cell = (attrs: Record<string, unknown> = {}) => ({ type: "tableCell", attrs, content: [{ type: "paragraph" }] });
const row = (n: number, attrs: Record<string, unknown> = {}) => ({ type: "tableRow", content: Array.from({ length: n }, () => cell(attrs)) });
const code = (chars: number, language: string | null) => ({ type: "codeBlock", attrs: { language }, content: [{ type: "text", text: "x".repeat(chars) }] });
const panel = (d: unknown) => validateDocument(d, { mode: "panel" });
const connector = (d: unknown) => validateDocument(d, { mode: "connector", isAllowedImageUrl: () => true });

/** The reviewer's memory-exhausting documents: the SAME shapes, rejected cheaply (before anything is rendered). */
describe("the panel validator bounds totals, not only single values", () => {
  const cases: [string, () => unknown][] = [
    ["50 code blocks of 260 KB (13 MB)", () => doc(...Array.from({ length: 50 }, () => code(260_000, null)))],
    ["5000 images with 16 KB attributes (160 MB)", () => doc(...Array.from({ length: 5000 }, (_, i) => ({ type: "image", attrs: { src: `/uploads/${i}.webp`, alt: "a".repeat(16_000), title: "t".repeat(16_000) } })))],
    ["20,000 table cells", () => doc({ type: "table", content: Array.from({ length: 1000 }, () => row(20)) })],
    ["1000 x 20 cells with spans of 64", () => doc({ type: "table", content: Array.from({ length: 1000 }, () => row(20, { colspan: 64, rowspan: 64 })) })],
    ["40 text nodes of 500,000 characters", () => doc(...Array.from({ length: 40 }, () => para("a".repeat(500_000))))],
    ["60,000 plain paragraphs", () => doc(...Array.from({ length: 20_000 }, () => para("x")), ...Array.from({ length: 20_000 }, () => para("x")), ...Array.from({ length: 20_000 }, () => para("y")))],
    ["5,000 formatted runs with 6 marks (36,000 elements)", () => doc(...Array.from({ length: 5_000 }, () => para("w", ["bold", "italic", "strike", "underline", "code", "bold"].map((type) => ({ type })))))],
    ["600 images", () => doc(...Array.from({ length: 600 }, (_, i) => ({ type: "image", attrs: { src: `/uploads/${i}.webp` } })))],
    ["60,000 characters of code with a language", () => doc(code(60_000, "typescript"))],
  ];
  it.each(cases)("%s is rejected in well under a second", (_name, make) => {
    const d = make();
    const started = Date.now();
    const result = panel(d);
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(750);
  });

  it("documents just under each limit are accepted", () => {
    const L = DOC_LIMITS;
    const ok: [string, unknown][] = [
      ["elements", doc(...Array.from({ length: L.maxRenderElements - 100 }, () => para("x")))],
      ["total text", doc(...Array.from({ length: 100 }, () => para("l".repeat(9_900))))],
      ["highlighted code", doc(code(L.maxHighlightedCode, "typescript"))],
      ["plain code", doc(code(L.maxTotalCode, null))],
      ["table cells", doc({ type: "table", content: Array.from({ length: 100 }, () => row(30)) })],
      ["spans", doc({ type: "table", content: [row(10, { colspan: L.maxSpan, rowspan: L.maxSpan })] })],
      ["images", doc(...Array.from({ length: L.maxImages }, (_, i) => ({ type: "image", attrs: { src: `/uploads/${i}.webp` } })))],
    ];
    for (const [name, d] of ok) {
      const r = panel(d);
      expect(r.ok, `${name}: ${r.ok ? "" : r.message}`).toBe(true);
    }
  });

  it("the combination of several near-limit shapes is bounded by the cost estimate, not only by the single limits", () => {
    const L = DOC_LIMITS;
    const d = doc(code(L.maxHighlightedCode, "typescript"), ...Array.from({ length: L.maxRenderElements - 50 }, () => para("x")));
    const r = panel(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/too heavy to render/);
  });

  it("the estimate never exceeds the allowance for any accepted document (budget arithmetic)", () => {
    const worst = estimateRenderCost({ elements: DOC_LIMITS.maxRenderElements, textChars: DOC_LIMITS.maxTotalText, highlightedCodeChars: 0, plainCodeChars: 0 });
    expect(worst.bytes).toBeLessThan(RENDER_COST.budgetBytes);
    expect(RENDER_COST.budgetUs).toBeLessThanOrEqual(1_000_000);
    expect(RENDER_COST.budgetBytes).toBeLessThanOrEqual(200 * 1024 * 1024);
  });
});

describe("connector tables are small", () => {
  it("rejects spans above 10 and more than 500 cells (the 73x64 / span 64 table cost seconds)", () => {
    expect(connector(doc({ type: "table", content: Array.from({ length: 73 }, () => row(64, { colspan: 64, rowspan: 64 })) })).ok).toBe(false);
    expect(connector(doc({ type: "table", content: [row(2, { colspan: 11 })] })).ok).toBe(false);
    expect(connector(doc({ type: "table", content: [row(2, { rowspan: 11 })] })).ok).toBe(false);
    expect(connector(doc({ type: "table", content: Array.from({ length: 51 }, () => row(10)) })).ok).toBe(false); // 510 cells
  });
  it("accepts a table with spans of 10 and exactly 500 cells", () => {
    expect(connector(doc({ type: "table", content: Array.from({ length: 50 }, () => row(10, { colspan: 10, rowspan: 10 })) })).ok).toBe(true);
  });
  it("the human panel still allows what the editor can build (spans up to the column count, 30 x 100)", () => {
    expect(panel(doc({ type: "table", content: Array.from({ length: 100 }, () => row(30, { colspan: 12 })) })).ok).toBe(true);
  });
});

describe("link hrefs in connector documents", () => {
  const link = (href: string) => doc({ type: "paragraph", content: [{ type: "text", text: "l", marks: [{ type: "link", attrs: { href } }] }] });
  it.each(["/\\evil.example", "/\\\\evil.example", "//evil.example", "javascript:alert(1)"])("rejects %s", (href) => {
    expect(connector(link(href)).ok).toBe(false);
  });
  it.each(["/post-slug", "/a/b?c=d", "#section", "https://example.com/x", "mailto:a@example.com"])("accepts %s", (href) => {
    expect(connector(link(href)).ok).toBe(true);
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { DOC_LIMITS, validateDocument } from "@blog/shared";
import { renderPost } from "./render.js";

const para = (text = "x") => ({ type: "paragraph", content: [{ type: "text", text }] });
const doc = (...content: unknown[]) => ({ type: "doc", content });
const cell = (attrs: Record<string, unknown> = {}) => ({ type: "tableCell", attrs, content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }] });
const row = (n: number, attrs: Record<string, unknown> = {}) => ({ type: "tableRow", content: Array.from({ length: n }, () => cell(attrs)) });
const code = (chars: number, language: string | null) => ({ type: "codeBlock", attrs: { language }, content: [{ type: "text", text: "const a: number = 1; // x\n".repeat(Math.ceil(chars / 25)).slice(0, chars) }] });
const marks = ["bold", "italic", "strike", "underline", "code"].map((type) => ({ type }));

/**
 * Whatever the panel validator accepts must also be cheap to render. These are documents just UNDER each limit; the CPU ceiling here
 * (4 s) is deliberately loose so a loaded CI machine does not flake - the measured figures (about 0.3-0.9 s CPU, <150 MB on a
 * quiet machine) are in the pull request. The worst case by the validator's own estimate (`RENDER_COST`) is also exercised.
 */
const L = DOC_LIMITS;
const justUnder: [string, () => unknown][] = [
  ["rendered elements (plain paragraphs)", () => doc(...Array.from({ length: L.maxRenderElements - 20 }, () => para("x")))],
  ["rendered elements (paragraphs with 5 marks each)", () => doc(...Array.from({ length: Math.floor((L.maxRenderElements - 20) / 6) }, () => ({ type: "paragraph", content: [{ type: "text", text: "w", marks }] })))],
  ["highlighted code", () => doc(code(L.maxHighlightedCode, "typescript"))],
  ["plain code", () => doc(code(L.maxTotalCode, null))],
  ["total text", () => doc(...Array.from({ length: 100 }, () => para("lorem ipsum ".repeat(830))))],
  ["table cells (100 x 30)", () => doc({ type: "table", content: Array.from({ length: 100 }, () => row(30)) })],
  ["table cells with maximal spans", () => doc({ type: "table", content: Array.from({ length: 90 }, () => row(32, { colspan: L.maxSpan, rowspan: L.maxSpan })) })],
  ["images", () => doc(...Array.from({ length: L.maxImages }, (_, i) => ({ type: "image", attrs: { src: `http://localhost:4000/uploads/${i}.webp`, alt: "a".repeat(1000) } })))],
  ["worst case by the cost estimate (many elements + code)", () => doc(code(8_000, "typescript"), ...Array.from({ length: 11_900 }, () => para("w")))],
];

describe("documents just under the panel limits render cheaply", () => {
  // Warm-up: the first render loads the highlighter and the editor schema (a one-off cost that is not part of a document's own cost).
  beforeAll(async () => {
    await renderPost(doc(code(200, "typescript"), { type: "table", content: [row(2)] }) as never);
  }, 60_000);

  it.each(justUnder)("%s", async (_name, make) => {
    const d = make();
    const checked = validateDocument(d, { mode: "panel" });
    expect(checked.ok, checked.ok ? "" : checked.message).toBe(true);
    const before = process.cpuUsage();
    const rendered = await renderPost(d as never);
    const cpu = process.cpuUsage(before);
    expect(rendered.html.length).toBeGreaterThan(0);
    expect((cpu.user + cpu.system) / 1000).toBeLessThan(4000);
  }, 30_000);
});

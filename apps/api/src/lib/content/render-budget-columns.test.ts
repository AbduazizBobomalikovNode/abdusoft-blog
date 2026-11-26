import { beforeAll, describe, expect, it } from "vitest";
import { validateDocument } from "@blog/shared";
import { renderPost } from "./render.js";

const doc = (...c: unknown[]) => ({ type: "doc", content: c });
const cell = (a: Record<string, unknown> = {}) => ({ type: "tableCell", attrs: a, content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }] });
const row = (n: number, a: Record<string, unknown> = {}) => ({ type: "tableRow", content: Array.from({ length: n }, () => cell(a)) });
const wideTables = (n: number) => doc(...Array.from({ length: n }, () => ({ type: "table", content: [row(32, { colspan: 32 })] })));

describe("table column groups are part of the render budget", () => {
  beforeAll(async () => {
    await renderPost(doc({ type: "table", content: [row(2)] }) as never);
  }, 60_000);

  it("the reviewer's documents (2,900 tables with colspan 32; 93 tables of 32x32 spans) are rejected without rendering anything", () => {
    for (const d of [doc(...Array.from({ length: 2900 }, () => ({ type: "table", content: [row(1, { colspan: 32 })] }))), wideTables(93)]) {
      const t = Date.now();
      expect(validateDocument(d, { mode: "panel" }).ok).toBe(false);
      expect(Date.now() - t).toBeLessThan(500);
    }
  });

  it("the heaviest accepted wide-table document (11 tables of 32 cells with colspan 32, ~11,990 elements) renders well inside the budget", async () => {
    const d = wideTables(11);
    expect(validateDocument(d, { mode: "panel" }).ok).toBe(true);
    const before = process.cpuUsage();
    const rendered = await renderPost(d as never);
    const c = process.cpuUsage(before);
    expect(rendered.html).toContain("<col");
    // measured ~0.6 s CPU / ~90 MB on a quiet machine; the ceiling is loose so a loaded CI machine does not flake
    expect((c.user + c.system) / 1000).toBeLessThan(4000);
  }, 30_000);
});

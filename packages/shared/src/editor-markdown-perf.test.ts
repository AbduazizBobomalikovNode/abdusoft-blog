import { describe, expect, it } from "vitest";
import { MARKDOWN_LIMITS, markdownToDoc } from "./editor-markdown.js";

/** Zararli kirishlar: har biri ~80 000 belgi. Eski parser bularda 7-12+ soniya (yoki stack overflow) sarflardi. */
const N = 80_000;
const rep = (unit: string) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);

const SHAPES: [string, string][] = [
  ["unmatched ** openers", rep("**a ")],
  ["unmatched __ openers", rep("__a ")],
  ["unmatched ~~ openers", rep("~~a ")],
  ["unmatched * openers", rep("*a ")],
  ["unmatched _ openers", rep("_a ")],
  ["unmatched [ openers", "[".repeat(N)],
  ["unmatched ![ openers", "![".repeat(N / 2)],
  ["unmatched ( after brackets", rep("[a](")],
  ["nested brackets without targets", "[".repeat(N / 2) + "]".repeat(N / 2)],
  ["nested link targets", rep("[a](") + ")".repeat(N / 4)],
  ["unmatched backticks", "`".repeat(N)],
  ["distinct backtick runs", Array.from({ length: 400 }, (_, i) => "`".repeat(i + 1) + "a").join(" ")],
  ["backtick run then single", "`".repeat(N / 2) + "x`" + "y".repeat(N / 2 - 2)],
  ["unmatched autolinks", rep("<http://")],
  ["bare urls under a link", "[" + rep("http://http://") + "](https://e.com)"],
  ["bare url with long punctuation tail", "http://" + ".".repeat(N)],
  ["many urls", rep("http://a.b/c ")],
  ["emphasis nesting", "**a *b ~~c __d ".repeat(N / 16)],
  ["deep nested emphasis", "*".concat("_*".repeat(N / 2))],
  ["escaped closers", rep("**a \\**")],
  ["trailing spaces line", "a" + " ".repeat(N) + "b"],
  ["spaces then dash", " ".repeat(N / 2) + "-x"],
  ["heading with space run", "# a" + " ".repeat(N) + "b"],
  ["heading with hash run", "# a " + "#".repeat(N)],
  ["fence info run", "```" + "a".repeat(N) + "`"],
  ["table separator spaces", "| a |\n" + " ".repeat(N / 2) + "-x"],
  ["hr dashes", "- ".repeat(N / 2) + "x"],
  ["many short lines", rep("a\n")],
  ["many list items", rep("- a\n")],
  ["many quote lines", rep("> a\n")],
  ["many fence lines", "```\n" + rep("x\n") + "```"],
];

describe("markdown parsing stays fast on adversarial input", () => {
  it.each(SHAPES)("%s", (_name, input) => {
    const started = Date.now();
    const result = markdownToDoc(input);
    const ms = Date.now() - started;
    expect(result.doc.type).toBe("doc");
    expect(ms).toBeLessThan(1500);
  });

  it("deep blockquote nesting is bounded instead of overflowing the stack", () => {
    for (const input of ["> ".repeat(N / 2) + "x", rep("> ")]) {
      const started = Date.now();
      const result = markdownToDoc(input);
      expect(Date.now() - started).toBeLessThan(1500);
      expect(result.limited).toContain("block-nesting");
    }
  });

  it("deep list nesting is bounded", () => {
    const lines: string[] = [];
    for (let d = 0; d < 3000; d++) lines.push(`${" ".repeat(d)}- x`);
    const started = Date.now();
    const result = markdownToDoc(lines.join("\n"));
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.limited).toContain("block-nesting");
  });

  it("deep inline nesting is bounded and reported", () => {
    const input = "[".repeat(2000) + "x" + "](/a)".repeat(2000);
    const result = markdownToDoc(input);
    expect(result.limited).toContain("inline-nesting");
  });

  it("a wide or huge table cannot multiply into millions of cells", () => {
    const wide = `|${"a|".repeat(200)}\n|${"--|".repeat(200)}\n|1|\n`;
    expect(markdownToDoc(wide).limited).toContain("table-size");
    const header = `|${"a|".repeat(60)}\n|${"--|".repeat(60)}\n`;
    const huge = header + "|\n".repeat(20_000);
    const started = Date.now();
    const result = markdownToDoc(huge);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.limited).toContain("table-size");
    const table = result.doc.content?.find((n) => n.type === "table");
    const cells = (table?.content ?? []).reduce((sum, row) => sum + (row.content?.length ?? 0), 0);
    expect(cells).toBeLessThanOrEqual(MARKDOWN_LIMITS.maxTableCells);
  });

  it("ordinary documents never report a limit", () => {
    const doc = "## A\n\n- x\n  - y\n\n> q\n> > r\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n**b** *i* [l](https://e.com)";
    expect(markdownToDoc(doc).limited).toBeUndefined();
  });
});

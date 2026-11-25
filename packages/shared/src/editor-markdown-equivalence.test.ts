import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { markdownToDoc, setInlineIndexThreshold } from "./editor-markdown.js";
import { markdownToDoc as referenceMarkdownToDoc } from "./testing/editor-markdown-v1.reference.js";

/**
 * Parser qayta yozilgan (chiziqli vaqt). Bu test eski (muzlatilgan) nusxa bilan SOLISHTIRADI: har bir kirish uchun natija
 * bayt-bayt bir xil bo'lishi kerak (`limited` maydoni faqat chegaraga urilganda qo'shiladi va bu testlarda urilmaydi).
 */

// Deterministik tasodifiy generator.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const PIECES = [
  "a", "b", "word", " ", " ", "  ", "\n", "\n\n", "**", "__", "~~", "*", "_", "`", "``", "```", "\\", "\\*", "\\[", "[", "]", "(", ")", "![", "](https://e.com)",
  "](/x)", "](#a)", "](bad)", "](https://e.com \"t\")", "<", ">", "<https://a.b>", "http://x.y", "https://x.y/z.", "h", "ttp", "# ", "## ", "- ", "1. ", "> ", "|", "|-", "---",
  "~~~", "ts", " ", "\t", "!", "x_y", "2*3", "[ ]", "<http://", ")", "mailto:a@b.c", ":", ".", ",",
];

function randomInput(r: () => number): string {
  const n = 1 + Math.floor(r() * 40);
  let out = "";
  for (let i = 0; i < n; i++) out += PIECES[Math.floor(r() * PIECES.length)];
  return out;
}

const CORPUS = [
  "# Sarlavha\n\nOddiy **qalin** va *kursiv* hamda `kod` va [havola](https://example.com \"sarlavha\") hamda ![rasm](https://example.com/a.png).",
  "- bir\n  - ichki\n    - yana\n- ikki\n\n1. a\n2. b\n\n> iqtibos\n> > ichki\n\n> [!TIP]\n> maslahat",
  "| A | B |\n|---|---|\n| 1 | 2 |\n| **x** | `y` |\n\n---\n\n```ts\nconst a = 1;\n```\n\n~~~\nplain\n~~~",
  "Qator oxirida  \nqattiq uzilish\\\nva yana. https://example.com/yo'l?x=1, va <https://a.b/c> hamda x_y_z va 2*3*4.",
  "Escape: \\*not\\* \\[x\\](y) \\\\ **a \\** b** ~~a~~ __b__ ***c*** _d_ *e*",
  "[a [b] c](https://e.com) [x](  <https://e.com>  ) [y](https://e.com 'q') ![a\\]b](/i.png)",
  "---\nfront: matter\n---\n\n## Real",
];

describe.each([
  ["indexed path forced for every string", 0],
  ["default thresholds", 192],
])("the linear-time parser equals the frozen reference parser (%s)", (_label, threshold) => {
  beforeEach(() => setInlineIndexThreshold(threshold));
  afterAll(() => setInlineIndexThreshold(192));

  it("on the handwritten corpus", () => {
    for (const md of CORPUS) expect(JSON.stringify(markdownToDoc(md))).toBe(JSON.stringify(referenceMarkdownToDoc(md)));
  });

  it("on 6000 random inputs built from markdown-significant fragments", () => {
    const r = rng(20260101);
    for (let k = 0; k < 6000; k++) {
      const md = randomInput(r);
      const a = JSON.stringify(markdownToDoc(md));
      const b = JSON.stringify(referenceMarkdownToDoc(md));
      if (a !== b) throw new Error(`parser output differs for input ${JSON.stringify(md)}`);
    }
  });

  it("on 600 longer random inputs (several blocks and nesting)", () => {
    const r = rng(7);
    for (let k = 0; k < 600; k++) {
      let md = "";
      const parts = 2 + Math.floor(r() * 12);
      for (let p = 0; p < parts; p++) md += `${randomInput(r)}\n${r() < 0.5 ? "\n" : ""}`;
      const a = JSON.stringify(markdownToDoc(md));
      const b = JSON.stringify(referenceMarkdownToDoc(md));
      if (a !== b) throw new Error(`parser output differs for input ${JSON.stringify(md)}`);
    }
  });
});

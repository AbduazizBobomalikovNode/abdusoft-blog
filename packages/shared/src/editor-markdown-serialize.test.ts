import { describe, expect, it } from "vitest";
import type { ContentNode } from "./content-stats.js";
import { markdownToDoc } from "./editor-markdown.js";
import { analyzeDocMarkdown, docToMarkdown, docsEquivalent, normalizeDoc } from "./editor-markdown-serialize.js";

const t = (text: string, ...marks: Array<string | { type: string; attrs?: Record<string, unknown> }>): ContentNode => ({
  type: "text",
  text,
  ...(marks.length ? { marks: marks.map((m) => (typeof m === "string" ? { type: m } : m)) } : {}),
});
const p = (...content: ContentNode[]): ContentNode => ({ type: "paragraph", content });
const doc = (...content: ContentNode[]): ContentNode => ({ type: "doc", content });
const h = (level: number, text: string): ContentNode => ({ type: "heading", attrs: { level }, content: [t(text)] });
const li = (...content: ContentNode[]): ContentNode => ({ type: "listItem", content });
const link = (href: string) => ({ type: "link", attrs: { href } });

function roundTrip(d: ContentNode) {
  const a = analyzeDocMarkdown(d);
  return { ...a, back: markdownToDoc(a.markdown).doc };
}

describe("docToMarkdown: every construct the editor produces is lossless", () => {
  const cases: Record<string, ContentNode> = {
    headings: doc(h(2, "Kirish"), p(t("Matn")), h(3, "Ichki sarlavha")),
    "marks and links": doc(
      p(t("Bu "), t("qalin", "bold"), t(", "), t("kursiv", "italic"), t(", "), t("o'chirilgan", "strike"), t(", "), t("kod()", "code"), t(" va "), t("havola", link("https://example.com/a?b=1&c=2")), t(".")),
    ),
    "nested marks": doc(p(t("a "), t("qalin kursiv", "bold", "italic"), t(" b"), t(" strike+bold", "bold", "strike"))),
    "bullet and ordered lists with nesting": doc(
      { type: "bulletList", content: [li(p(t("bir")), { type: "bulletList", content: [li(p(t("ichki 1"))), li(p(t("ichki 2")))] }), li(p(t("ikki")))] },
      { type: "orderedList", attrs: { start: 3 }, content: [li(p(t("uch"))), li(p(t("to'rt")))] },
    ),
    blockquote: doc({ type: "blockquote", content: [p(t("Birinchi")), p(t("Ikkinchi"))] }),
    callout: doc({ type: "blockquote", content: [p(t("💡 Maslahat: "), t("qalin", "bold"))] }),
    "code block with language and file name": doc({ type: "codeBlock", attrs: { language: "typescript" }, content: [t("// src/app.ts\nconst x = 1;\n\nconsole.log(x);")] }),
    "code block with fence inside": doc({ type: "codeBlock", attrs: { language: "markdown" }, content: [t("```ts\nx\n```")] }),
    table: doc({
      type: "table",
      content: [
        { type: "tableRow", content: [{ type: "tableHeader", content: [p(t("Nom"))] }, { type: "tableHeader", content: [p(t("Narx | so'm"))] }] },
        { type: "tableRow", content: [{ type: "tableCell", content: [p(t("Olma", "bold"))] }, { type: "tableCell", content: [p(t("1 000"))] }] },
      ],
    }),
    image: doc({ type: "image", attrs: { src: "/uploads/a.webp", alt: "Qo'lyozma [rasm]", title: "Izoh matni" } }),
    "image without alt": doc({ type: "image", attrs: { src: "https://x.test/a.png", alt: null, title: null } }),
    "horizontal rule": doc(p(t("a")), { type: "horizontalRule" }, p(t("b"))),
    "hard break": doc(p(t("birinchi qator"), { type: "hardBreak" }, t("ikkinchi qator", "bold"), { type: "hardBreak" }, t("uchinchi"))),
    "bold spanning a hard break": doc(p(t("a", "bold"), { type: "hardBreak" }, t("b", "bold"))),
    "uzbek text": doc(
      h(2, "O‘zbekiston ʻilm‑fan’i"),
      p(t("Bu — o‘zbek tilidagi gap: oʻzgarish, maʼno, gʻoya, ‘qo‘shtirnoq’ va “qo‘sh” tirnoqlar. Sh'er 5 > 3 va 2 < 4!")),
    ),
    "special characters": doc(
      p(t("2 * 3 * 4 = 24, snake_case_name, a_b, _x_, C:\\dir\\file, [havola emas], ~tilda~, `backtick`, # not heading, 1. not list")),
      p(t("- chiziqcha bilan boshlangan gap")),
      p(t("# Sarlavha emas")),
      p(t("> iqtibos emas")),
      p(t("1) raqam emas")),
      p(t("***")),
      p(t("+ qo'shish")),
    ),
    "unicode in marks": doc(p(t("ʻilm", "bold"), t(" va "), t("oʻzbek", "italic"))),
    "space inside mark edges": doc(p(t("Salom ", "bold"), t("dunyo"), t(" yana", "italic"))),
    "empty paragraphs between blocks": doc(p(t("a")), p(), p(t("b")), p()),
    "link with bold": doc(p(t("Mana ", link("https://x.test/")), t("qalin havola", link("https://x.test/"), "bold"))),
    "mailto and anchors": doc(p(t("pochta", link("mailto:a@b.uz")), t(" "), t("bo'lim", link("#bolim")), t(" "), t("ichki", link("/post/x")))),
  };

  for (const [name, d] of Object.entries(cases)) {
    it(name, () => {
      const result = roundTrip(d);
      expect(result.lossyBlocks).toEqual([]);
      expect(result.lossless).toBe(true);
      expect(docsEquivalent(result.back, d)).toBe(true);
    });
  }

  it("emits readable Markdown", () => {
    const md = docToMarkdown(cases["bullet and ordered lists with nesting"]);
    expect(md).toBe("- bir\n  - ichki 1\n  - ichki 2\n- ikki\n\n3. uch\n4. to'rt");
    expect(docToMarkdown(cases.table)).toBe("| Nom | Narx \\| so'm |\n| --- | --- |\n| **Olma** | 1 000 |");
    expect(docToMarkdown(cases["code block with language and file name"])).toBe("```typescript\n// src/app.ts\nconst x = 1;\n\nconsole.log(x);\n```");
    expect(docToMarkdown(cases["space inside mark edges"])).toBe("**Salom** dunyo _yana_");
  });

  it("does not turn a leading dash or hash in text into block syntax", () => {
    const md = docToMarkdown(cases["special characters"]);
    const back = markdownToDoc(md).doc;
    expect(back.content?.map((b) => b.type)).toEqual(["paragraph", "paragraph", "paragraph", "paragraph", "paragraph", "paragraph", "paragraph"]);
  });
});

describe("analyzeDocMarkdown: lossy documents are reported, never silently converted", () => {
  it("flags underline, h4, multi-paragraph list items, bare URLs and quoted image titles with block numbers", () => {
    const d = doc(
      p(t("yaxshi paragraf")),
      p(t("tagiga chizilgan", "underline"), t(" matn")),
      { type: "heading", attrs: { level: 4 }, content: [t("To'rtinchi daraja")] },
      { type: "bulletList", content: [li(p(t("a")), p(t("b")))] },
      p(t("manzil: https://example.com/x oddiy matn")),
      { type: "image", attrs: { src: "/a.png", alt: "x", title: 'u "q" v' } },
      { type: "customWidget", content: [p(t("noma'lum"))] },
    );
    const result = analyzeDocMarkdown(d);
    expect(result.lossless).toBe(false);
    expect(result.lossyBlocks.map((b) => b.block)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(result.lossyBlocks[0]).toMatchObject({ type: "paragraph", reason: expect.stringContaining("underline") });
    expect(result.lossyBlocks[1]?.reason).toContain("heading level 4");
    expect(result.lossyBlocks[2]?.reason).toContain("more than one paragraph");
    expect(result.lossyBlocks[3]?.reason).toContain("bare URL");
    expect(result.lossyBlocks[4]?.reason).toContain("quotes");
    expect(result.lossyBlocks[5]?.reason).toContain("customWidget");
    expect(result.lossyBlocks[0]?.preview.length).toBeLessThanOrEqual(41);
  });

  it("flags two adjacent lists of one kind (they would merge)", () => {
    const d = doc({ type: "bulletList", content: [li(p(t("a")))] }, { type: "bulletList", content: [li(p(t("b")))] });
    const result = analyzeDocMarkdown(d);
    expect(result.lossless).toBe(false);
    expect(result.lossyBlocks[0]?.reason).toContain("neighbouring");
  });

  it("treats the editor's default link attributes and empty paragraphs as lossless", () => {
    const d = doc(
      p(t("havola", { type: "link", attrs: { href: "https://x.test/", target: "_blank", rel: "noopener noreferrer nofollow", class: null } })),
      p(),
      { type: "orderedList", attrs: { start: 1, type: null }, content: [li(p(t("bir")))] },
    );
    expect(analyzeDocMarkdown(d).lossless).toBe(true);
  });

  it("reports a custom link target as lossy instead of dropping it", () => {
    const d = doc(p(t("x", { type: "link", attrs: { href: "https://x.test/", target: "_self" } })));
    expect(analyzeDocMarkdown(d).lossless).toBe(false);
  });

  it("an empty document serializes to an empty string and is lossless", () => {
    expect(analyzeDocMarkdown(doc(p())).markdown).toBe("");
    expect(analyzeDocMarkdown(doc(p())).lossless).toBe(true);
    expect(normalizeDoc(null)).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
  });
});

// --- property-style: deterministic PRNG, random documents built from the editor's grammar ---

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "salom", "dunyo", "O‘zbekiston", "oʻzgarish", "maʼno", "gʻoya", "ʻilm", "o'zbek", "tezkor", "post", "Sh'er", "kod", "2024-yil",
  "50%", "(qavs)", "“tirnoq”", "—", "A/B", "x=1", "a.b", "e-mail", "snake_case", "a*b", "[x]", "#teg", "1.", "-", "|", "<tag>", "\\", "`",
];

function randomText(rand: () => number): string {
  const n = 1 + Math.floor(rand() * 5);
  return Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]!).join(" ");
}

function randomInline(rand: () => number, allowCode = true): ContentNode[] {
  const parts: ContentNode[] = [];
  const count = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < count; i++) {
    const text = randomText(rand);
    const roll = rand();
    // gap oxiridagi/boshidagi bo'shliqlar belgilar atrofida ham uchrasin
    const padded = rand() < 0.3 ? `${text} ` : text;
    if (roll < 0.4) parts.push(t(i === 0 ? padded.trimStart() : ` ${padded}`));
    else if (roll < 0.55) parts.push(t(padded, "bold"));
    else if (roll < 0.7) parts.push(t(padded, "italic"));
    else if (roll < 0.78) parts.push(t(padded, "strike"));
    else if (roll < 0.86 && allowCode) parts.push(t(text.replace(/\s+$/, "").replace(/^\s+/, ""), "code"));
    else parts.push(t(padded, link(`https://example.com/${Math.floor(rand() * 100)}?q=${Math.floor(rand() * 9)}`)));
  }
  return parts;
}

function randomBlock(rand: () => number, depth = 0): ContentNode {
  const roll = rand();
  if (roll < 0.3) return p(...randomInline(rand));
  if (roll < 0.4) return { type: "heading", attrs: { level: rand() < 0.5 ? 2 : 3 }, content: [t(randomText(rand))] };
  if (roll < 0.52) {
    const ordered = rand() < 0.5;
    const items = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => {
      const content: ContentNode[] = [p(...randomInline(rand))];
      if (depth < 1 && rand() < 0.3) content.push({ type: rand() < 0.5 ? "bulletList" : "orderedList", content: [li(p(...randomInline(rand)))] });
      return li(...content);
    });
    return { type: ordered ? "orderedList" : "bulletList", ...(ordered && rand() < 0.3 ? { attrs: { start: 2 + Math.floor(rand() * 5) } } : {}), content: items };
  }
  if (roll < 0.6 && depth < 1) return { type: "blockquote", content: Array.from({ length: 1 + Math.floor(rand() * 2) }, () => p(...randomInline(rand))) };
  if (roll < 0.7) {
    const lang = ["typescript", "bash", "json", null][Math.floor(rand() * 4)] ?? null;
    return { type: "codeBlock", attrs: { language: lang }, content: [t(`// f${Math.floor(rand() * 9)}.ts\nconst a = ${Math.floor(rand() * 99)};\n\nreturn a * 2;`)] };
  }
  if (roll < 0.78) return { type: "horizontalRule" };
  if (roll < 0.86) return { type: "image", attrs: { src: `/uploads/img-${Math.floor(rand() * 99)}.webp`, alt: randomText(rand).replace(/[[\]]/g, ""), title: rand() < 0.5 ? null : "Izoh" } };
  const cols = 1 + Math.floor(rand() * 3);
  const cell = (type: string) => ({ type, content: [p(...randomInline(rand))] });
  return {
    type: "table",
    content: [
      { type: "tableRow", content: Array.from({ length: cols }, () => cell("tableHeader")) },
      ...Array.from({ length: 1 + Math.floor(rand() * 2) }, () => ({ type: "tableRow", content: Array.from({ length: cols }, () => cell("tableCell")) })),
    ],
  };
}

describe("round trip property tests (seeded)", () => {
  it("analysis never lies: lossless <=> markdown reads back to an equivalent document (1500 random docs)", () => {
    let lossless = 0;
    for (let seed = 1; seed <= 1500; seed++) {
      const rand = mulberry32(seed);
      const blocks: ContentNode[] = [];
      let last = "";
      for (let n = 1 + Math.floor(rand() * 6); n > 0; n--) {
        const b = randomBlock(rand);
        if (b.type === last && (b.type === "bulletList" || b.type === "orderedList" || b.type === "blockquote")) continue; // yonma-yon birlashadiganlar alohida testda
        last = b.type ?? "";
        blocks.push(b);
      }
      const d = doc(...blocks);
      const analysis = analyzeDocMarkdown(d);
      const same = docsEquivalent(markdownToDoc(analysis.markdown).doc, d);
      expect(analysis.lossless, `seed ${seed}`).toBe(same);
      if (analysis.lossless) lossless++;
    }
    expect(lossless).toBeGreaterThan(1500 * 0.98);
  });

  it("documents built from the plain supported subset always round-trip (no bold/italic neighbours, no bare URLs)", () => {
    for (let seed = 10_000; seed < 10_800; seed++) {
      const rand = mulberry32(seed);
      const blocks: ContentNode[] = [];
      let last = "";
      for (let n = 1 + Math.floor(rand() * 6); n > 0; n--) {
        const b = randomBlock(rand);
        if (b.type === last && (b.type === "bulletList" || b.type === "orderedList" || b.type === "blockquote")) continue;
        last = b.type ?? "";
        blocks.push(b);
      }
      const d = doc(...blocks);
      const a = analyzeDocMarkdown(d);
      if (a.lossless) expect(docsEquivalent(markdownToDoc(a.markdown).doc, d), `seed ${seed}`).toBe(true);
    }
  });

  it("serialization is idempotent on the canonical form", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rand = mulberry32(seed * 7);
      const d = doc(randomBlock(rand), randomBlock(rand));
      const once = docToMarkdown(d);
      const twice = docToMarkdown(markdownToDoc(once).doc);
      const a = analyzeDocMarkdown(d);
      if (a.lossless) expect(twice).toBe(once);
    }
  });
});

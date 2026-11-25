import { describe, expect, it } from "vitest";
import { codePointLength, findUrls, fitParts, graphemeLength, normalizeUzbekApostrophes, toHashtag, toHashtags, truncateTo, xWeightedLength } from "./text.js";
import { threadsLength } from "./providers/threads.js";

describe("xWeightedLength", () => {
  it("counts latin as 1 and URLs as 23 regardless of length", () => {
    expect(xWeightedLength("hello")).toBe(5);
    expect(xWeightedLength("https://example.com/a/very/long/path?with=query&and=more")).toBe(23);
    expect(xWeightedLength("see https://example.com/x now")).toBe(4 + 23 + 4);
  });
  it("counts emoji (incl. ZWJ and skin tones) as 2", () => {
    expect(xWeightedLength("😀")).toBe(2);
    expect(xWeightedLength("👨‍👩‍👧")).toBe(2);
    expect(xWeightedLength("👍🏽")).toBe(2);
  });
  it("counts CJK as 2 and Uzbek modifier letters as 1", () => {
    expect(xWeightedLength("日本")).toBe(4);
    expect(xWeightedLength("oʻzbek gʻoya maʼno")).toBe("oʻzbek gʻoya maʼno".length);
  });
  it("normalises to NFC before counting (decomposed é counts as one unit)", () => {
    expect(xWeightedLength("e\u0301")).toBe(1);
    expect(xWeightedLength("\u00e9")).toBe(1);
  });
  it("is at the limit at exactly 280 and over at 281", () => {
    expect(xWeightedLength("a".repeat(280))).toBe(280);
    expect(xWeightedLength("a".repeat(281))).toBe(281);
    expect(xWeightedLength("a".repeat(257) + " https://t.co/xyz")).toBe(257 + 1 + 23);
  });
});

describe("other counters", () => {
  it("counts code points vs graphemes", () => {
    expect(codePointLength("a😀b")).toBe(3);
    expect(graphemeLength("👨‍👩‍👧")).toBe(1);
    expect(codePointLength("👨‍👩‍👧")).toBe(5);
  });
  it("Threads: emoji count as UTF-8 bytes, text as code points", () => {
    expect(threadsLength("abc")).toBe(3);
    expect(threadsLength("😀")).toBe(4);
    expect(threadsLength("oʻzbek")).toBe(6);
  });
  it("finds URLs without trailing punctuation", () => {
    expect(findUrls("go to https://a.uz/x, then (https://b.uz/y).").map((u) => u.url)).toEqual(["https://a.uz/x", "https://b.uz/y"]);
  });
});

describe("Uzbek apostrophes", () => {
  it("normalises o'/g' to ʻ and other apostrophes to ʼ", () => {
    expect(normalizeUzbekApostrophes("o'zbek g‘oya O`zbekiston")).toBe("oʻzbek gʻoya Oʻzbekiston");
    expect(normalizeUzbekApostrophes("ma'no sa’at")).toBe("maʼno saʼat");
  });
  it("leaves quotes around words and English contractions out of scope safely", () => {
    expect(normalizeUzbekApostrophes("'hello' world")).toBe("'hello' world");
  });
});

describe("hashtags", () => {
  it("builds CamelCase tags and strips Uzbek apostrophes", () => {
    expect(toHashtag("node-js")).toBe("#NodeJs");
    expect(toHashtag("o'zbek")).toBe("#Ozbek");
    expect(toHashtag("oʻzbek tili")).toBe("#OzbekTili");
    expect(toHashtag("123")).toBeNull();
    expect(toHashtag("!!!")).toBeNull();
  });
  it("dedupes and limits", () => {
    expect(toHashtags(["a1", "A1", "b", "c"], 2)).toEqual(["#A1", "#B"]);
  });
});

describe("fitting", () => {
  it("drops optional parts from the end, then truncates the title, never the required URL", () => {
    const url = "https://abdusoft.uz/p";
    const parts = { title: "T".repeat(300), optional: [{ key: "e", text: "excerpt" }], required: url };
    const out = fitParts(parts, 280, xWeightedLength);
    expect(xWeightedLength(out)).toBeLessThanOrEqual(280);
    expect(out.endsWith(url)).toBe(true);
    expect(out).toContain("…");
    expect(out).not.toContain("excerpt");
  });
  it("keeps everything when it fits", () => {
    const out = fitParts({ title: "A", optional: [{ key: "e", text: "B" }, { key: "t", text: "#C" }] }, 100, codePointLength);
    expect(out).toBe("A\n\nB\n\n#C");
  });
  it("truncateTo never cuts inside a URL", () => {
    const text = "see https://example.com/" + "p".repeat(60) + " tail";
    const out = truncateTo(text, 40, codePointLength);
    expect(out).toBe("see…");
    expect(truncateTo("short", 40, codePointLength)).toBe("short");
  });
  it("truncateTo respects grapheme boundaries", () => {
    const out = truncateTo("😀😀😀😀", 3, codePointLength);
    expect(codePointLength(out)).toBeLessThanOrEqual(3);
    expect(out).toBe("😀😀…");
  });
});

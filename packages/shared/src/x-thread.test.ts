import { describe, expect, it } from "vitest";
import { xWeightedLength } from "./distribution.js";
import { X_THREAD_MAX_PARTS, hasThreadSeparator, splitThreadSegments, splitXThread } from "./x-thread.js";

const URL = "https://abdusoft.uz/blog/juda-uzun-maqola-nomi-2026";
const sentence = (n: number) => `Bu ${n}-gap bo'lib, ancha uzun matn.`;
const longText = (n: number) => Array.from({ length: n }, (_, i) => sentence(i + 1)).join(" ");

describe("splitThreadSegments", () => {
  it("splits on ---only lines, trims, drops empties", () => {
    expect(splitThreadSegments("a\n---\n  b  \n\n---\n---\n c")).toEqual(["a", "b", "c"]);
    expect(splitThreadSegments("---\nx\n---")).toEqual(["x"]);
    expect(splitThreadSegments("a\r\n---\r\nb")).toEqual(["a", "b"]);
  });
  it("does not treat inline or longer dashes as separators", () => {
    expect(splitThreadSegments("a --- b")).toEqual(["a --- b"]);
    expect(splitThreadSegments("a\n----\nb")).toEqual(["a\n----\nb"]);
    expect(splitThreadSegments("a\n--- x\nb")).toEqual(["a\n--- x\nb"]);
  });
  it("hasThreadSeparator", () => {
    expect(hasThreadSeparator("a\n---\nb")).toBe(true);
    expect(hasThreadSeparator("a --- b")).toBe(false);
  });
});

describe("splitXThread", () => {
  it("empty text -> no parts", () => {
    const r = splitXThread("  \n---\n ");
    expect(r.count).toBe(0);
    expect(r.parts).toEqual([]);
  });

  it("short text -> one part, never numbered", () => {
    const r = splitXThread("Salom dunyo", { numbering: true });
    expect(r.parts.map((p) => p.text)).toEqual(["Salom dunyo"]);
    expect(r.numbered).toBe(false);
  });

  it("explicit separators give one tweet each", () => {
    const r = splitXThread("Birinchi\n---\nIkkinchi\n---\nUchinchi");
    expect(r.parts.map((p) => p.text)).toEqual(["Birinchi", "Ikkinchi", "Uchinchi"]);
    expect(r.anyOver).toBe(false);
  });

  it("auto-splits an over-long part so every part fits", () => {
    const r = splitXThread(longText(30));
    expect(r.count).toBeGreaterThan(2);
    for (const p of r.parts) {
      expect(p.weight).toBeLessThanOrEqual(280);
      expect(p.over).toBe(false);
    }
  });

  it("auto-split loses no words and keeps order", () => {
    const text = longText(25);
    const r = splitXThread(text);
    expect(r.parts.map((p) => p.text).join(" ").split(/\s+/)).toEqual(text.split(/\s+/));
  });

  it("prefers sentence boundaries", () => {
    const r = splitXThread(longText(12));
    for (const p of r.parts.slice(0, -1)) expect(p.text.endsWith(".")).toBe(true);
  });

  it("prefers paragraph boundaries over sentence ends", () => {
    const para1 = longText(5);
    const para2 = longText(5);
    const r = splitXThread(`${para1}\n\n${para2}`);
    expect(r.parts[0]!.text).toBe(para1);
  });

  it("never splits inside a URL and counts it as 23", () => {
    const filler = "so'z ".repeat(50);
    const text = `${filler}${URL} oxiri ${filler}${URL}`;
    const r = splitXThread(text);
    const joined = r.parts.map((p) => p.text).join(" ");
    expect(joined.split(URL).length - 1).toBe(2);
    for (const p of r.parts) {
      expect(p.weight).toBeLessThanOrEqual(280);
      const hits = p.text.match(/https?:\/\/\S+/g) ?? [];
      for (const h of hits) expect(h).toBe(URL);
    }
  });

  it("hard-splits a single giant word on grapheme boundaries (no surrogate/emoji breakage)", () => {
    const giant = "😀👨‍👩‍👧".repeat(200);
    const r = splitXThread(giant);
    expect(r.count).toBeGreaterThan(1);
    for (const p of r.parts) {
      expect(p.weight).toBeLessThanOrEqual(280);
      expect(p.text).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(p.text).not.toMatch(/^[\uDC00-\uDFFF]/);
      expect(p.text.endsWith("‍")).toBe(false);
    }
    expect(r.parts.map((p) => p.text).join("")).toBe(giant);
  });

  it("hard-splits a long unbroken ASCII word", () => {
    const r = splitXThread("a".repeat(700));
    expect(r.parts.map((p) => p.text).join("")).toBe("a".repeat(700));
    expect(r.parts.every((p) => p.weight <= 280)).toBe(true);
  });

  it("numbering adds ' i/n' within budget and counts in weight", () => {
    const r = splitXThread(longText(30), { numbering: true });
    expect(r.numbered).toBe(true);
    r.parts.forEach((p, i) => {
      expect(p.text.endsWith(` ${i + 1}/${r.count}`)).toBe(true);
      expect(p.weight).toBe(xWeightedLength(p.text));
      expect(p.weight).toBeLessThanOrEqual(280);
    });
  });

  it("numbering digits growth (10+ parts) stays within 280", () => {
    const r = splitXThread(longText(90), { numbering: true });
    expect(r.count).toBeGreaterThanOrEqual(10);
    expect(r.parts.every((p) => p.weight <= 280)).toBe(true);
    expect(r.parts[r.count - 1]!.text.endsWith(` ${r.count}/${r.count}`)).toBe(true);
  });

  it("numbered explicit separators", () => {
    const r = splitXThread("A\n---\nB", { numbering: true });
    expect(r.parts.map((p) => p.text)).toEqual(["A 1/2", "B 2/2"]);
  });

  it("text that fits a single tweet is not split just to make room for numbers", () => {
    const text = "x".repeat(279);
    const r = splitXThread(text, { numbering: true });
    expect(r.count).toBe(1);
    expect(r.numbered).toBe(false);
  });

  it("flags too many parts", () => {
    const text = Array.from({ length: X_THREAD_MAX_PARTS + 1 }, (_, i) => `t${i}`).join("\n---\n");
    const r = splitXThread(text);
    expect(r.count).toBe(X_THREAD_MAX_PARTS + 1);
    expect(r.tooMany).toBe(true);
    expect(splitXThread(text, { maxParts: 20 }).tooMany).toBe(false);
  });

  it("is deterministic", () => {
    const t = longText(40);
    expect(splitXThread(t, { numbering: true })).toEqual(splitXThread(t, { numbering: true }));
  });

  it("uses X weighting (CJK = 2)", () => {
    const r = splitXThread("漢".repeat(200));
    expect(r.count).toBe(2);
    expect(r.parts.every((p) => p.weight <= 280)).toBe(true);
  });
});

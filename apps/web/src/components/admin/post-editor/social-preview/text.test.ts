import { describe, expect, it } from "vitest";
import { measureSocialText } from "@blog/shared";
import { INSTAGRAM_COLLAPSE, LINKEDIN_COLLAPSE, buildSegments, collapseCut, domainOf, initialsOf, overflowIndex, parseReadmeBlock, tokenizeSocialText } from "./text";

describe("tokenizeSocialText", () => {
  it("linkifies urls, hashtags and mentions and keeps line breaks", () => {
    const t = tokenizeSocialText("Yangi post https://abdusoft.uz/blog/x.\n#nextjs #Ўзбек @abdusoft!");
    expect(t.map((s) => [s.kind, s.value])).toEqual([
      ["text", "Yangi post "],
      ["url", "https://abdusoft.uz/blog/x"],
      ["text", ".\n"],
      ["hashtag", "#nextjs"],
      ["text", " "],
      ["hashtag", "#Ўзбек"],
      ["text", " "],
      ["mention", "@abdusoft"],
      ["text", "!"],
    ]);
  });

  it("keeps urls as plain text when urls=false (Instagram)", () => {
    const t = tokenizeSocialText("qarang https://abdusoft.uz #tag", { urls: false });
    expect(t.map((s) => s.kind)).toEqual(["text", "hashtag"]);
    expect(t[0]!.value).toBe("qarang https://abdusoft.uz ");
  });

  it("does not treat digits-only, mid-word or email-like tokens as tags/mentions", () => {
    const t = tokenizeSocialText("#123 a#b mail me@x.uz");
    expect(t).toEqual([{ kind: "text", value: "#123 a#b mail me@x.uz" }]);
  });
});

describe("collapseCut", () => {
  it("returns null for short text", () => {
    expect(collapseCut("qisqa\nmatn", LINKEDIN_COLLAPSE)).toBeNull();
  });
  it("cuts after maxLines lines", () => {
    const text = "a\nb\nc\nd\ne";
    expect(text.slice(0, collapseCut(text, LINKEDIN_COLLAPSE)!)).toBe("a\nb\nc");
    expect(text.slice(0, collapseCut(text, INSTAGRAM_COLLAPSE)!)).toBe("a\nb");
  });
  it("cuts near maxChars at a word boundary", () => {
    const text = "so'z ".repeat(60).trim();
    const cut = collapseCut(text, INSTAGRAM_COLLAPSE)!;
    expect(cut).toBeLessThanOrEqual(125);
    expect(cut).toBeGreaterThan(105);
    expect(text[cut]).toBe(" ");
  });
  it("never splits a surrogate pair", () => {
    const text = "😀".repeat(200);
    const cut = collapseCut(text, { maxChars: 10, maxLines: 5 })!;
    expect(cut).toBe(20);
  });
});

describe("overflowIndex", () => {
  it("is null while within the limit", () => {
    expect(overflowIndex("linkedin", "abc", 3)).toBeNull();
    expect(overflowIndex("linkedin", "abc", null)).toBeNull();
  });
  it("splits plain text at the limit", () => {
    expect(overflowIndex("linkedin", "abcdef", 4)).toBe(4);
  });
  it("uses X weighting (emoji = 2, url = 23)", () => {
    const text = "😀😀😀";
    const i = overflowIndex("x", text, 4)!;
    expect(measureSocialText("x", text.slice(0, i))).toBeLessThanOrEqual(4);
    expect(i).toBe(4);
  });
  it("does not split surrogate pairs", () => {
    expect(overflowIndex("linkedin", "a😀😀", 2)).toBe(3);
  });
});

describe("buildSegments", () => {
  it("marks the part after overAt and splits a segment across the boundary", () => {
    const segs = buildSegments("hello #worldwide", { urls: true, overAt: 9 });
    expect(segs.map((s) => [s.kind, s.value, s.over])).toEqual([
      ["text", "hello ", false],
      ["hashtag", "#wo", false],
      ["hashtag", "rldwide", true],
    ]);
  });
  it("drops text after visibleEnd", () => {
    expect(buildSegments("abcdef", { urls: true, visibleEnd: 3 }).map((s) => s.value).join("")).toBe("abc");
  });
});

describe("misc helpers", () => {
  it("initialsOf / domainOf", () => {
    expect(initialsOf("Abduaziz Bobomalikov")).toBe("AB");
    expect(initialsOf("")).toBe("B");
    expect(domainOf("https://www.abdusoft.uz/blog/x")).toBe("abdusoft.uz");
    expect(domainOf("nope")).toBe("");
  });
  it("parseReadmeBlock reads link lines and keeps others as text", () => {
    const l = parseReadmeBlock("- [Post \\[1\\]](https://a.uz/x) — 2026-11-01\nplain");
    expect(l[0]).toEqual({ kind: "link", title: "Post [1]", url: "https://a.uz/x", rest: "— 2026-11-01" });
    expect(l[1]).toMatchObject({ kind: "text", title: "plain" });
  });
});

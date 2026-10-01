import { describe, expect, it } from "vitest";
import { channelDocVisibleLength } from "@blog/shared";
import {
  renderRestrictedDoc,
  telegramHtmlToDoc,
  telegramVisibleLength,
  validateRestrictedDoc,
  validateTelegramHtml,
} from "./channel-html.js";

const t = (text: string, marks?: { type: string; attrs?: Record<string, unknown> }[]) =>
  marks ? { type: "text", text, marks } : { type: "text", text };

describe("renderRestrictedDoc", () => {
  it("renders marks, links (http/https only), blockquote and lists", () => {
    const html = renderRestrictedDoc({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            t("a<b", [{ type: "bold" }]),
            t(" "),
            t("u", [{ type: "underline" }]),
            { type: "hardBreak" },
            t("ok", [{ type: "link", attrs: { href: "https://x.test/?a=1&b=2" } }]),
            t(" bad", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]),
          ],
        },
        { type: "blockquote", content: [{ type: "paragraph", content: [t("iqtibos")] }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [t("bir")] }] }, { type: "listItem", content: [{ type: "paragraph", content: [t("ikki")] }] }] },
        { type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [t("x")] }] }] },
        { type: "paragraph" },
      ],
    });
    expect(html).toBe(
      '<b>a&lt;b</b> <u>u</u>\n<a href="https://x.test/?a=1&amp;b=2">ok</a> bad\n\n<blockquote>iqtibos</blockquote>\n\n• bir\n• ikki\n\n1. x',
    );
    expect(html).not.toContain("javascript");
    expect(validateTelegramHtml(html).ok).toBe(true);
  });

  it("round-trips Telegram HTML through Tiptap (fork)", () => {
    const html = '<b>Sarlavha</b>\n\nMatn <i>kursiv</i> &amp; <a href="https://a.test/x?y=1&amp;z=2">havola</a>\nikkinchi qator\n\n<blockquote>q1\nq2</blockquote>\n\n📖 To\'liq post: <a href="https://b.test/p">Blog</a>\n#teg';
    const doc = telegramHtmlToDoc(html);
    expect(validateRestrictedDoc(doc)).toBeNull();
    expect(renderRestrictedDoc(doc)).toBe(html);
  });
});

describe("validators", () => {
  it("rejects unsupported nodes/marks", () => {
    expect(validateRestrictedDoc({ type: "doc", content: [{ type: "image", attrs: { src: "x" } }] })).toMatch(/image/);
    expect(validateRestrictedDoc({ type: "doc", content: [{ type: "paragraph", content: [t("a", [{ type: "highlight" }])] }] })).toMatch(/highlight/);
    expect(validateRestrictedDoc("x")).not.toBeNull();
  });

  it("validateTelegramHtml: allowed + balanced only", () => {
    expect(validateTelegramHtml("<b>a</b> <code>x</code> <tg-spoiler>s</tg-spoiler>").ok).toBe(true);
    expect(validateTelegramHtml("<h1>a</h1>").ok).toBe(false);
    expect(validateTelegramHtml("<b>a<i>b</b></i>").ok).toBe(false);
    expect(validateTelegramHtml("<b>a").ok).toBe(false);
  });

  it("visible length ignores tags and decodes entities once", () => {
    expect(telegramVisibleLength("<b>a&amp;b</b> &lt;c&gt;")).toBe("a&b <c>".length);
    expect(telegramVisibleLength("&amp;lt;")).toBe(4);
  });
});

describe("channelDocVisibleLength (web hisoblagichi) server bilan bir xil", () => {
  const p = (...c: unknown[]) => ({ type: "paragraph", content: c });
  const li = (text: string) => ({ type: "listItem", content: [p(t(text))] });
  const docs: unknown[] = [
    { type: "doc", content: [] },
    { type: "doc", content: [p(t("salom"))] },
    { type: "doc", content: [p(t("a")), { type: "paragraph" }, p(t("b"))] },
    { type: "doc", content: [p(t("  a  ")), p(t("b & <c>", [{ type: "bold" }]), { type: "hardBreak" }, t("d"))] },
    { type: "doc", content: [p({ type: "hardBreak" }, t("x"), { type: "hardBreak" })] },
    { type: "doc", content: [{ type: "blockquote", content: [p(t("q1")), p(t("q2"))] }, p(t("z"))] },
    { type: "doc", content: [{ type: "bulletList", content: [li("bir"), li("ikki")] }, { type: "orderedList", content: [li("x"), li(" ")] }] },
    { type: "doc", content: [p(t("link", [{ type: "link", attrs: { href: "https://a.test/?a=1&b=2" } }]))] },
    { type: "doc", content: [p(t("&amp;lt;"))] },
  ];
  it.each(docs.map((d, i) => [i, d] as const))("doc #%i", (_i, doc) => {
    expect(channelDocVisibleLength(doc)).toBe(telegramVisibleLength(renderRestrictedDoc(doc)));
  });
});

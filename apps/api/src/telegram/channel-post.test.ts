import { describe, expect, it } from "vitest";
import { buildChannelPost, CHANNEL_CAPTION_LIMIT, CHANNEL_TEXT_LIMIT } from "./channel-post.js";

function doc(content: unknown[]) {
  return { type: "doc", content };
}

function paragraph(content: unknown[]) {
  return { type: "paragraph", content };
}

function text(value: string, marks?: { type: string; attrs?: Record<string, unknown> }[]) {
  return marks ? { type: "text", text: value, marks } : { type: "text", text: value };
}

const BASE_PARAMS = {
  siteUrl: "https://blog.test",
  telegraphUrl: "https://telegra.ph/mock-page-1",
  limit: CHANNEL_TEXT_LIMIT,
};

describe("buildChannelPost", () => {
  it("converts inline marks (bold/italic/strike/code/link) and escapes special chars", () => {
    const result = buildChannelPost({
      post: {
        title: "A & B <test>",
        slug: "a-b-test",
        contentJson: doc([
          paragraph([
            text("qalin", [{ type: "bold" }]),
            text(" "),
            text("kursiv", [{ type: "italic" }]),
            text(" "),
            text("chizilgan", [{ type: "strike" }]),
            text(" "),
            text("kod", [{ type: "code" }]),
            text(" "),
            text("havola", [{ type: "link", attrs: { href: "https://example.com" } }]),
            text(" <script> & tags"),
          ]),
        ]),
        tags: [],
      },
      ...BASE_PARAMS,
    });

    expect(result.html).toContain("<b>A &amp; B &lt;test&gt;</b>");
    expect(result.html).toContain("<b>qalin</b>");
    expect(result.html).toContain("<i>kursiv</i>");
    expect(result.html).toContain("<s>chizilgan</s>");
    expect(result.html).toContain("<code>kod</code>");
    expect(result.html).toContain('<a href="https://example.com">havola</a>');
    expect(result.html).toContain("&lt;script&gt; &amp; tags");
    expect(result.truncated).toBe(false);
  });

  it("only wraps http(s) links, drops non-http schemes", () => {
    const result = buildChannelPost({
      post: {
        title: "T",
        slug: "t",
        contentJson: doc([
          paragraph([text("bad", [{ type: "link", attrs: { href: "javascript:alert(1)" } }])]),
        ]),
      },
      ...BASE_PARAMS,
      telegraphUrl: null,
    });
    // Footer'dagi "Blog saytida" havolasi bundan mustasno — faqat inline "bad" matni atrofida <a> bo'lmasligi tekshiriladi.
    expect(result.html).not.toContain("<a href=\"javascript:alert(1)\">bad</a>");
    expect(result.html).toContain("bad");
  });

  it("converts headings, bullet lists, ordered lists and blockquotes; skips codeBlock/table/image/hr", () => {
    const result = buildChannelPost({
      post: {
        title: "Sarlavha",
        slug: "s",
        contentJson: doc([
          { type: "heading", attrs: { level: 2 }, content: [text("Bo'lim")] },
          { type: "bulletList", content: [
            { type: "listItem", content: [paragraph([text("birinchi")])] },
            { type: "listItem", content: [paragraph([text("ikkinchi")])] },
          ] },
          { type: "orderedList", content: [
            { type: "listItem", content: [paragraph([text("bir")])] },
            { type: "listItem", content: [paragraph([text("ikki")])] },
          ] },
          { type: "blockquote", content: [paragraph([text("ℹ️ eslatma matni")])] },
          { type: "codeBlock", content: [text("const x = 1;")] },
          { type: "table", content: [] },
          { type: "image", attrs: { src: "https://x.test/a.png" } },
          { type: "horizontalRule" },
        ]),
      },
      ...BASE_PARAMS,
    });

    expect(result.html).toContain("<b>Bo'lim</b>");
    expect(result.html).toContain("• birinchi");
    expect(result.html).toContain("• ikkinchi");
    expect(result.html).toContain("1. bir");
    expect(result.html).toContain("2. ikki");
    expect(result.html).toContain("<blockquote>ℹ️ eslatma matni</blockquote>");
    expect(result.html).not.toContain("const x = 1;");
    expect(result.html).not.toContain("<table");
    expect(result.html).not.toContain("a.png");
    expect(result.html).not.toContain("<hr");
  });

  it("fills whole blocks while they fit, never cutting a block mid-way", () => {
    const bigBlock = "X".repeat(400);
    const blocks = Array.from({ length: 20 }, (_, i) => paragraph([text(`${bigBlock}-${i}`)]));
    const result = buildChannelPost({
      post: { title: "Long post", slug: "long", contentJson: doc(blocks), tags: ["ai", "llm"] },
      siteUrl: "https://blog.test",
      telegraphUrl: "https://telegra.ph/mock",
      limit: CHANNEL_TEXT_LIMIT,
    });

    expect(result.truncated).toBe(true);
    expect(result.visibleLength).toBeLessThanOrEqual(CHANNEL_TEXT_LIMIT - 100);
    // Har bir saqlangan blok TO'LIQ holda bor — yarmigacha kesilmagan.
    for (let i = 0; i < 20; i++) {
      const marker = `${bigBlock}-${i}`;
      if (result.html.includes(bigBlock.slice(0, 50) + `-${i}`)) {
        expect(result.html).toContain(marker);
      }
    }
    expect(result.html).toContain("Davomini o'qing");
    expect(result.html).toContain("#ai #llm");
  });

  it("cuts the first block at a sentence boundary with an ellipsis when it alone doesn't fit", () => {
    const sentence = "Bu birinchi gap. Bu ikkinchi gap. ";
    const hugeText = sentence.repeat(400); // yagona, juda uzun paragraf — sig'maydi
    const result = buildChannelPost({
      post: { title: "T", slug: "t", contentJson: doc([paragraph([text(hugeText)])]) },
      ...BASE_PARAMS,
    });

    expect(result.truncated).toBe(true);
    expect(result.html).toContain("…");
    expect(result.visibleLength).toBeLessThanOrEqual(CHANNEL_TEXT_LIMIT - 100);
  });

  it("footer variant: everything fits -> 'To'liq post', omits Telegraph link when telegraphUrl is null", () => {
    const result = buildChannelPost({
      post: { title: "Qisqa", slug: "qisqa", contentJson: doc([paragraph([text("kichik matn")])]) },
      siteUrl: "https://blog.test",
      telegraphUrl: null,
      limit: CHANNEL_TEXT_LIMIT,
    });
    expect(result.truncated).toBe(false);
    expect(result.html).toContain("To'liq post:");
    expect(result.html).not.toContain("Telegraph'da");
    expect(result.html).toContain('<a href="https://blog.test/qisqa">Blog saytida</a>');
  });

  it("footer variant: truncated -> 'Davomini o'qing' with both links when telegraphUrl set", () => {
    const bigBlock = "Y".repeat(5000);
    const result = buildChannelPost({
      post: { title: "T", slug: "t", contentJson: doc([paragraph([text(bigBlock)])]) },
      ...BASE_PARAMS,
    });
    expect(result.truncated).toBe(true);
    expect(result.html).toContain("Davomini o'qing:");
    expect(result.html).toContain("Blog saytida");
    expect(result.html).toContain("Telegraph'da");
  });

  it("respects the 1024 caption limit vs 4096 text limit", () => {
    const bigBlock = "Z".repeat(2000);
    const textResult = buildChannelPost({
      post: { title: "T", slug: "t", contentJson: doc([paragraph([text(bigBlock)])]) },
      siteUrl: "https://blog.test",
      telegraphUrl: null,
      limit: CHANNEL_TEXT_LIMIT,
    });
    const captionResult = buildChannelPost({
      post: { title: "T", slug: "t", contentJson: doc([paragraph([text(bigBlock)])]) },
      siteUrl: "https://blog.test",
      telegraphUrl: null,
      limit: CHANNEL_CAPTION_LIMIT,
    });

    expect(textResult.visibleLength).toBeLessThanOrEqual(CHANNEL_TEXT_LIMIT - 100);
    expect(captionResult.visibleLength).toBeLessThanOrEqual(CHANNEL_CAPTION_LIMIT - 100);
    expect(captionResult.visibleLength).toBeLessThan(textResult.visibleLength);
  });

  it("renders tag hashtags line", () => {
    const result = buildChannelPost({
      post: {
        title: "T",
        slug: "t",
        contentJson: doc([paragraph([text("matn")])]),
        tags: ["Sun'iy Intellekt", "LLM"],
      },
      ...BASE_PARAMS,
    });
    expect(result.html).toMatch(/#sun.*intellekt #llm/i);
  });

  it("drops headings whose section content is skipped (table) or that end the document", () => {
    const heading = (t: string) => ({ type: "heading", attrs: { level: 2 }, content: [text(t)] });
    const result = buildChannelPost({
      post: {
        title: "T",
        slug: "t",
        contentJson: doc([
          heading("Jadval bo'limi"),
          { type: "table", content: [] },
          heading("Matnli bo'lim"),
          paragraph([text("Bu matn chiqadi.")]),
          heading("Oxirgi sarlavha"),
        ]),
        tags: [],
      },
      ...BASE_PARAMS,
    });
    expect(result.html).not.toContain("Jadval bo'limi");
    expect(result.html).not.toContain("Oxirgi sarlavha");
    expect(result.html).toContain("<b>Matnli bo'lim</b>");
    expect(result.html).toContain("Bu matn chiqadi.");
  });

  it("never leaves a heading as the last kept block when truncating", () => {
    const heading = (t: string) => ({ type: "heading", attrs: { level: 2 }, content: [text(t)] });
    const long = "Uzun gap. ".repeat(60);
    const result = buildChannelPost({
      post: {
        title: "T",
        slug: "t",
        contentJson: doc([paragraph([text(long)]), heading("Keyingi bo'lim"), paragraph([text(long)])]),
        tags: [],
      },
      ...BASE_PARAMS,
      limit: CHANNEL_CAPTION_LIMIT,
    });
    expect(result.truncated).toBe(true);
    expect(result.html).not.toContain("Keyingi bo'lim");
  });

  it("produces no hashtag line when there are no tags", () => {
    const result = buildChannelPost({
      post: { title: "T", slug: "t", contentJson: doc([paragraph([text("matn")])]), tags: [] },
      ...BASE_PARAMS,
    });
    expect(result.html).not.toMatch(/\n#/);
  });
});

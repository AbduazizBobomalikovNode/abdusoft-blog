import { describe, expect, it } from "vitest";
import { buildChannelPost, CHANNEL_CAPTION_LIMIT, CHANNEL_TEXT_LIMIT, MAX_CHANNEL_MEDIA } from "./channel-post.js";

function doc(content: unknown[]) {
  return { type: "doc", content };
}

function paragraph(content: unknown[]) {
  return { type: "paragraph", content };
}

function text(value: string, marks?: { type: string; attrs?: Record<string, unknown> }[]) {
  return marks ? { type: "text", text: value, marks } : { type: "text", text: value };
}

function image(src: string, alt?: string) {
  return { type: "image", attrs: { src, ...(alt ? { alt } : {}) } };
}

const BASE_PARAMS = {
  siteUrl: "https://blog.test",
  telegraphUrl: "https://telegra.ph/mock-page-1",
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
      mode: "text",
      variant: "l",
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
      mode: "text",
      variant: "l",
    });
    // Footer'dagi "Blog saytida" havolasi bundan mustasno — faqat inline "bad" matni atrofida <a> bo'lmasligi tekshiriladi.
    expect(result.html).not.toContain('<a href="javascript:alert(1)">bad</a>');
    expect(result.html).toContain("bad");
  });

  it("converts headings, bullet lists, ordered lists and blockquotes; skips codeBlock/table/image/hr from text (media mode also collects the image)", () => {
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
          image("https://x.test/a.png"),
          { type: "horizontalRule" },
        ]),
      },
      ...BASE_PARAMS,
      mode: "media",
      variant: "l",
    });

    expect(result.html).toContain("<b>Bo'lim</b>");
    expect(result.html).toContain("• birinchi");
    expect(result.html).toContain("• ikkinchi");
    expect(result.html).toContain("1. bir");
    expect(result.html).toContain("2. ikki");
    expect(result.html).toContain("<blockquote>ℹ️ eslatma matni</blockquote>");
    expect(result.html).not.toContain("const x = 1;");
    expect(result.html).not.toContain("<table");
    expect(result.html).not.toContain("<hr");
    // Rasm caption matniga chiqmaydi, lekin alohida `images` ro'yxatida bo'ladi (media rejim).
    expect(result.images.map((i) => i.url)).toContain("https://x.test/a.png");
  });

  it("throws on an invalid mode/variant combination", () => {
    expect(() =>
      buildChannelPost({
        post: { title: "T", slug: "t", contentJson: doc([paragraph([text("matn")])]) },
        ...BASE_PARAMS,
        mode: "media",
        variant: "s",
      }),
    ).toThrow();
    expect(() =>
      buildChannelPost({
        post: { title: "T", slug: "t", contentJson: doc([paragraph([text("matn")])]) },
        ...BASE_PARAMS,
        mode: "media",
        variant: "xl",
      }),
    ).toThrow();
  });

  it("text mode never collects images, even when the doc has them", () => {
    const result = buildChannelPost({
      post: {
        title: "T",
        slug: "t",
        coverUrl: "https://x.test/cover.png",
        contentJson: doc([
          paragraph([text("Kirish matni.")]),
          image("https://x.test/1.png"),
          paragraph([text("Davomi.")]),
        ]),
      },
      ...BASE_PARAMS,
      mode: "text",
      variant: "l",
    });
    expect(result.images).toEqual([]);
  });

  it("budgets per mode: media m < l <= CHANNEL_CAPTION_LIMIT on a long doc", () => {
    const bigBlock = "Uzun gap keladi. ".repeat(9);
    const blocks = Array.from({ length: 20 }, (_, i) => paragraph([text(`${bigBlock}-${i}`)]));
    const input = {
      post: { title: "Long post", slug: "long", contentJson: doc(blocks), tags: ["ai", "llm"] },
      siteUrl: "https://blog.test",
      telegraphUrl: "https://telegra.ph/mock",
    };

    const m = buildChannelPost({ ...input, mode: "media", variant: "m" });
    const l = buildChannelPost({ ...input, mode: "media", variant: "l" });

    for (const r of [m, l]) {
      expect(r.truncated).toBe(true);
      expect(r.visibleLength).toBeLessThanOrEqual(CHANNEL_CAPTION_LIMIT);
      expect(r.html).toContain("Davomini o'qing");
      expect(r.html).toContain("#ai #llm");
    }
    expect(m.visibleLength).toBeLessThan(l.visibleLength);
    expect(l.limit).toBeLessThanOrEqual(CHANNEL_CAPTION_LIMIT);
  });

  it("budgets per mode: text s < m < l < xl <= CHANNEL_TEXT_LIMIT on a long doc", () => {
    const bigBlock = "Uzun gap keladi. ".repeat(9);
    const blocks = Array.from({ length: 60 }, (_, i) => paragraph([text(`${bigBlock}-${i}`)]));
    const input = {
      post: { title: "Long post", slug: "long", contentJson: doc(blocks), tags: ["ai", "llm"] },
      siteUrl: "https://blog.test",
      telegraphUrl: "https://telegra.ph/mock",
    };

    const s = buildChannelPost({ ...input, mode: "text", variant: "s" });
    const m = buildChannelPost({ ...input, mode: "text", variant: "m" });
    const l = buildChannelPost({ ...input, mode: "text", variant: "l" });
    const xl = buildChannelPost({ ...input, mode: "text", variant: "xl" });

    for (const r of [s, m, l, xl]) {
      expect(r.truncated).toBe(true);
      expect(r.visibleLength).toBeLessThanOrEqual(CHANNEL_TEXT_LIMIT);
      expect(r.html).toContain("Davomini o'qing");
      expect(r.html).toContain("#ai #llm");
      expect(r.images).toEqual([]);
    }
    expect(s.visibleLength).toBeLessThan(m.visibleLength);
    expect(m.visibleLength).toBeLessThan(l.visibleLength);
    expect(l.visibleLength).toBeLessThan(xl.visibleLength);
    expect(xl.limit).toBeLessThanOrEqual(CHANNEL_TEXT_LIMIT);
  });

  it("fills whole blocks while they fit, never cutting a block mid-way", () => {
    const bigBlock = "X".repeat(400);
    const blocks = Array.from({ length: 20 }, (_, i) => paragraph([text(`${bigBlock}-${i}`)]));
    const result = buildChannelPost({
      post: { title: "Long post", slug: "long", contentJson: doc(blocks), tags: ["ai", "llm"] },
      siteUrl: "https://blog.test",
      telegraphUrl: "https://telegra.ph/mock",
      mode: "text",
      variant: "l",
    });

    expect(result.truncated).toBe(true);
    expect(result.visibleLength).toBeLessThanOrEqual(CHANNEL_TEXT_LIMIT);
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
      mode: "text",
      variant: "s",
    });

    expect(result.truncated).toBe(true);
    expect(result.html).toContain("…");
    expect(result.visibleLength).toBeLessThanOrEqual(CHANNEL_TEXT_LIMIT);
  });

  it("footer variant: everything fits -> 'To'liq post', omits Telegraph link when telegraphUrl is null", () => {
    const result = buildChannelPost({
      post: { title: "Qisqa", slug: "qisqa", contentJson: doc([paragraph([text("kichik matn")])]) },
      siteUrl: "https://blog.test",
      telegraphUrl: null,
      mode: "text",
      variant: "l",
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
      mode: "text",
      variant: "l",
    });
    expect(result.truncated).toBe(true);
    expect(result.html).toContain("Davomini o'qing:");
    expect(result.html).toContain("Blog saytida");
    expect(result.html).toContain("Telegraph'da");
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
      mode: "text",
      variant: "l",
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
      mode: "text",
      variant: "l",
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
      mode: "text",
      variant: "s",
    });
    expect(result.truncated).toBe(true);
    expect(result.html).not.toContain("Keyingi bo'lim");
  });

  it("produces no hashtag line when there are no tags", () => {
    const result = buildChannelPost({
      post: { title: "T", slug: "t", contentJson: doc([paragraph([text("matn")])]), tags: [] },
      ...BASE_PARAMS,
      mode: "text",
      variant: "l",
    });
    expect(result.html).not.toMatch(/\n#/);
  });

  describe("image range selection (media mode)", () => {
    it("includes images located within the range of included blocks, in document order", () => {
      const result = buildChannelPost({
        post: {
          title: "T",
          slug: "t",
          contentJson: doc([
            paragraph([text("Kirish matni.")]),
            image("https://x.test/1.png", "birinchi"),
            paragraph([text("Ikkinchi paragraf.")]),
            image("https://x.test/2.png"),
          ]),
        },
        ...BASE_PARAMS,
        mode: "media",
        variant: "l",
      });
      expect(result.truncated).toBe(false);
      expect(result.images).toEqual([
        { url: "https://x.test/1.png", alt: "birinchi" },
        { url: "https://x.test/2.png", alt: null },
      ]);
    });

    it("excludes images that fall after the last included block when truncated", () => {
      const long = "Juda uzun matn keladi bu yerda. ".repeat(60);
      const result = buildChannelPost({
        post: {
          title: "T",
          slug: "t",
          contentJson: doc([
            image("https://x.test/before.png"),
            paragraph([text(long)]),
            image("https://x.test/after.png"),
          ]),
        },
        ...BASE_PARAMS,
        mode: "media",
        variant: "m",
      });
      expect(result.truncated).toBe(true);
      expect(result.images.map((i) => i.url)).toContain("https://x.test/before.png");
      expect(result.images.map((i) => i.url)).not.toContain("https://x.test/after.png");
    });

    it("never duplicates the cover image and deduplicates repeated image URLs", () => {
      const result = buildChannelPost({
        post: {
          title: "T",
          slug: "t",
          coverUrl: "https://x.test/cover.png",
          contentJson: doc([
            image("https://x.test/cover.png"),
            paragraph([text("matn")]),
            image("https://x.test/unique.png"),
            image("https://x.test/unique.png"),
          ]),
        },
        ...BASE_PARAMS,
        mode: "media",
        variant: "l",
      });
      expect(result.images.map((i) => i.url)).toEqual(["https://x.test/unique.png"]);
    });

    it("caps included images so cover + images never exceeds MAX_CHANNEL_MEDIA", () => {
      const images = Array.from({ length: 15 }, (_, i) => image(`https://x.test/${i}.png`));
      const result = buildChannelPost({
        post: {
          title: "T",
          slug: "t",
          contentJson: doc([paragraph([text("matn")]), ...images]),
        },
        ...BASE_PARAMS,
        mode: "media",
        variant: "l",
      });
      expect(result.images.length).toBeLessThanOrEqual(MAX_CHANNEL_MEDIA - 1);
    });
  });

  it("fills long lists item by item so the text variants differ", () => {
    const heading = { type: "heading", attrs: { level: 2 }, content: [text("Raqamlar")] };
    const bullet = (t: string) => ({ type: "listItem", content: [paragraph([text(t)])] });
    const longItem = (n: number) => `Band ${n}: ` + "juda muhim fakt va uning izohi. ".repeat(8);
    const contentJson = doc([
      paragraph([text("Kirish abzasi. Bu post nima haqida ekanini aytadi.")]),
      heading,
      { type: "bulletList", content: Array.from({ length: 16 }, (_, i) => i + 1).map((n) => bullet(longItem(n))) },
    ]);
    const build = (variant: "s" | "m" | "l") =>
      buildChannelPost({ post: { title: "T", slug: "t", contentJson, tags: [] }, ...BASE_PARAMS, mode: "text", variant });
    const s = build("s");
    const m = build("m");
    const l = build("l");
    expect(s.visibleLength).toBeLessThan(m.visibleLength);
    expect(m.visibleLength).toBeLessThan(l.visibleLength);
    expect(l.visibleLength).toBeLessThanOrEqual(CHANNEL_TEXT_LIMIT);
    expect(l.html).toContain("<b>Raqamlar</b>");
    expect(l.html).toContain("• Band 1:");
    // list items stay whole and are separated by single newlines
    expect(l.html).toMatch(/• Band 1:[^\n]*\n• Band 2:/);
    expect(l.truncated).toBe(true);
  });
});

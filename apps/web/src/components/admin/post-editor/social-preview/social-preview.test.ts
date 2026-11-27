import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { splitXThread } from "@blog/shared";
import { SocialPreview, type SocialPreviewModel } from ".";

const base: SocialPreviewModel = {
  provider: "linkedin",
  text: "Yangi maqola https://abdusoft.uz/blog/x #nextjs @abdusoft",
  limit: 3000,
  authorName: "Abduaziz",
  authorHandle: "@abdusoft",
  postUrl: "https://abdusoft.uz/blog/x",
  postTitle: "Maqola sarlavhasi",
  imageUrl: "https://abdusoft.uz/cover.jpg",
  linkMode: "article",
};
const render = (over: Partial<SocialPreviewModel>) => renderToStaticMarkup(createElement(SocialPreview, { model: { ...base, ...over } }));
const long = "Birinchi qator uzun matn. ".repeat(20);

describe("SocialPreview", () => {
  it("LinkedIn article mode shows the link card with title and domain", () => {
    const html = render({});
    expect(html).toContain("social-preview-linkedin");
    expect(html).toContain("social-link-card");
    expect(html).toContain("Maqola sarlavhasi");
    expect(html).toContain("abdusoft.uz");
    expect(html).toContain("#nextjs");
  });

  it("LinkedIn text mode has no link card but still shows the image", () => {
    const html = render({ linkMode: "text" });
    expect(html).not.toContain("social-link-card");
    expect(html).toContain("cover.jpg");
  });

  it("LinkedIn collapses long text with a see-more control", () => {
    const html = render({ text: long });
    expect(html).toContain("social-see-more");
    expect(html).toContain("ko&#x27;proq");
  });

  it("X shows the image, or a link card without one", () => {
    expect(render({ provider: "x", limit: 280 })).toContain("social-x-image");
    const noImage = render({ provider: "x", limit: 280, imageUrl: null });
    expect(noImage).not.toContain("social-x-image");
    expect(noImage).toContain("social-link-card");
  });

  it("X marks overflow and shows the notice", () => {
    const html = render({ provider: "x", limit: 20, text: "a".repeat(30) });
    expect(html).toContain("data-over");
    expect(html).toContain("social-over-notice");
    expect(html).toContain("10 birlik");
  });

  it("Threads renders full text (no see-more) and falls back to a link card", () => {
    const html = render({ provider: "threads", limit: 500, text: long, imageUrl: null });
    expect(html).toContain("social-preview-threads");
    expect(html).not.toContain("social-see-more");
    expect(html).toContain("social-link-card");
  });

  it("Instagram keeps urls as plain text, collapses captions and warns without an image", () => {
    const html = render({ provider: "instagram", limit: 2200, imageUrl: null, text: `${long} https://abdusoft.uz/x #tag` });
    expect(html).toContain("social-ig-no-image");
    expect(html).toContain("social-see-more");
    const short = render({ provider: "instagram", limit: 2200, text: "qarang https://abdusoft.uz/x #tag" });
    expect(short).not.toContain("text-sky-600 dark:text-sky-400\">https://");
    expect(short).toContain("#tag");
    expect(short).not.toContain("social-ig-no-image");
  });

  it("GitHub renders the markdown list", () => {
    const html = render({ provider: "github", limit: null, text: "- [Birinchi](https://abdusoft.uz/a) — 2026-11-01\n- [Ikkinchi](https://abdusoft.uz/b)" });
    expect(html).toContain("social-github-list");
    expect(html).toContain("Birinchi");
    expect(html).toContain("README.md");
    expect(html).not.toContain("BLOG-POSTS:START");
  });

  it("shows an empty-text placeholder", () => {
    expect(render({ text: "" })).toContain("Matn bo&#x27;sh");
  });

  it("X thread renders stacked tweets with connectors and per-part weights; no single-tweet over notice", () => {
    const thread = splitXThread("Birinchi tvit\n---\nIkkinchi tvit\n---\nUchinchi", { numbering: true });
    const html = render({ provider: "x", text: "Birinchi tvit\n---\nIkkinchi tvit\n---\nUchinchi", limit: 280, thread });
    expect(html).toContain("social-x-thread");
    expect(html.match(/social-x-thread-part/g)).toHaveLength(3);
    expect(html.match(/social-x-thread-connector/g)).toHaveLength(2);
    expect(html).toContain("Birinchi tvit 1/3");
    expect(html).toContain("3/3 · ");
    expect(html).not.toContain("social-over-notice");
    // rasm faqat birinchi tvitda
    expect(html.match(/social-x-image/g)).toHaveLength(1);
  });

  it("X without thread keeps the single-tweet card", () => {
    const html = render({ provider: "x", text: "Oddiy", limit: 280, thread: null });
    expect(html).not.toContain("social-x-thread");
    expect(html).toContain("social-preview-x");
  });
});

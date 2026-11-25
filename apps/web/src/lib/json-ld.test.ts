import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  OG_IMAGE_ROUTE_SUFFIX,
  buildBlogPostingJsonLd,
  buildHomeJsonLd,
  ogImageUrl,
  serializeJsonLd,
  type JsonLdPost,
} from "./json-ld";

const site = { name: "abdusoft", url: "https://blog.example.test" };

const tag = (name: string) => ({ id: name, slug: name, name, description: null, color: null });

const post: JsonLdPost = {
  slug: "salom-dunyo",
  title: "Salom, dunyo",
  excerpt: "Qisqa tavsif",
  publishedAt: "2026-05-01T10:00:00.000Z",
  tags: [tag("AI"), tag("Node.js")],
};

describe("OG_IMAGE_ROUTE_SUFFIX", () => {
  it("matches the suffix Next.js derives for app/(site)/[slug]/opengraph-image", () => {
    const require = createRequire(import.meta.url);
    const { djb2Hash } = require("next/dist/shared/lib/hash") as { djb2Hash: (s: string) => number };
    expect(djb2Hash("/(site)/[slug]").toString(36).slice(0, 6)).toBe(OG_IMAGE_ROUTE_SUFFIX);
  });
});

describe("buildBlogPostingJsonLd", () => {
  it("fills every required field from the post", () => {
    const data = buildBlogPostingJsonLd(post, site);
    expect(data).toMatchObject({
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: "Salom, dunyo",
      description: "Qisqa tavsif",
      datePublished: "2026-05-01T10:00:00.000Z",
      dateModified: "2026-05-01T10:00:00.000Z",
      url: "https://blog.example.test/salom-dunyo",
      mainEntityOfPage: { "@type": "WebPage", "@id": "https://blog.example.test/salom-dunyo" },
      inLanguage: "uz",
      keywords: "AI, Node.js",
      author: { "@type": "Person", name: "abdusoft" },
      image: [ogImageUrl(site, "salom-dunyo")],
    });
    expect(ogImageUrl(site, "salom-dunyo")).toBe(
      `https://blog.example.test/salom-dunyo/opengraph-image-${OG_IMAGE_ROUTE_SUFFIX}`,
    );
  });

  it("falls back to the title-based description like the page metadata does", () => {
    const data = buildBlogPostingJsonLd({ ...post, excerpt: null }, site);
    expect(data.description).toBe("Salom, dunyo — abdusoft");
  });

  it("omits dates and keywords when the post has none", () => {
    const data = buildBlogPostingJsonLd({ ...post, publishedAt: null, tags: [] }, site);
    expect(data).not.toHaveProperty("datePublished");
    expect(data).not.toHaveProperty("dateModified");
    expect(data).not.toHaveProperty("keywords");
  });
});

describe("buildHomeJsonLd", () => {
  it("describes the WebSite and the Blog in one graph", () => {
    const data = buildHomeJsonLd(site, "Tavsif") as { "@graph": Array<Record<string, unknown>> };
    const types = data["@graph"].map((node) => node["@type"]);
    expect(types).toEqual(["WebSite", "Blog"]);
    expect(data["@graph"][1]).toMatchObject({ url: site.url, name: "abdusoft", inLanguage: "uz" });
  });
});

describe("serializeJsonLd", () => {
  it("never lets post content break out of the script tag", () => {
    const evil = buildBlogPostingJsonLd(
      { ...post, title: `</script><script>alert(1)</script>`, excerpt: "a <!-- b & c   d" },
      site,
    );
    const out = serializeJsonLd(evil);
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).not.toContain(" ");
  });

  it("stays valid JSON that round-trips to the original data", () => {
    const evil = buildBlogPostingJsonLd({ ...post, title: `</script> & "quoted"` }, site);
    expect(JSON.parse(serializeJsonLd(evil))).toEqual(evil);
  });
});

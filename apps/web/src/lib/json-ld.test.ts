import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  OG_IMAGE_ROUTE_SUFFIX,
  buildBlogPostingJsonLd,
  buildHomeJsonLd,
  buildVideoObjectJsonLd,
  isoDuration,
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

describe("buildVideoObjectJsonLd", () => {
  const video = { url: "https://cdn.example.test/v.mp4", width: 1920, height: 1080, seconds: 57.6 };

  it("fills the VideoObject fields from the post and the video", () => {
    expect(buildVideoObjectJsonLd(post, video, "https://cdn.example.test/cover.jpg", site)).toEqual({
      "@context": "https://schema.org",
      "@type": "VideoObject",
      name: "Salom, dunyo",
      description: "Qisqa tavsif",
      thumbnailUrl: "https://cdn.example.test/cover.jpg",
      duration: "PT58S",
      contentUrl: "https://cdn.example.test/v.mp4",
      width: 1920,
      height: 1080,
      url: "https://blog.example.test/salom-dunyo",
      uploadDate: "2026-05-01T10:00:00.000Z",
    });
  });

  it("falls back to title + site name and omits uploadDate when the post has none", () => {
    const data = buildVideoObjectJsonLd({ ...post, excerpt: null, publishedAt: null }, video, "https://x.test/t.jpg", site);
    expect(data.description).toBe("Salom, dunyo — abdusoft");
    expect(data).not.toHaveProperty("uploadDate");
  });

  it("is escaped by serializeJsonLd so a hostile title cannot close the script tag", () => {
    const out = serializeJsonLd(buildVideoObjectJsonLd({ ...post, title: "</script><script>alert(1)</script>" }, video, "https://x.test/t.jpg", site));
    expect(out).not.toContain("</script>");
    expect(JSON.parse(out).name).toBe("</script><script>alert(1)</script>");
  });
});

describe("isoDuration", () => {
  it("formats seconds as ISO 8601", () => {
    expect(isoDuration(58)).toBe("PT58S");
    expect(isoDuration(57.6)).toBe("PT58S");
    expect(isoDuration(60)).toBe("PT1M");
    expect(isoDuration(65)).toBe("PT1M5S");
    expect(isoDuration(3723)).toBe("PT1H2M3S");
    expect(isoDuration(3600)).toBe("PT1H");
  });
  it("never returns an empty or invalid duration", () => {
    expect(isoDuration(0)).toBe("PT1S");
    expect(isoDuration(Number.NaN)).toBe("PT1S");
    expect(isoDuration(-5)).toBe("PT1S");
  });
});

import type { PostDetail } from "@blog/shared";

/**
 * Next.js `app/(site)/[slug]/opengraph-image.tsx` marshrutiga qo'shadigan hash qo'shimchasi.
 * Route group (`(site)`) bor dinamik segmentlarda Next u'ni `djb2Hash("/(site)/[slug]")`dan
 * hosil qiladi (`/<slug>/opengraph-image-<hash>`). `json-ld.test.ts` shu qiymat Next'ning
 * hisoblashi bilan mos ekanini tekshiradi — papka ko'chirilsa test yiqiladi.
 */
export const OG_IMAGE_ROUTE_SUFFIX = "19c4ir";

export interface JsonLdSite {
  name: string;
  /** Oxirida `/`siz absolyut manzil, masalan `https://blog.abdusoft.uz`. */
  url: string;
}

export type JsonLdPost = Pick<PostDetail, "slug" | "title" | "excerpt" | "publishedAt" | "tags">;

/** Post uchun OG rasm marshrutining absolyut manzili. */
export function ogImageUrl(site: JsonLdSite, slug: string): string {
  return `${site.url}/${encodeURIComponent(slug)}/opengraph-image-${OG_IMAGE_ROUTE_SUFFIX}`;
}

/**
 * JSON-LD'ni `<script type="application/ld+json">` ichiga xavfsiz joylash uchun
 * serialize qiladi. `<` (va `>`, `&`, U+2028/2029) escape qilinadi, shuning uchun
 * post matnidagi `</script>` skript tegidan chiqib keta olmaydi. Natija baribir
 * to'g'ri JSON bo'lib qoladi (`<` JSON ichida `<` ga teng).
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Post sahifasi uchun `BlogPosting` (schema.org). Maydonlar sahifaning o'z ma'lumotidan olinadi. */
export function buildBlogPostingJsonLd(post: JsonLdPost, site: JsonLdSite): Record<string, unknown> {
  const url = `${site.url}/${post.slug}`;
  const description = post.excerpt ?? `${post.title} — ${site.name}`;

  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description,
    url,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    inLanguage: "uz",
    author: { "@type": "Person", name: site.name, url: site.url },
    publisher: { "@type": "Organization", name: site.name, url: site.url },
    image: [ogImageUrl(site, post.slug)],
  };

  if (post.publishedAt) {
    data.datePublished = post.publishedAt;
    // API hozircha alohida "yangilangan" vaqtini bermaydi — chop etilgan vaqt ishlatiladi.
    data.dateModified = post.publishedAt;
  }

  if (post.tags.length > 0) {
    data.keywords = post.tags.map((tag) => tag.name).join(", ");
  }

  return data;
}

/** Bosh sahifa uchun `WebSite` + `Blog` (bitta `@graph`da). */
export function buildHomeJsonLd(site: JsonLdSite, description: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${site.url}/#website`,
        name: site.name,
        url: site.url,
        description,
        inLanguage: "uz",
        potentialAction: {
          "@type": "SearchAction",
          target: { "@type": "EntryPoint", urlTemplate: `${site.url}/qidiruv?q={search_term_string}` },
          "query-input": "required name=search_term_string",
        },
      },
      {
        "@type": "Blog",
        "@id": `${site.url}/#blog`,
        name: site.name,
        url: site.url,
        description,
        inLanguage: "uz",
        isPartOf: { "@id": `${site.url}/#website` },
        author: { "@type": "Person", name: site.name, url: site.url },
      },
    ],
  };
}

import { getFeed } from "@/lib/api";
import { site } from "@/lib/site";
import { escapeCdata, escapeXml } from "@/lib/xml";

export const revalidate = 300;

export async function GET() {
  const feed = await getFeed();

  const items = feed.items
    .map((post) => {
      const url = `${site.url}/${post.slug}`;
      const pubDate = post.publishedAt ? new Date(post.publishedAt).toUTCString() : "";

      return `<item>
  <title>${escapeXml(post.title)}</title>
  <link>${escapeXml(url)}</link>
  <guid isPermaLink="true">${escapeXml(url)}</guid>
  ${pubDate ? `<pubDate>${pubDate}</pubDate>` : ""}
  ${post.excerpt ? `<description>${escapeXml(post.excerpt)}</description>` : ""}
  <content:encoded><![CDATA[${escapeCdata(post.html)}]]></content:encoded>
  ${post.tags.map((tag) => `<category>${escapeXml(tag.name)}</category>`).join("\n  ")}
</item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>${escapeXml(site.name)}</title>
  <link>${escapeXml(site.url)}</link>
  <atom:link href="${escapeXml(site.url)}/rss.xml" rel="self" type="application/rss+xml" />
  <description>${escapeXml(`${site.name} — IT, sun'iy intellekt va dasturlash haqida blog.`)}</description>
  <language>uz</language>
  ${items}
</channel>
</rss>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
    },
  });
}

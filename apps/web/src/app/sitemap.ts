import type { MetadataRoute } from "next";
import { getPosts, getTags } from "@/lib/api";
import { site } from "@/lib/site";

export const revalidate = 60;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [posts, tags] = await Promise.all([
    getPosts({ limit: 50 }),
    getTags(),
  ]);

  const staticEntries: MetadataRoute.Sitemap = [
    { url: site.url, changeFrequency: "daily", priority: 1 },
    { url: `${site.url}/teglar`, changeFrequency: "weekly", priority: 0.5 },
    { url: `${site.url}/haqida`, changeFrequency: "monthly", priority: 0.3 },
  ];

  const postEntries: MetadataRoute.Sitemap = (posts?.items ?? []).map((post) => ({
    url: `${site.url}/${post.slug}`,
    lastModified: post.publishedAt ?? undefined,
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  const tagEntries: MetadataRoute.Sitemap = tags.map((tag) => ({
    url: `${site.url}/teglar/${tag.slug}`,
    changeFrequency: "weekly",
    priority: 0.4,
  }));

  return [...staticEntries, ...postEntries, ...tagEntries];
}

import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { config } from "../../../config.js";
import { db } from "../../../db/index.js";
import { posts } from "../../../db/schema.js";
import { tagsForPostIds } from "../../../routes/posts.js";
import type { DistributionPost } from "../types.js";

export interface LoadedPost {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  coverUrl: string | null;
  status: string;
  deletedAt: Date | null;
  publishedAt: Date | null;
  updatedAt: Date;
  tags: string[];
  /** Maqolaning ommaviy manzili (veb-origin/slug). */
  url: string;
}

export function publicPostUrl(slug: string): string {
  return `${config.WEB_ORIGIN.replace(/\/+$/, "")}/${encodeURIComponent(slug)}`;
}

export function toDistributionPost(p: Pick<LoadedPost, "title" | "excerpt" | "url" | "tags" | "publishedAt">): DistributionPost {
  return { title: p.title, excerpt: p.excerpt, url: p.url, tags: p.tags, publishedAt: p.publishedAt };
}

export async function loadPostForDistribution(id: string): Promise<LoadedPost | null> {
  const [row] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
  if (!row) return null;
  const tags = (await tagsForPostIds([row.id])).get(row.id) ?? [];
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    coverUrl: row.coverUrl,
    status: row.status,
    deletedAt: row.deletedAt,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
    tags: tags.map((t) => t.name),
    url: publicPostUrl(row.slug),
  };
}

/** GitHub README bloki uchun: so'nggi chop etilgan postlar (yangisi birinchi). */
export async function latestPublishedPosts(limit: number): Promise<DistributionPost[]> {
  const rows = await db
    .select()
    .from(posts)
    .where(and(eq(posts.status, "published"), isNull(posts.deletedAt), isNotNull(posts.publishedAt)))
    .orderBy(desc(posts.publishedAt))
    .limit(limit);
  const tagMap = await tagsForPostIds(rows.map((r) => r.id));
  return rows.map((row) => ({
    title: row.title,
    excerpt: row.excerpt,
    url: publicPostUrl(row.slug),
    tags: (tagMap.get(row.id) ?? []).map((t) => t.name),
    publishedAt: row.publishedAt,
  }));
}

import { Hono } from "hono";
import { and, asc, desc, eq, gt, ilike, inArray, lt, ne, or, sql } from "drizzle-orm";
import { isbot } from "isbot";
import { z } from "zod";
import { DEFAULT_POST_SETTINGS, PostSettingsSchema, type PostListItem, type Tag } from "@blog/shared";
import { db } from "../db/index.js";
import { posts, postTags, postViewDedupe, postViewsDaily, tags, telegramRefs } from "../db/schema.js";
import { getDevice } from "../lib/device.js";
import { escapeLike } from "../lib/like.js";
import { checkRateLimit } from "../lib/rate-limit.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
/** websearch_to_tsquery ba'zan juda qisqa so'zlarni e'tiborsiz qoldiradi — shu uzunlikdan kalta so'zlar uchun ILIKE fallback ishlatiladi. */
const SHORT_QUERY_LENGTH = 3;
const RELATED_LIMIT = 3;
const FEED_LIMIT = 30;
const VIEW_RATE_LIMIT = 30;
const VIEW_RATE_WINDOW_MS = 60 * 1000;
/** Ikkilamchi IP-asosli limit — qurilma cookie'sini har safar yangilab (yoki bloklab) device-limitni
 * chetlab o'tishga urinishning oldini oladi (bitta IP'dan ko'p "yangi qurilma"). */
const VIEW_IP_RATE_LIMIT = 60;

/** UTC kun — `post_views_daily`/`post_view_dedupe` shu kalendar kuniga yoziladi (server mahalliy vaqt zonasidan qat'i nazar). */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

const ListQuerySchema = z.object({
  tag: z.string().trim().min(1).optional(),
  q: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

export const postSelectColumns = {
  id: posts.id,
  slug: posts.slug,
  title: posts.title,
  excerpt: posts.excerpt,
  publishedAt: posts.publishedAt,
  readingTime: posts.readingTime,
  pinned: posts.pinned,
  viewsCount: posts.viewsCount,
  likesCount: posts.likesCount,
  dislikesCount: posts.dislikesCount,
  commentsCount: posts.commentsCount,
} as const;

type PostRow = {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  publishedAt: Date | null;
  readingTime: number | null;
  pinned: boolean;
  viewsCount: number;
  likesCount: number;
  dislikesCount: number;
  commentsCount: number;
};

function toListItem(row: PostRow, tagMap: Map<string, Tag[]>): PostListItem {
  return {
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    readingTime: row.readingTime,
    pinned: row.pinned,
    tags: tagMap.get(row.id) ?? [],
    counts: {
      views: row.viewsCount,
      likes: row.likesCount,
      dislikes: row.dislikesCount,
      comments: row.commentsCount,
    },
  };
}

export async function tagsForPostIds(postIds: string[]): Promise<Map<string, Tag[]>> {
  const map = new Map<string, Tag[]>();
  if (postIds.length === 0) return map;

  const rows = await db
    .select({
      postId: postTags.postId,
      id: tags.id,
      slug: tags.slug,
      name: tags.name,
      description: tags.description,
      color: tags.color,
    })
    .from(postTags)
    .innerJoin(tags, eq(postTags.tagId, tags.id))
    .where(inArray(postTags.postId, postIds));

  for (const row of rows) {
    const list = map.get(row.postId) ?? [];
    list.push({
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      color: row.color,
    });
    map.set(row.postId, list);
  }

  return map;
}

export const postsRoute = new Hono()
  .get("/", async (c) => {
    const parsed = ListQuerySchema.safeParse({
      tag: c.req.query("tag"),
      q: c.req.query("q"),
      page: c.req.query("page"),
      limit: c.req.query("limit"),
    });

    if (!parsed.success) {
      return c.json({ error: "Invalid query" }, 400);
    }

    const { tag, q, page, limit } = parsed.data;
    const offset = (page - 1) * limit;

    const conditions = [eq(posts.status, "published")];

    if (tag) {
      conditions.push(
        inArray(
          posts.id,
          db
            .select({ id: postTags.postId })
            .from(postTags)
            .innerJoin(tags, eq(postTags.tagId, tags.id))
            .where(eq(tags.slug, tag)),
        ),
      );
    }

    if (q) {
      if (q.length < SHORT_QUERY_LENGTH) {
        const like = `%${escapeLike(q)}%`;
        conditions.push(or(ilike(posts.title, like), ilike(posts.contentText, like))!);
      } else {
        conditions.push(
          sql`to_tsvector('simple', coalesce(${posts.title}, '') || ' ' || coalesce(${posts.contentText}, '')) @@ websearch_to_tsquery('simple', ${q})`,
        );
      }
    }

    const whereClause = and(...conditions);

    const [rows, countRows] = await Promise.all([
      db
        .select(postSelectColumns)
        .from(posts)
        .where(whereClause)
        .orderBy(desc(posts.pinned), desc(posts.publishedAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(posts).where(whereClause),
    ]);

    const total = countRows[0]?.count ?? 0;
    const tagMap = await tagsForPostIds(rows.map((row) => row.id));

    return c.json({
      items: rows.map((row) => toListItem(row, tagMap)),
      page,
      limit,
      total,
      hasMore: page * limit < total,
    });
  })
  .get("/feed", async (c) => {
    const rows = await db
      .select({
        id: posts.id,
        slug: posts.slug,
        title: posts.title,
        excerpt: posts.excerpt,
        html: posts.contentHtml,
        publishedAt: posts.publishedAt,
      })
      .from(posts)
      .where(eq(posts.status, "published"))
      .orderBy(desc(posts.publishedAt))
      .limit(FEED_LIMIT);

    const tagMap = await tagsForPostIds(rows.map((row) => row.id));

    return c.json({
      items: rows.map((row) => ({
        slug: row.slug,
        title: row.title,
        excerpt: row.excerpt,
        html: row.html,
        publishedAt: row.publishedAt?.toISOString() ?? null,
        tags: tagMap.get(row.id) ?? [],
      })),
    });
  })
  .post("/:slug/view", async (c) => {
    const slug = c.req.param("slug");

    const [post] = await db
      .select({ id: posts.id, viewsCount: posts.viewsCount })
      .from(posts)
      .where(and(eq(posts.slug, slug), eq(posts.status, "published")))
      .limit(1);

    if (!post) return c.json({ error: "Topilmadi" }, 404);

    const ua = c.req.header("user-agent") ?? "";
    if (isbot(ua)) {
      return c.json({ counted: false, views: post.viewsCount });
    }

    const device = getDevice(c);
    if (!checkRateLimit(`view:${device.deviceHash}`, VIEW_RATE_LIMIT, VIEW_RATE_WINDOW_MS)) {
      return c.json({ counted: false, views: post.viewsCount });
    }
    if (!checkRateLimit(`view:ip:${device.ipHash}`, VIEW_IP_RATE_LIMIT, VIEW_RATE_WINDOW_MS)) {
      return c.json({ counted: false, views: post.viewsCount });
    }

    const day = todayUtc();

    const result = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(postViewDedupe)
        .values({ postId: post.id, deviceHash: device.deviceHash, day })
        .onConflictDoNothing()
        .returning();

      const counted = inserted.length > 0;

      if (counted) {
        await tx
          .insert(postViewsDaily)
          .values({ postId: post.id, day, views: 1 })
          .onConflictDoUpdate({
            target: [postViewsDaily.postId, postViewsDaily.day],
            set: { views: sql`${postViewsDaily.views} + 1` },
          });

        await tx
          .update(posts)
          .set({ viewsCount: sql`${posts.viewsCount} + 1` })
          .where(eq(posts.id, post.id));
      }

      const [fresh] = await tx.select({ views: posts.viewsCount }).from(posts).where(eq(posts.id, post.id)).limit(1);

      return { counted, views: fresh?.views ?? post.viewsCount };
    });

    return c.json(result);
  })
  .get("/:slug/stats", async (c) => {
    const slug = c.req.param("slug");

    const [post] = await db
      .select({
        viewsCount: posts.viewsCount,
        likesCount: posts.likesCount,
        dislikesCount: posts.dislikesCount,
        commentsCount: posts.commentsCount,
        tgCommentsCount: posts.tgCommentsCount,
      })
      .from(posts)
      .where(and(eq(posts.slug, slug), eq(posts.status, "published")))
      .limit(1);

    if (!post) return c.json({ error: "Topilmadi" }, 404);

    return c.json({
      views: post.viewsCount,
      likes: post.likesCount,
      dislikes: post.dislikesCount,
      comments: post.commentsCount,
      tgComments: post.tgCommentsCount,
    });
  })
  .get("/:slug", async (c) => {
    const slug = c.req.param("slug");

    const [post] = await db
      .select()
      .from(posts)
      .where(and(eq(posts.slug, slug), eq(posts.status, "published")))
      .limit(1);

    if (!post) {
      return c.json({ error: "Not found" }, 404);
    }

    const tagMap = await tagsForPostIds([post.id]);
    const currentTags = tagMap.get(post.id) ?? [];
    const settings = PostSettingsSchema.parse({
      ...DEFAULT_POST_SETTINGS,
      ...((post.settings as Record<string, unknown>) ?? {}),
    });

    let prev: { slug: string; title: string } | null = null;
    let next: { slug: string; title: string } | null = null;

    if (post.publishedAt) {
      const [prevRow] = await db
        .select({ slug: posts.slug, title: posts.title })
        .from(posts)
        .where(and(eq(posts.status, "published"), lt(posts.publishedAt, post.publishedAt)))
        .orderBy(desc(posts.publishedAt))
        .limit(1);
      prev = prevRow ?? null;

      const [nextRow] = await db
        .select({ slug: posts.slug, title: posts.title })
        .from(posts)
        .where(and(eq(posts.status, "published"), gt(posts.publishedAt, post.publishedAt)))
        .orderBy(asc(posts.publishedAt))
        .limit(1);
      next = nextRow ?? null;
    }

    let related: PostListItem[] = [];
    const currentTagIds = currentTags.map((t) => t.id);

    if (currentTagIds.length > 0) {
      const relatedRows = await db
        .select(postSelectColumns)
        .from(posts)
        .where(
          and(
            eq(posts.status, "published"),
            ne(posts.id, post.id),
            inArray(
              posts.id,
              db
                .select({ id: postTags.postId })
                .from(postTags)
                .where(inArray(postTags.tagId, currentTagIds)),
            ),
          ),
        )
        .orderBy(desc(posts.publishedAt))
        .limit(RELATED_LIMIT);

      const relatedTagMap = await tagsForPostIds(relatedRows.map((row) => row.id));
      related = relatedRows.map((row) => toListItem(row, relatedTagMap));
    }

    const [telegramRef] = await db
      .select({ telegraphUrl: telegramRefs.telegraphUrl })
      .from(telegramRefs)
      .where(eq(telegramRefs.postId, post.id))
      .limit(1);

    return c.json({
      slug: post.slug,
      title: post.title,
      excerpt: post.excerpt,
      html: post.contentHtml,
      toc: post.toc,
      coverUrl: post.coverUrl,
      publishedAt: post.publishedAt?.toISOString() ?? null,
      readingTime: post.readingTime,
      pinned: post.pinned,
      tags: currentTags,
      settings,
      counts: {
        views: post.viewsCount,
        likes: post.likesCount,
        dislikes: post.dislikesCount,
        comments: post.commentsCount,
        tgComments: post.tgCommentsCount,
      },
      adjacent: { prev, next },
      related,
      telegraphUrl: telegramRef?.telegraphUrl ?? null,
    });
  });

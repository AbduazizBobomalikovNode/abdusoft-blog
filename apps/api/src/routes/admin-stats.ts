import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { StatsRangeSchema } from "@blog/shared";
import { db } from "../db/index.js";
import { posts } from "../db/schema.js";
import { requireAdmin } from "../lib/require-admin.js";
import {
  pendingCommentsCount,
  previousRange,
  publishedPostsCount,
  recentCommentsFor,
  resolveAllRangeWindow,
  resolveRange,
  seriesForRange,
  topPostsForRange,
  totalsForRange,
  type RangeWindow,
} from "../lib/stats.js";
import { fetchUmamiStats } from "../lib/umami.js";

const OVERVIEW_TOP_POSTS_LIMIT = 10;
const OVERVIEW_RECENT_COMMENTS_LIMIT = 8;
const POST_RECENT_COMMENTS_LIMIT = 8;
const SUMMARY_TOP_POSTS_LIMIT = 3;

function parseRange(raw: string | undefined): "7d" | "30d" | "90d" | "all" {
  const parsed = StatsRangeSchema.safeParse(raw ?? "7d");
  return parsed.success ? parsed.data : "7d";
}

/** `range=all` uchun `post_views_daily`dagi eng qadimgi kundan boshlab haqiqiy oynani aniqlaydi. */
async function windowFor(range: "7d" | "30d" | "90d" | "all", postId: string | null): Promise<RangeWindow> {
  const window = resolveRange(range);
  if (range !== "all") return window;
  return resolveAllRangeWindow(postId, window.endDay);
}

export const adminStatsRoute = new Hono()
  .use("*", requireAdmin)
  .get("/overview", async (c) => {
    const range = parseRange(c.req.query("range"));
    const window = await windowFor(range, null);
    const prevWindow = previousRange(window);

    const [totals, previousTotals, series, topPosts, recentComments, pendingComments, published] =
      await Promise.all([
        totalsForRange(null, window),
        prevWindow ? totalsForRange(null, prevWindow) : Promise.resolve(null),
        seriesForRange(null, window),
        topPostsForRange(window, OVERVIEW_TOP_POSTS_LIMIT),
        recentCommentsFor(null, OVERVIEW_RECENT_COMMENTS_LIMIT),
        pendingCommentsCount(null),
        publishedPostsCount(),
      ]);

    return c.json({
      range,
      totals: { ...totals, publishedPosts: published },
      previousTotals,
      series,
      topPosts,
      recentComments,
      pendingComments,
    });
  })
  .get("/summary", async (c) => {
    const window7d = resolveRange("7d");
    const todayWindow: RangeWindow = { startDay: window7d.endDay, endDay: window7d.endDay, days: 1 };

    const [todayViews, last7d, last30d, pending, topPosts] = await Promise.all([
      totalsForRange(null, todayWindow),
      totalsForRange(null, window7d),
      totalsForRange(null, resolveRange("30d")),
      pendingCommentsCount(null),
      topPostsForRange(window7d, SUMMARY_TOP_POSTS_LIMIT),
    ]);

    return c.json({
      today: { views: todayViews.views },
      last7d,
      last30d,
      pendingComments: pending,
      topPosts: topPosts.map((p) => ({ slug: p.slug, title: p.title, views: p.views })),
    });
  })
  .get("/umami", async (c) => {
    const range = parseRange(c.req.query("range"));
    const data = await fetchUmamiStats(range);
    return c.json(data);
  })
  .get("/posts/:id", async (c) => {
    const id = c.req.param("id");
    const [post] = await db
      .select({ id: posts.id, slug: posts.slug, title: posts.title, status: posts.status, likesCount: posts.likesCount, dislikesCount: posts.dislikesCount, viewsCount: posts.viewsCount, commentsCount: posts.commentsCount })
      .from(posts)
      .where(eq(posts.id, id))
      .limit(1);

    if (!post) return c.json({ error: "Topilmadi" }, 404);

    const range = parseRange(c.req.query("range"));
    const window = await windowFor(range, post.id);
    const prevWindow = previousRange(window);

    const [totals, previousTotals, series, recentComments] = await Promise.all([
      totalsForRange(post.id, window),
      prevWindow ? totalsForRange(post.id, prevWindow) : Promise.resolve(null),
      seriesForRange(post.id, window),
      recentCommentsFor(post.id, POST_RECENT_COMMENTS_LIMIT),
    ]);

    return c.json({
      range,
      post: { id: post.id, slug: post.slug, title: post.title, status: post.status },
      totals,
      previousTotals,
      series,
      allTime: {
        views: post.viewsCount,
        likes: post.likesCount,
        dislikes: post.dislikesCount,
        comments: post.commentsCount,
      },
      reactionsSplit: { likes: post.likesCount, dislikes: post.dislikesCount },
      recentComments,
    });
  });

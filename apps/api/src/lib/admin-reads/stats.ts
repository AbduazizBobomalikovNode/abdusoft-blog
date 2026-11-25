import { and, eq, isNull } from "drizzle-orm";
import type { StatsRange } from "@blog/shared";
import { db } from "../../db/index.js";
import { posts } from "../../db/schema.js";
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
} from "../stats.js";

const OVERVIEW_TOP_POSTS_LIMIT = 10;
const OVERVIEW_RECENT_COMMENTS_LIMIT = 8;
const POST_RECENT_COMMENTS_LIMIT = 8;

/** `range=all` uchun `post_views_daily`dagi eng qadimgi kundan boshlab haqiqiy oynani aniqlaydi. */
async function windowFor(range: StatsRange, postId: string | null): Promise<RangeWindow> {
  const window = resolveRange(range);
  if (range !== "all") return window;
  return resolveAllRangeWindow(postId, window.endDay);
}

/** `GET /admin/stats/overview` va MCP `get_site_stats`. */
export async function getStatsOverview(range: StatsRange) {
  const window = await windowFor(range, null);
  const prevWindow = previousRange(window);

  const [totals, previousTotals, series, topPosts, recentComments, pendingComments, published] = await Promise.all([
    totalsForRange(null, window),
    prevWindow ? totalsForRange(null, prevWindow) : Promise.resolve(null),
    seriesForRange(null, window),
    topPostsForRange(window, OVERVIEW_TOP_POSTS_LIMIT),
    recentCommentsFor(null, OVERVIEW_RECENT_COMMENTS_LIMIT),
    pendingCommentsCount(null),
    publishedPostsCount(),
  ]);

  return {
    range,
    totals: { ...totals, publishedPosts: published },
    previousTotals,
    series,
    topPosts,
    recentComments,
    pendingComments,
  };
}

/** `GET /admin/stats/posts/:id` va MCP `get_post_stats`. Chiqindi qutisidagi yoki yo'q post — `null`. */
export async function getPostStatsView(id: string, range: StatsRange) {
  const [post] = await db
    .select({ id: posts.id, slug: posts.slug, title: posts.title, status: posts.status, likesCount: posts.likesCount, dislikesCount: posts.dislikesCount, viewsCount: posts.viewsCount, commentsCount: posts.commentsCount })
    .from(posts)
    .where(and(eq(posts.id, id), isNull(posts.deletedAt)))
    .limit(1);

  if (!post) return null;

  const window = await windowFor(range, post.id);
  const prevWindow = previousRange(window);

  const [totals, previousTotals, series, recentComments] = await Promise.all([
    totalsForRange(post.id, window),
    prevWindow ? totalsForRange(post.id, prevWindow) : Promise.resolve(null),
    seriesForRange(post.id, window),
    recentCommentsFor(post.id, POST_RECENT_COMMENTS_LIMIT),
  ]);

  return {
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
  };
}

import { and, desc, eq, gte, inArray, lt, lte, ne, sql } from "drizzle-orm";
import type { StatsRange, StatsRecentComment, StatsSeriesPoint, StatsTopPost, StatsTotals } from "@blog/shared";
import { db } from "../db/index.js";
import { comments, posts, postViewsDaily, reactions } from "../db/schema.js";

/**
 * Statistika oynasi — kunlar UTC bo'yicha hisoblanadi (`post_views_daily.day`
 * ham UTC sana). `startDay`/`endDay` — `YYYY-MM-DD` (inklyuziv), `days` — oyna
 * uzunligi (`null` — "hammasi", chegarasiz).
 */
export interface RangeWindow {
  startDay: string | null;
  endDay: string;
  days: number | null;
}

function toDayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function startOfDayUtc(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function endOfDayExclusiveUtc(day: string): Date {
  const d = startOfDayUtc(day);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

export function resolveRange(range: StatsRange, today: Date = new Date()): RangeWindow {
  const endDay = toDayString(today);
  if (range === "all") return { startDay: null, endDay, days: null };

  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { startDay: toDayString(start), endDay, days };
}

/** `range=all` uchun `null` — oldingi davr bilan taqqoslash ma'nosiz. */
export function previousRange(window: RangeWindow): RangeWindow | null {
  if (window.days === null || !window.startDay) return null;

  const start = startOfDayUtc(window.startDay);
  const prevEnd = new Date(start);
  prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevStart.getUTCDate() - (window.days - 1));

  return { startDay: toDayString(prevStart), endDay: toDayString(prevEnd), days: window.days };
}

export function enumerateDays(window: RangeWindow): string[] {
  if (!window.startDay) return [window.endDay];
  const out: string[] = [];
  const cur = startOfDayUtc(window.startDay);
  const end = startOfDayUtc(window.endDay);
  while (cur.getTime() <= end.getTime()) {
    out.push(toDayString(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/** `range=all` uchun seriya boshini `post_views_daily`dagi eng qadimgi kundan aniqlaydi. */
export async function resolveAllRangeWindow(postId: string | null, endDay: string): Promise<RangeWindow> {
  const conditions = [];
  if (postId) conditions.push(eq(postViewsDaily.postId, postId));

  const [row] = await db
    .select({ min: sql<string | null>`min(${postViewsDaily.day})` })
    .from(postViewsDaily)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  const startDay = row?.min ?? null;
  return { startDay, endDay, days: null };
}

function dateRangeConditions(
  column: typeof reactions.createdAt | typeof comments.createdAt,
  window: RangeWindow,
) {
  const conditions = [];
  if (window.startDay) conditions.push(gte(column, startOfDayUtc(window.startDay)));
  conditions.push(lt(column, endOfDayExclusiveUtc(window.endDay)));
  return conditions;
}

function reactionConditions(postId: string | null, window: RangeWindow) {
  const conditions = [eq(reactions.targetType, "post" as const), ...dateRangeConditions(reactions.createdAt, window)];
  if (postId) conditions.push(eq(reactions.targetId, postId));
  return conditions;
}

function commentConditions(postId: string | null, window: RangeWindow) {
  const conditions = [ne(comments.status, "deleted" as const), ...dateRangeConditions(comments.createdAt, window)];
  if (postId) conditions.push(eq(comments.postId, postId));
  return conditions;
}

function viewConditions(postId: string | null, window: RangeWindow) {
  const conditions = [];
  if (window.startDay) conditions.push(gte(postViewsDaily.day, window.startDay));
  conditions.push(lte(postViewsDaily.day, window.endDay));
  if (postId) conditions.push(eq(postViewsDaily.postId, postId));
  return conditions;
}

/** Berilgan oyna ichida (butun sayt yoki bitta post uchun) jami ko'rsatkichlar. */
export async function totalsForRange(postId: string | null, window: RangeWindow): Promise<StatsTotals> {
  const [[viewsRow], reactionRows, [commentsRow]] = await Promise.all([
    db
      .select({ views: sql<number>`coalesce(sum(${postViewsDaily.views}), 0)::int` })
      .from(postViewsDaily)
      .where(and(...viewConditions(postId, window))),
    db
      .select({ type: reactions.type, count: sql<number>`count(*)::int` })
      .from(reactions)
      .where(and(...reactionConditions(postId, window)))
      .groupBy(reactions.type),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(comments)
      .where(and(...commentConditions(postId, window))),
  ]);

  let likes = 0;
  let dislikes = 0;
  for (const row of reactionRows) {
    if (row.type === "like") likes = row.count;
    else dislikes = row.count;
  }

  return {
    views: viewsRow?.views ?? 0,
    likes,
    dislikes,
    comments: commentsRow?.count ?? 0,
  };
}

/** Kun bo'yicha vaqt qatori — bo'sh kunlar 0 bilan to'ldiriladi. */
export async function seriesForRange(postId: string | null, window: RangeWindow): Promise<StatsSeriesPoint[]> {
  const days = enumerateDays(window);

  const [viewsRows, reactionRows, commentRows] = await Promise.all([
    db
      .select({ day: postViewsDaily.day, views: sql<number>`sum(${postViewsDaily.views})::int` })
      .from(postViewsDaily)
      .where(and(...viewConditions(postId, window)))
      .groupBy(postViewsDaily.day),
    db
      .select({
        day: sql<string>`to_char(${reactions.createdAt}, 'YYYY-MM-DD')`,
        type: reactions.type,
        count: sql<number>`count(*)::int`,
      })
      .from(reactions)
      .where(and(...reactionConditions(postId, window)))
      .groupBy(sql`to_char(${reactions.createdAt}, 'YYYY-MM-DD')`, reactions.type),
    db
      .select({
        day: sql<string>`to_char(${comments.createdAt}, 'YYYY-MM-DD')`,
        count: sql<number>`count(*)::int`,
      })
      .from(comments)
      .where(and(...commentConditions(postId, window)))
      .groupBy(sql`to_char(${comments.createdAt}, 'YYYY-MM-DD')`),
  ]);

  const viewsMap = new Map(viewsRows.map((r) => [r.day, r.views]));
  const likesMap = new Map<string, number>();
  const dislikesMap = new Map<string, number>();
  for (const r of reactionRows) {
    if (r.type === "like") likesMap.set(r.day, r.count);
    else dislikesMap.set(r.day, r.count);
  }
  const commentsMap = new Map(commentRows.map((r) => [r.day, r.count]));

  return days.map((day) => ({
    day,
    views: viewsMap.get(day) ?? 0,
    likes: likesMap.get(day) ?? 0,
    dislikes: dislikesMap.get(day) ?? 0,
    comments: commentsMap.get(day) ?? 0,
  }));
}

/** Ko'rishlar bo'yicha eng ko'p postlar (`post_views_daily`dan), reaksiya/izoh soni oyna ichida. */
export async function topPostsForRange(window: RangeWindow, limit: number): Promise<StatsTopPost[]> {
  const viewRows = await db
    .select({ postId: postViewsDaily.postId, views: sql<number>`sum(${postViewsDaily.views})::int` })
    .from(postViewsDaily)
    .where(and(...viewConditions(null, window)))
    .groupBy(postViewsDaily.postId)
    .orderBy(desc(sql`sum(${postViewsDaily.views})`))
    .limit(limit);

  if (viewRows.length === 0) return [];

  const postIds = viewRows.map((r) => r.postId);

  const [postRows, reactionRows, commentRows] = await Promise.all([
    db.select({ id: posts.id, slug: posts.slug, title: posts.title }).from(posts).where(inArray(posts.id, postIds)),
    db
      .select({ postId: reactions.targetId, type: reactions.type, count: sql<number>`count(*)::int` })
      .from(reactions)
      .where(
        and(
          eq(reactions.targetType, "post"),
          inArray(reactions.targetId, postIds),
          ...dateRangeConditions(reactions.createdAt, window),
        ),
      )
      .groupBy(reactions.targetId, reactions.type),
    db
      .select({ postId: comments.postId, count: sql<number>`count(*)::int` })
      .from(comments)
      .where(
        and(
          ne(comments.status, "deleted"),
          inArray(comments.postId, postIds),
          ...dateRangeConditions(comments.createdAt, window),
        ),
      )
      .groupBy(comments.postId),
  ]);

  const postMap = new Map(postRows.map((p) => [p.id, p]));
  const likesMap = new Map<string, number>();
  const dislikesMap = new Map<string, number>();
  for (const r of reactionRows) {
    if (r.type === "like") likesMap.set(r.postId, r.count);
    else dislikesMap.set(r.postId, r.count);
  }
  const commentsMap = new Map(commentRows.map((r) => [r.postId, r.count]));

  return viewRows
    .map((r) => {
      const post = postMap.get(r.postId);
      if (!post) return null;
      return {
        id: post.id,
        slug: post.slug,
        title: post.title,
        views: r.views,
        likes: likesMap.get(r.postId) ?? 0,
        dislikes: dislikesMap.get(r.postId) ?? 0,
        comments: commentsMap.get(r.postId) ?? 0,
      };
    })
    .filter((r): r is StatsTopPost => r !== null);
}

/** So'nggi izohlar — post nomi bilan birga (dashboard uchun). */
export async function recentCommentsFor(postId: string | null, limit: number): Promise<StatsRecentComment[]> {
  const conditions = [ne(comments.status, "deleted" as const)];
  if (postId) conditions.push(eq(comments.postId, postId));

  const rows = await db
    .select({
      id: comments.id,
      postId: comments.postId,
      postSlug: posts.slug,
      postTitle: posts.title,
      authorName: comments.authorName,
      body: comments.body,
      status: comments.status,
      createdAt: comments.createdAt,
      source: comments.source,
    })
    .from(comments)
    .innerJoin(posts, eq(comments.postId, posts.id))
    .where(and(...conditions))
    .orderBy(desc(comments.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function pendingCommentsCount(postId: string | null): Promise<number> {
  const conditions = [eq(comments.status, "pending" as const)];
  if (postId) conditions.push(eq(comments.postId, postId));

  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(comments).where(and(...conditions));
  return row?.count ?? 0;
}

export async function publishedPostsCount(): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(posts).where(eq(posts.status, "published"));
  return row?.count ?? 0;
}

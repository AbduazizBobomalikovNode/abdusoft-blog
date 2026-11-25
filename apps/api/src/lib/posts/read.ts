import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { AdminPostStatus, PostListItem, Tag } from "@blog/shared";
import { db } from "../../db/index.js";
import { postTags, posts } from "../../db/schema.js";
import { postSelectColumns, tagsForPostIds } from "../../routes/posts.js";
import { escapeLike } from "../like.js";
import { getTelegramRefForPost } from "../../telegram/publish.js";
import { resolveChannelChoice } from "../../telegram/channel-choice.js";
import {
  authorNamesForIds,
  checkCanView,
  loadPost,
  parseStoredPlan,
  resolveSettings,
  type PostRow,
  toAuthorRef,
} from "./shared.js";
import { fail, ok, type Actor, type ServiceResult } from "./types.js";

const SHORT_QUERY_LENGTH = 3;
const RELATED_LIMIT = 3;
const RECENT_MINE_LIMIT = 8;

export const adminPostSelectColumns = {
  ...postSelectColumns,
  status: posts.status,
  scheduledAt: posts.scheduledAt,
  channelPlan: posts.channelPlan,
  updatedAt: posts.updatedAt,
  createdBy: posts.createdBy,
  reviewNote: posts.reviewNote,
  channelChoice: posts.channelChoice,
};

type AdminPostRow = {
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
  status: AdminPostStatus;
  scheduledAt: Date | null;
  channelPlan: unknown;
  updatedAt: Date;
  createdBy: string | null;
  reviewNote: string | null;
  channelChoice: unknown;
};

export function toAdminListItem(row: AdminPostRow, tagMap: Map<string, Tag[]>, authorMap: Map<string, string | null>) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    hasChannelPlan: row.status === "scheduled" && row.channelPlan != null,
    hasChannelChoice: row.channelChoice != null,
    updatedAt: row.updatedAt.toISOString(),
    pinned: row.pinned,
    tags: tagMap.get(row.id) ?? [],
    counts: {
      views: row.viewsCount,
      likes: row.likesCount,
      dislikes: row.dislikesCount,
      comments: row.commentsCount,
    },
    createdBy: toAuthorRef(row.createdBy, authorMap),
    reviewNote: row.reviewNote,
  };
}

async function computeTotals(ownerId?: string): Promise<Record<"all" | AdminPostStatus, number>> {
  const rows = await db
    .select({ status: posts.status, count: sql<number>`count(*)::int` })
    .from(posts)
    .where(ownerId ? and(eq(posts.createdBy, ownerId), isNull(posts.deletedAt)) : isNull(posts.deletedAt))
    .groupBy(posts.status);

  const totals = {
    all: 0,
    draft: 0,
    in_review: 0,
    changes_requested: 0,
    scheduled: 0,
    published: 0,
    archived: 0,
  };
  for (const row of rows) {
    totals[row.status] = row.count;
    totals.all += row.count;
  }
  return totals;
}

export interface ListPostsInput {
  status: "all" | AdminPostStatus;
  q?: string;
  page: number;
  limit: number;
}

/** `GET /admin/posts` — xodim FAQAT o'z postlarini ko'radi (bu shart har doim, so'rov parametrlaridan qat'i nazar qo'shiladi). */
export async function listPosts(actor: Actor, input: ListPostsInput) {
  const { status, q, page, limit } = input;
  const offset = (page - 1) * limit;

  const conditions = [isNull(posts.deletedAt)];
  if (status !== "all") {
    conditions.push(eq(posts.status, status));
  }
  if (actor.role === "staff") {
    conditions.push(eq(posts.createdBy, actor.userId ?? ""));
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

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, countRows, totals] = await Promise.all([
    db
      .select(adminPostSelectColumns)
      .from(posts)
      .where(whereClause)
      .orderBy(desc(posts.pinned), desc(posts.updatedAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`count(*)::int` }).from(posts).where(whereClause),
    computeTotals(actor.role === "staff" ? (actor.userId ?? "") : undefined),
  ]);

  const total = countRows[0]?.count ?? 0;
  const tagMap = await tagsForPostIds(rows.map((row) => row.id));
  const authorMap = await authorNamesForIds(rows.map((row) => row.createdBy));

  return {
    items: rows.map((row) => toAdminListItem(row, tagMap, authorMap)),
    page,
    limit,
    total,
    hasMore: page * limit < total,
    totals,
  };
}

/** `GET /admin/posts/mine/summary` — joriy foydalanuvchining o'z postlari. */
export async function mineSummary(actor: Actor) {
  const ownerId = actor.userId ?? "";
  const [totals, recentRows] = await Promise.all([
    computeTotals(ownerId),
    db
      .select(adminPostSelectColumns)
      .from(posts)
      .where(and(eq(posts.createdBy, ownerId), isNull(posts.deletedAt)))
      .orderBy(desc(posts.updatedAt))
      .limit(RECENT_MINE_LIMIT),
  ]);

  const tagMap = await tagsForPostIds(recentRows.map((row) => row.id));
  const authorMap = await authorNamesForIds(recentRows.map((row) => row.createdBy));

  return {
    counts: {
      draft: totals.draft,
      in_review: totals.in_review,
      changes_requested: totals.changes_requested,
      published: totals.published,
      archived: totals.archived,
    },
    recent: recentRows.map((row) => toAdminListItem(row, tagMap, authorMap)),
  };
}

/** Jonli (chiqindi qutisida EMAS) postning id'sini slug bo'yicha topadi — MCP `get_post` kabi slug bilan murojaat qiluvchilar uchun. */
export async function findLivePostIdBySlug(slug: string): Promise<string | null> {
  const [row] = await db.select({ id: posts.id }).from(posts).where(and(eq(posts.slug, slug), isNull(posts.deletedAt))).limit(1);
  return row?.id ?? null;
}

/** `GET /admin/posts/:id`. */
export async function getPostDetail(actor: Actor, id: string): Promise<ServiceResult<PostDetailView>> {
  const post = await loadPost(db, id);
  if (!post) return fail("not_found", "Topilmadi");
  const denied = checkCanView(actor, post);
  if (denied) return denied;

  return ok(await buildDetail(post));
}

type PostDetailView = Awaited<ReturnType<typeof buildDetail>>;

async function buildDetail(post: PostRow) {
  const [tagMap, telegramRef, authorMap] = await Promise.all([
    tagsForPostIds([post.id]),
    getTelegramRefForPost(post.id),
    authorNamesForIds([post.createdBy, post.updatedBy, post.reviewedBy]),
  ]);
  const settings = resolveSettings(post.settings);

  return {
    id: post.id,
    slug: post.slug,
    title: post.title,
    excerpt: post.excerpt,
    contentJson: post.contentJson,
    coverUrl: post.coverUrl,
    status: post.status,
    publishedAt: post.publishedAt?.toISOString() ?? null,
    scheduledAt: post.scheduledAt?.toISOString() ?? null,
    channelPlan: parseStoredPlan(post.channelPlan),
    channelSendAt: post.channelSendAt?.toISOString() ?? null,
    channelChoice: await resolveChannelChoice(post),
    pinned: post.pinned,
    settings,
    tags: tagMap.get(post.id) ?? [],
    readingTime: post.readingTime,
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
    counts: {
      views: post.viewsCount,
      likes: post.likesCount,
      dislikes: post.dislikesCount,
      comments: post.commentsCount,
    },
    telegram: telegramRef
      ? {
          telegraphUrl: telegramRef.telegraphUrl,
          telegraphPath: telegramRef.telegraphPath,
          channelMessageId: telegramRef.channelMessageId,
        }
      : null,
    createdBy: toAuthorRef(post.createdBy, authorMap),
    updatedBy: toAuthorRef(post.updatedBy, authorMap),
    updatedVia: post.updatedVia ?? null,
    reviewNote: post.reviewNote,
    submittedAt: post.submittedAt?.toISOString() ?? null,
    reviewedBy: toAuthorRef(post.reviewedBy, authorMap),
    reviewedAt: post.reviewedAt?.toISOString() ?? null,
  };
}

/** `GET /admin/posts/:id/preview` — admin ko'rinishi (qoralama ham ko'rsatiladi). */
export async function previewPost(actor: Actor, id: string) {
  const post = await loadPost(db, id);
  if (!post) return fail("not_found", "Topilmadi");
  const denied = checkCanView(actor, post);
  if (denied) return denied;

  const tagMap = await tagsForPostIds([post.id]);
  const currentTags = tagMap.get(post.id) ?? [];
  const settings = resolveSettings(post.settings);

  let prev: { slug: string; title: string } | null = null;
  let next: { slug: string; title: string } | null = null;

  if (post.status === "published" && post.publishedAt) {
    const [prevRow] = await db
      .select({ slug: posts.slug, title: posts.title })
      .from(posts)
      .where(and(eq(posts.status, "published"), isNull(posts.deletedAt), lt(posts.publishedAt, post.publishedAt)))
      .orderBy(desc(posts.publishedAt))
      .limit(1);
    prev = prevRow ?? null;

    const [nextRow] = await db
      .select({ slug: posts.slug, title: posts.title })
      .from(posts)
      .where(and(eq(posts.status, "published"), isNull(posts.deletedAt), gt(posts.publishedAt, post.publishedAt)))
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
          isNull(posts.deletedAt),
          ne(posts.id, post.id),
          inArray(
            posts.id,
            db.select({ id: postTags.postId }).from(postTags).where(inArray(postTags.tagId, currentTagIds)),
          ),
        ),
      )
      .orderBy(desc(posts.publishedAt))
      .limit(RELATED_LIMIT);

    const relatedTagMap = await tagsForPostIds(relatedRows.map((row) => row.id));
    related = relatedRows.map((row) => ({
      slug: row.slug,
      title: row.title,
      excerpt: row.excerpt,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      readingTime: row.readingTime,
      pinned: row.pinned,
      tags: relatedTagMap.get(row.id) ?? [],
      counts: {
        views: row.viewsCount,
        likes: row.likesCount,
        dislikes: row.dislikesCount,
        comments: row.commentsCount,
      },
    }));
  }

  return ok({
    slug: post.slug,
    title: post.title,
    excerpt: post.excerpt,
    html: post.contentHtml,
    toc: post.toc,
    coverUrl: post.coverUrl,
    status: post.status,
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
    },
    adjacent: { prev, next },
    related,
  });
}

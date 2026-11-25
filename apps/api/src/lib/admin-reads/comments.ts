import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.js";
import { comments, posts } from "../../db/schema.js";
import { user } from "../../db/auth-schema.js";
import { shortHash } from "../comments.js";
import { isBanAvailable } from "../comments-admin.js";
import { postNotTrashed } from "../posts/live.js";
import { escapeLike } from "../like.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const STATUS_VALUES = ["all", "pending", "visible", "hidden", "deleted"] as const;
const SOURCE_VALUES = ["all", "web", "telegram"] as const;
/** `YYYY-MM-DD` — sana input'idan (`<input type="date">`) keladi. */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const AdminCommentListQuerySchema = z.object({
  status: z.enum(STATUS_VALUES).default("all"),
  source: z.enum(SOURCE_VALUES).default("all"),
  postId: z.string().optional(),
  q: z.string().trim().min(1).optional(),
  from: z.string().regex(DATE_ONLY_RE).optional(),
  to: z.string().regex(DATE_ONLY_RE).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

/** Ota izoh (admin javoblari "Telegramga yuborish" mumkinligini aniqlash uchun). */
const parentComment = alias(comments, "parent_comment");

const adminCommentColumns = {
  id: comments.id,
  postId: comments.postId,
  parentId: comments.parentId,
  authorName: comments.authorName,
  authorUserId: comments.authorUserId,
  body: comments.body,
  bodyHtml: comments.bodyHtml,
  status: comments.status,
  likesCount: comments.likesCount,
  dislikesCount: comments.dislikesCount,
  ipHash: comments.ipHash,
  createdAt: comments.createdAt,
  editedAt: comments.editedAt,
  deletedAt: comments.deletedAt,
  postSlug: posts.slug,
  postTitle: posts.title,
  userImage: user.image,
  userRole: user.role,
  source: comments.source,
  tgUsername: comments.tgUsername,
  tgChatId: comments.tgChatId,
  tgMessageId: comments.tgMessageId,
  tgUserId: comments.tgUserId,
  parentSource: parentComment.source,
  parentTgMessageId: parentComment.tgMessageId,
} as const;

type AdminCommentRow = {
  id: string;
  postId: string;
  parentId: string | null;
  authorName: string;
  authorUserId: string | null;
  body: string;
  bodyHtml: string;
  status: "visible" | "pending" | "hidden" | "deleted";
  likesCount: number;
  dislikesCount: number;
  ipHash: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  postSlug: string;
  postTitle: string;
  userImage: string | null;
  userRole: string | null;
  source: "web" | "telegram";
  tgUsername: string | null;
  tgChatId: number | null;
  tgMessageId: number | null;
  tgUserId: number | null;
  parentSource: "web" | "telegram" | null;
  parentTgMessageId: number | null;
};

/** Guruhdagi (odatda xususiy) izoh xabariga to'g'ridan-to'g'ri ochish havolasi — `t.me/c/<ichki_id>/<message_id>` (a'zo bo'lmagan brauzerda ochilmasligi mumkin, lekin Telegram ilovasida ishlaydi). */
function tgThreadUrlFor(chatId: number | null, messageId: number | null): string | null {
  if (!chatId || !messageId) return null;
  const idStr = String(chatId);
  const internal = idStr.startsWith("-100") ? idStr.slice(4) : idStr.replace(/^-/, "");
  return `https://t.me/c/${internal}/${messageId}`;
}

function toAdminItem(row: AdminCommentRow) {
  return {
    id: row.id,
    postId: row.postId,
    postSlug: row.postSlug,
    postTitle: row.postTitle,
    parentId: row.parentId,
    authorName: row.authorName,
    authorUserId: row.authorUserId,
    authorIsAdmin: row.userRole === "admin",
    authorImage: row.userImage,
    body: row.body,
    bodyHtml: row.bodyHtml,
    status: row.status,
    likes: row.likesCount,
    dislikes: row.dislikesCount,
    ipHashShort: shortHash(row.ipHash),
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    source: row.source,
    tgUsername: row.tgUsername,
    tgThreadUrl: row.source === "telegram" ? tgThreadUrlFor(row.tgChatId, row.tgMessageId) : null,
    canBan: isBanAvailable(row),
    canSendToTelegram:
      row.source === "web" &&
      row.userRole === "admin" &&
      row.status === "visible" &&
      row.parentSource === "telegram" &&
      Boolean(row.parentTgMessageId),
  };
}

async function computeCommentCounts(): Promise<Record<"all" | "pending" | "visible" | "hidden" | "deleted", number>> {
  const rows = await db
    .select({ status: comments.status, count: sql<number>`count(*)::int` })
    .from(comments)
    .where(postNotTrashed(comments.postId))
    .groupBy(comments.status);

  const counts = { all: 0, pending: 0, visible: 0, hidden: 0, deleted: 0 };
  for (const row of rows) {
    counts[row.status] = row.count;
    counts.all += row.count;
  }
  return counts;
}

async function computeSourceCounts(): Promise<{ all: number; web: number; telegram: number }> {
  const rows = await db
    .select({ source: comments.source, count: sql<number>`count(*)::int` })
    .from(comments)
    .where(postNotTrashed(comments.postId))
    .groupBy(comments.source);

  const counts = { all: 0, web: 0, telegram: 0 };
  for (const row of rows) {
    counts[row.source] = row.count;
    counts.all += row.count;
  }
  return counts;
}

export type AdminCommentListQuery = z.infer<typeof AdminCommentListQuerySchema>;

/** `GET /admin/comments` va MCP `list_comments` uchun umumiy ro'yxat (chiqindi qutisidagi postlarning izohlari chiqmaydi). */
export async function listAdminComments(query: AdminCommentListQuery) {
  const { status, source, postId, q, from, to, page, limit } = query;
  const offset = (page - 1) * limit;

  // Chiqindi qutisidagi postlarning izohlari ro'yxatda ham, sanoqlarda ham ko'rinmaydi.
  const conditions = [postNotTrashed(comments.postId)];
  if (status !== "all") conditions.push(eq(comments.status, status));
  if (source !== "all") conditions.push(eq(comments.source, source));
  if (postId) conditions.push(eq(comments.postId, postId));
  if (q) {
    const like = `%${escapeLike(q)}%`;
    conditions.push(or(ilike(comments.body, like), ilike(comments.authorName, like))!);
  }
  if (from) conditions.push(gte(comments.createdAt, new Date(`${from}T00:00:00.000Z`)));
  if (to) conditions.push(lte(comments.createdAt, new Date(`${to}T23:59:59.999Z`)));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, countRows, counts, sourceCounts] = await Promise.all([
    db
      .select(adminCommentColumns)
      .from(comments)
      .innerJoin(posts, eq(comments.postId, posts.id))
      .leftJoin(user, eq(comments.authorUserId, user.id))
      .leftJoin(parentComment, eq(comments.parentId, parentComment.id))
      .where(whereClause)
      .orderBy(desc(comments.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(comments)
      .where(whereClause),
    computeCommentCounts(),
    computeSourceCounts(),
  ]);

  const total = countRows[0]?.count ?? 0;

  return {
    items: rows.map((row) => toAdminItem(row as AdminCommentRow)),
    page,
    limit,
    total,
    hasMore: page * limit < total,
    counts,
    sourceCounts,
  };
}

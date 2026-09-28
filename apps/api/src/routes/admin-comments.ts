import { Hono } from "hono";
import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  AdminCommentBanBodySchema,
  AdminCommentBulkBodySchema,
  AdminCommentReplyBodySchema,
  AdminCommentUpdateBodySchema,
} from "@blog/shared";
import { db } from "../db/index.js";
import { bannedDevices, comments, posts } from "../db/schema.js";
import { user } from "../db/auth-schema.js";
import { recountPostComments, shortHash } from "../lib/comments.js";
import { banCommentAuthor, deleteCommentCascade, replyToCommentAsAdmin, setCommentStatus } from "../lib/comments-admin.js";
import { requireAdmin } from "../lib/require-admin.js";
import { escapeLike } from "../lib/like.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const STATUS_VALUES = ["all", "pending", "visible", "hidden", "deleted"] as const;
const SOURCE_VALUES = ["all", "web", "telegram"] as const;
/** `YYYY-MM-DD` — sana input'idan (`<input type="date">`) keladi. */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const ListQuerySchema = z.object({
  status: z.enum(STATUS_VALUES).default("all"),
  source: z.enum(SOURCE_VALUES).default("all"),
  postId: z.string().optional(),
  q: z.string().trim().min(1).optional(),
  from: z.string().regex(DATE_ONLY_RE).optional(),
  to: z.string().regex(DATE_ONLY_RE).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

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
  };
}

async function computeCommentCounts(): Promise<Record<"all" | "pending" | "visible" | "hidden" | "deleted", number>> {
  const rows = await db
    .select({ status: comments.status, count: sql<number>`count(*)::int` })
    .from(comments)
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
    .groupBy(comments.source);

  const counts = { all: 0, web: 0, telegram: 0 };
  for (const row of rows) {
    counts[row.source] = row.count;
    counts.all += row.count;
  }
  return counts;
}

export const adminCommentsRoute = new Hono()
  .use("*", requireAdmin)
  .get("/", async (c) => {
    const parsed = ListQuerySchema.safeParse({
      status: c.req.query("status") ?? undefined,
      source: c.req.query("source") ?? undefined,
      postId: c.req.query("postId"),
      q: c.req.query("q"),
      from: c.req.query("from"),
      to: c.req.query("to"),
      page: c.req.query("page"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov parametrlari" }, 400);

    const { status, source, postId, q, from, to, page, limit } = parsed.data;
    if (from && to && from > to) {
      return c.json({ error: "'from' sanasi 'to' sanasidan keyin bo'lishi mumkin emas" }, 400);
    }
    const offset = (page - 1) * limit;

    const conditions = [];
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

    return c.json({
      items: rows.map((row) => toAdminItem(row as AdminCommentRow)),
      page,
      limit,
      total,
      hasMore: page * limit < total,
      counts,
      sourceCounts,
    });
  })
  .patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const parsed = AdminCommentUpdateBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);

    const updated = await setCommentStatus(id, parsed.data.status);
    if (!updated) return c.json({ error: "Topilmadi" }, 404);

    return c.json({ ok: true });
  })
  .post("/bulk", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = AdminCommentBulkBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);

    const rows = await db
      .select({ id: comments.id, postId: comments.postId })
      .from(comments)
      .where(inArray(comments.id, parsed.data.ids));

    if (rows.length === 0) return c.json({ ok: true, updated: 0 });

    const bulkUpdate: { status: "visible" | "hidden" | "deleted"; deletedAt?: Date } = {
      status: parsed.data.status,
    };
    if (parsed.data.status === "deleted") bulkUpdate.deletedAt = new Date();

    await db.update(comments).set(bulkUpdate).where(inArray(comments.id, parsed.data.ids));

    const postIds = [...new Set(rows.map((r) => r.postId))];
    await Promise.all(postIds.map((postId) => recountPostComments(postId)));

    return c.json({ ok: true, updated: rows.length });
  })
  .post("/:id/reply", async (c) => {
    const id = c.req.param("id");
    const adminUser = c.get("adminUser");

    const body = await c.req.json().catch(() => null);
    const parsed = AdminCommentReplyBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);

    const created = await replyToCommentAsAdmin(id, parsed.data.body, {
      id: adminUser.id,
      name: adminUser.name ?? adminUser.email,
    });
    if (!created) return c.json({ error: "Topilmadi" }, 404);

    return c.json({ id: created.id }, 201);
  })
  .delete("/:id", async (c) => {
    const deleted = await deleteCommentCascade(c.req.param("id"));
    if (!deleted) return c.json({ error: "Topilmadi" }, 404);
    return c.json({ ok: true });
  })
  .post("/:id/ban", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const parsed = AdminCommentBanBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);

    const banned = await banCommentAuthor(id, parsed.data.reason);
    if (!banned) return c.json({ error: "Topilmadi" }, 404);

    return c.json({ ok: true });
  });

export const adminBansRoute = new Hono()
  .use("*", requireAdmin)
  .get("/", async (c) => {
    const rows = await db.select().from(bannedDevices).orderBy(desc(bannedDevices.createdAt));
    return c.json({
      items: rows.map((row) => ({
        id: row.id,
        deviceHash: row.deviceHash,
        ipHash: row.ipHash,
        reason: row.reason,
        createdAt: row.createdAt.toISOString(),
      })),
    });
  })
  .delete("/:id", async (c) => {
    await db.delete(bannedDevices).where(eq(bannedDevices.id, c.req.param("id")));
    return c.json({ ok: true });
  });

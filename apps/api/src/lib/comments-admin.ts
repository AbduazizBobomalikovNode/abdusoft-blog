import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { bannedDevices, comments, posts } from "../db/schema.js";
import { bot } from "../telegram/client.js";
import { nextCommentPath, recountPostComments } from "./comments.js";
import { renderCommentBody } from "./markdown.js";
import { getSettings } from "./settings.js";

/**
 * Admin izoh-moderatsiya amallari — HTTP marshrutlari (`routes/admin-comments.ts`)
 * va Telegram bot handler'lari (`telegram/comments.ts`) shu bir xil funksiyalarni
 * chaqiradi, shunda ikkala interfeys ham bir xil ishlaydi.
 *
 * `source === 'telegram'` bo'lgan izohlar uchun moderatsiya amallari Telegram
 * tomonida ham ta'sir qiladi (guruhdagi xabarni o'chirish / foydalanuvchini
 * bloklash) — bu chaqiruvlar HECH QACHON asosiy DB amalini to'xtatmaydi:
 * xatolik faqat log qilinadi ("known limitation": Telegram'da to'g'ridan-to'g'ri
 * o'chirilgan xabarlar haqida bot bildirishnoma olmaydi, shu sabab ular panelda
 * qolib ketadi).
 */

export interface CommentRow {
  id: string;
  postId: string;
  parentId: string | null;
  path: string;
  depth: number;
  authorTokenHash: string | null;
  ipHash: string | null;
  status: "visible" | "pending" | "hidden" | "deleted";
  source: "web" | "telegram";
  tgChatId: number | null;
  tgMessageId: number | null;
  tgUserId: number | null;
}

export async function loadCommentRow(id: string): Promise<CommentRow | null> {
  const [row] = await db.select().from(comments).where(eq(comments.id, id)).limit(1);
  return row ?? null;
}

/** TG-manbali izoh uchun guruhdagi xabarni o'chirishga urinadi — muvaffaqiyatsizlik jimgina log qilinadi, DB amaliga ta'sir qilmaydi. */
async function deleteTelegramMessageForComment(comment: CommentRow): Promise<void> {
  if (comment.source !== "telegram" || !comment.tgChatId || !comment.tgMessageId || !bot) return;
  try {
    await bot.api.deleteMessage(comment.tgChatId, comment.tgMessageId);
  } catch (error) {
    console.error(`Telegram guruhidagi izoh xabarini o'chirishda xatolik (comment ${comment.id}):`, error);
  }
}

export async function setCommentStatus(
  id: string,
  status: "visible" | "hidden" | "deleted",
): Promise<CommentRow | null> {
  const comment = await loadCommentRow(id);
  if (!comment) return null;

  await db
    .update(comments)
    .set({ status, deletedAt: status === "deleted" ? new Date() : null })
    .where(eq(comments.id, id));

  if (status === "hidden" || status === "deleted") {
    await deleteTelegramMessageForComment(comment);
  }

  await recountPostComments(comment.postId);
  return { ...comment, status };
}

export async function deleteCommentCascade(id: string): Promise<CommentRow | null> {
  const comment = await loadCommentRow(id);
  if (!comment) return null;

  const [childCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(comments)
    .where(eq(comments.parentId, id));

  if ((childCountRow?.count ?? 0) > 0) {
    await db.update(comments).set({ status: "deleted", deletedAt: new Date() }).where(eq(comments.id, id));
  } else {
    await db.delete(comments).where(eq(comments.id, id));
  }

  await deleteTelegramMessageForComment(comment);

  await recountPostComments(comment.postId);
  return comment;
}

export async function banCommentAuthor(id: string, reason?: string): Promise<CommentRow | null> {
  const comment = await loadCommentRow(id);
  if (!comment) return null;

  if (comment.source === "telegram") {
    if (comment.tgUserId) {
      const settings = await getSettings();
      const discussionChatId = settings.telegram.discussionGroupId;
      if (bot && discussionChatId) {
        try {
          await bot.api.banChatMember(discussionChatId, comment.tgUserId);
        } catch (error) {
          console.error(`Telegram foydalanuvchisini bloklashda xatolik (tg user ${comment.tgUserId}):`, error);
        }
      }

      const affected = await db
        .select({ id: comments.id, postId: comments.postId })
        .from(comments)
        .where(and(eq(comments.tgUserId, comment.tgUserId), eq(comments.status, "visible")));

      if (affected.length > 0) {
        await db
          .update(comments)
          .set({ status: "hidden" })
          .where(and(eq(comments.tgUserId, comment.tgUserId), eq(comments.status, "visible")));

        const postIds = [...new Set(affected.map((a) => a.postId))];
        await Promise.all(postIds.map((postId) => recountPostComments(postId)));
      }
    }

    return comment;
  }

  await db.insert(bannedDevices).values({
    deviceHash: comment.authorTokenHash,
    ipHash: comment.ipHash,
    reason: reason ?? null,
  });

  if (comment.authorTokenHash) {
    const affected = await db
      .select({ id: comments.id, postId: comments.postId })
      .from(comments)
      .where(and(eq(comments.authorTokenHash, comment.authorTokenHash), eq(comments.status, "visible")));

    if (affected.length > 0) {
      await db
        .update(comments)
        .set({ status: "hidden" })
        .where(and(eq(comments.authorTokenHash, comment.authorTokenHash), eq(comments.status, "visible")));

      const postIds = [...new Set(affected.map((a) => a.postId))];
      await Promise.all(postIds.map((postId) => recountPostComments(postId)));
    }
  }

  return comment;
}

export interface AdminReplyAuthor {
  id: string;
  name: string;
}

export async function replyToCommentAsAdmin(
  parentId: string,
  body: string,
  author: AdminReplyAuthor,
): Promise<{ id: string; postId: string; postSlug: string } | null> {
  const [parent] = await db
    .select({
      id: comments.id,
      postId: comments.postId,
      path: comments.path,
      depth: comments.depth,
    })
    .from(comments)
    .where(eq(comments.id, parentId))
    .limit(1);
  if (!parent) return null;

  const [post] = await db.select({ slug: posts.slug }).from(posts).where(eq(posts.id, parent.postId)).limit(1);
  if (!post) return null;

  const { path, depth } = await nextCommentPath(parent.postId, {
    id: parent.id,
    path: parent.path,
    depth: parent.depth,
  });

  const bodyHtml = renderCommentBody(body);

  const [created] = await db
    .insert(comments)
    .values({
      postId: parent.postId,
      parentId: parent.id,
      path,
      depth,
      authorName: author.name,
      authorUserId: author.id,
      body,
      bodyHtml,
      status: "visible",
    })
    .returning();

  if (!created) return null;

  await recountPostComments(parent.postId);
  return { id: created.id, postId: parent.postId, postSlug: post.slug };
}

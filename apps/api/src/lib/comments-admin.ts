import { and, eq, sql } from "drizzle-orm";
import { GrammyError } from "grammy";
import { db } from "../db/index.js";
import { bannedDevices, comments, posts } from "../db/schema.js";
import { user } from "../db/auth-schema.js";
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

/**
 * Muallifni bloklash mumkinmi? Telegram izohlarida `tg_user_id` bo'lishi shart —
 * kanal/anonim admin nomidan yozilgan yoki botning o'z javoblarida u yo'q (bloklab bo'lmaydi).
 */
export function isBanAvailable(comment: Pick<CommentRow, "source" | "tgUserId">): boolean {
  return comment.source !== "telegram" || Boolean(comment.tgUserId);
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

/** Telegram guruhiga yuborish muvaffaqiyatsiz — `status`: 409 (bot sozlanmagan / amal mumkin emas) yoki 502 (Telegram xatosi). */
export class TelegramReplyError extends Error {
  constructor(
    message: string,
    readonly status: 409 | 502,
  ) {
    super(message);
    this.name = "TelegramReplyError";
  }
}

function telegramFailureReason(error: unknown): string {
  if (error instanceof GrammyError) return error.description;
  return error instanceof Error ? error.message : "noma'lum xatolik";
}

/**
 * Admin javobini Telegram muhokama guruhiga BOT nomidan yuboradi (oddiy matn, preview o'chirilgan) va yangi xabar id'sini qaytaradi.
 * `reply_parameters.message_id` — ota izoh xabari: supergroup'da izoh-thread ichidagi xabarga reply qilish javobni shu thread'da qoldiradi
 * (alohida `message_thread_id` shart emas). `allow_sending_without_reply` ATAYLAB berilmaydi: ota xabar Telegram'da o'chirilgan bo'lsa,
 * Bot API xato qaytaradi va javob guruhning thread'siz umumiy oqimiga tushib ketmaydi.
 */
async function sendReplyToTelegramGroup(chatId: number, parentMessageId: number, text: string): Promise<number> {
  if (!bot) throw new TelegramReplyError("Telegram bot sozlanmagan", 409);
  try {
    const sent = await bot.api.sendMessage(chatId, text, {
      reply_parameters: { message_id: parentMessageId },
      link_preview_options: { is_disabled: true },
    });
    return sent.message_id;
  } catch (error) {
    console.error(`Telegram guruhiga javob yuborishda xatolik (chat ${chatId}):`, error);
    throw new TelegramReplyError(`Telegram guruhiga yuborib bo'lmadi: ${telegramFailureReason(error)}`, 502);
  }
}

async function bestEffortDeleteTelegramMessage(chatId: number, messageId: number): Promise<void> {
  if (!bot) return;
  try {
    await bot.api.deleteMessage(chatId, messageId);
  } catch (error) {
    console.error(`Telegram xabarini qaytarib o'chirishda xatolik (chat ${chatId}, msg ${messageId}):`, error);
  }
}

/** Ota izoh Telegram manbali bo'lsa — uning guruh/xabar id'larini qaytaradi (yo'q bo'lsa 409). */
function requireTelegramTarget(parent: { tgChatId: number | null; tgMessageId: number | null }): {
  chatId: number;
  messageId: number;
} {
  if (!parent.tgChatId || !parent.tgMessageId) {
    throw new TelegramReplyError("Telegram izohining xabar identifikatori topilmadi — javob yuborib bo'lmaydi", 409);
  }
  return { chatId: parent.tgChatId, messageId: parent.tgMessageId };
}

/**
 * `source='telegram'` ota izohga admin javobi: avval guruhga yuboriladi, MUVAFFAQIYATLI bo'lsagina DB'ga saqlanadi.
 * Web izohga javob — avvalgidek faqat DB'ga yoziladi. Xatolikda `TelegramReplyError` otiladi (hech narsa saqlanmaydi).
 */
export async function replyToCommentAsAdmin(
  parentId: string,
  body: string,
  author: AdminReplyAuthor,
): Promise<{ id: string; postId: string; postSlug: string; source: "web" | "telegram" } | null> {
  const [parent] = await db
    .select({
      id: comments.id,
      postId: comments.postId,
      path: comments.path,
      depth: comments.depth,
      source: comments.source,
      tgChatId: comments.tgChatId,
      tgMessageId: comments.tgMessageId,
    })
    .from(comments)
    .where(eq(comments.id, parentId))
    .limit(1);
  if (!parent) return null;

  const [post] = await db.select({ slug: posts.slug }).from(posts).where(eq(posts.id, parent.postId)).limit(1);
  if (!post) return null;

  const target = parent.source === "telegram" ? requireTelegramTarget(parent) : null;
  const sentMessageId = target ? await sendReplyToTelegramGroup(target.chatId, target.messageId, body) : null;

  try {
    const { path, depth } = await nextCommentPath(parent.postId, {
      id: parent.id,
      path: parent.path,
      depth: parent.depth,
    });

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
        bodyHtml: renderCommentBody(body),
        status: "visible",
        ...(target && sentMessageId
          ? { source: "telegram" as const, tgChatId: target.chatId, tgMessageId: sentMessageId, tgUserId: null }
          : {}),
      })
      .returning();

    if (!created) throw new Error("izoh yaratilmadi");

    await recountPostComments(parent.postId);
    return { id: created.id, postId: parent.postId, postSlug: post.slug, source: created.source };
  } catch (error) {
    // Guruhga yuborilgan, lekin DB'ga yozilmadi — "yetim" xabar qolmasligi uchun qaytarib o'chiramiz.
    if (target && sentMessageId) await bestEffortDeleteTelegramMessage(target.chatId, sentMessageId);
    throw error;
  }
}

/**
 * Tuzatishdan OLDINGI admin javobi (web manbali, ota izohi Telegram'da) ni guruhga yuboradi va qatorni `source='telegram'` ga aylantiradi.
 * `null` — topilmadi; `TelegramReplyError(409)` — qo'llab bo'lmaydi / allaqachon yuborilgan.
 */
export async function sendAdminReplyToTelegram(id: string): Promise<{ id: string; postId: string } | null> {
  const row = await loadCommentRow(id);
  if (!row) return null;

  if (row.source === "telegram") throw new TelegramReplyError("Bu javob allaqachon Telegramga yuborilgan", 409);

  const [info] = await db
    .select({ body: comments.body, authorUserId: comments.authorUserId, role: user.role })
    .from(comments)
    .leftJoin(user, eq(comments.authorUserId, user.id))
    .where(eq(comments.id, id))
    .limit(1);
  if (!info || !info.authorUserId || info.role !== "admin" || row.status !== "visible" || !row.parentId) {
    throw new TelegramReplyError("Bu izohni Telegramga yuborib bo'lmaydi", 409);
  }

  const [parent] = await db
    .select({ source: comments.source, tgChatId: comments.tgChatId, tgMessageId: comments.tgMessageId })
    .from(comments)
    .where(eq(comments.id, row.parentId))
    .limit(1);
  if (!parent || parent.source !== "telegram") {
    throw new TelegramReplyError("Bu izohni Telegramga yuborib bo'lmaydi: ota izoh Telegram izohi emas", 409);
  }

  const target = requireTelegramTarget(parent);
  const sentMessageId = await sendReplyToTelegramGroup(target.chatId, target.messageId, info.body);

  try {
    // `source='web'` sharti — parallel ikki marta bosilganda faqat bittasi qatorni aylantiradi.
    const updated = await db
      .update(comments)
      .set({ source: "telegram", tgChatId: target.chatId, tgMessageId: sentMessageId, tgUserId: null })
      .where(and(eq(comments.id, id), eq(comments.source, "web")))
      .returning();
    if (updated.length === 0) {
      await bestEffortDeleteTelegramMessage(target.chatId, sentMessageId);
      throw new TelegramReplyError("Bu javob allaqachon Telegramga yuborilgan", 409);
    }
  } catch (error) {
    if (!(error instanceof TelegramReplyError)) await bestEffortDeleteTelegramMessage(target.chatId, sentMessageId);
    throw error;
  }

  await recountPostComments(row.postId);
  return { id, postId: row.postId };
}

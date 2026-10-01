import { InlineKeyboard } from "grammy";
import { eq } from "drizzle-orm";
import { events, type CommentCreatedEventPayload } from "../lib/events.js";
import { config } from "../config.js";
import { getSettings } from "../lib/settings.js";
import { setPendingReply, takePendingReply } from "../lib/site-settings.js";
import { banCommentAuthor, deleteCommentCascade, isBanAvailable, loadCommentRow, replyToCommentAsAdmin, setCommentStatus, TelegramReplyError } from "../lib/comments-admin.js";
import { db } from "../db/index.js";
import { user as userTable } from "../db/auth-schema.js";
import { posts } from "../db/schema.js";
import { bot } from "./client.js";
import { escapeHtml, stripHtml, truncate } from "./format.js";
import { handleReviewNoteReply } from "./review.js";

const EXCERPT_LIMIT = 300;

function postUrl(slug: string, commentId: string): string {
  return `${config.WEB_ORIGIN}/${slug}#comment-${commentId}`;
}

export function moderationKeyboard(commentId: string, isPending: boolean, postSlug: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (isPending) kb.text("✅ Tasdiqlash", `c:approve:${commentId}`).row();
  kb.text("🙈 Yashirish", `c:hide:${commentId}`).text("🗑 O'chirish", `c:delete:${commentId}`).row();
  kb.text("🚫 Bloklash", `c:ban:${commentId}`).text("💬 Javob", `c:reply:${commentId}`).row();
  kb.url("🔗 Ochish", postUrl(postSlug, commentId));
  return kb;
}

function badgeFor(author: CommentCreatedEventPayload["author"]): string {
  if (author.isAdmin) return " 👑";
  if (author.userId) return " ✓";
  return "";
}

function notificationText(payload: CommentCreatedEventPayload): string {
  const excerpt = truncate(stripHtml(payload.comment.bodyHtml || payload.comment.body), EXCERPT_LIMIT);
  const statusLabel = payload.comment.status === "pending" ? "⏳ Kutilmoqda" : "✅ Ko'rinadi";
  return [
    `💬 Yangi izoh — <a href="${config.WEB_ORIGIN}/${payload.post.slug}">${escapeHtml(payload.post.title)}</a>`,
    `${escapeHtml(payload.author.name)}${badgeFor(payload.author)} · ${statusLabel}`,
    escapeHtml(excerpt),
  ].join("\n\n");
}

async function handleCommentCreated(payload: CommentCreatedEventPayload): Promise<void> {
  const settings = await getSettings();
  if (!bot || !settings.telegram.enabled || !settings.telegram.adminChatId) return;
  if (!settings.telegram.notifyComments) return;

  try {
    await bot.api.sendMessage(settings.telegram.adminChatId, notificationText(payload), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: moderationKeyboard(payload.comment.id, payload.comment.status === "pending", payload.post.slug),
    });
  } catch (error: unknown) {
    console.error("Telegram izoh bildirishnomasi xatosi:", error);
  }
}

/** `telegram/review.ts` ham ishlatadi — Telegram callback bosgan admin foydalanuvchining ichki (DB) hisobini aniqlash uchun. */
export async function findAdminUser(): Promise<{ id: string; name: string } | null> {
  const [row] = await db.select({ id: userTable.id, name: userTable.name }).from(userTable).where(eq(userTable.role, "admin")).limit(1);
  return row ? { id: row.id, name: row.name ?? "Admin" } : null;
}

async function updateNotificationAfterAction(
  chatId: number | string,
  messageId: number,
  originalText: string,
  statusLine: string,
): Promise<void> {
  if (!bot) return;
  try {
    await bot.api.editMessageText(chatId, messageId, `${originalText}\n\n${statusLine}`, {
      parse_mode: "HTML",
    });
  } catch {
    // Xabar allaqachon o'zgargan yoki juda eski bo'lishi mumkin — e'tiborsiz qoldiramiz.
  }
}

/**
 * `bot.ts`dagi `initTelegram()` BIR MARTA chaqiradi (bot instansiga bog'liq
 * emas) — bot keyinroq qayta yaratilsa ham bu listener qayta ro'yxatga
 * olinmasligi kerak (aks holda bildirishnoma bir necha marta yuborilardi).
 */
export function registerCommentEvents(): void {
  events.on("comment.created", handleCommentCreated);
}

/** `bot.ts` — bot instansi (qayta) yaratilganda chaqiradi — callback_query va reply-xabar handler'larini JORIY bot'ga ulaydi. */
export function registerCommentBotHandlers(): void {
  if (!bot) return;

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const [prefix, action, commentId] = data.split(":");
    if (prefix !== "c" || !commentId) return;

    const message = ctx.callbackQuery.message;
    const originalText = message && "text" in message ? (message.text ?? "") : "";

    if (action === "reply") {
      const comment = await loadCommentRow(commentId);
      if (!comment) {
        await ctx.answerCallbackQuery({ text: "Izoh topilmadi" });
        return;
      }
      const [postRow] = await db.select({ slug: posts.slug }).from(posts).where(eq(posts.id, comment.postId)).limit(1);

      const prompt = await ctx.reply("Javob matnini yozing", {
        reply_markup: { force_reply: true, selective: true },
        reply_parameters: message ? { message_id: message.message_id } : undefined,
      });
      await setPendingReply(prompt.message_id, { kind: "comment", commentId, postSlug: postRow?.slug ?? "" });
      await ctx.answerCallbackQuery();
      return;
    }

    let statusLine = "";
    if (action === "approve") {
      const updated = await setCommentStatus(commentId, "visible");
      statusLine = updated ? "✅ Tasdiqlandi" : "Topilmadi";
    } else if (action === "hide") {
      const updated = await setCommentStatus(commentId, "hidden");
      statusLine = updated ? "🙈 Yashirildi" : "Topilmadi";
    } else if (action === "delete") {
      const updated = await deleteCommentCascade(commentId);
      statusLine = updated ? "🗑 O'chirildi" : "Topilmadi";
    } else if (action === "ban") {
      const target = await loadCommentRow(commentId);
      if (target && !isBanAvailable(target)) {
        statusLine = "Bloklab bo'lmaydi";
      } else {
        const updated = await banCommentAuthor(commentId);
        statusLine = updated ? "🚫 Bloklandi" : "Topilmadi";
      }
    } else {
      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.answerCallbackQuery({ text: statusLine });
    if (message) {
      await updateNotificationAfterAction(message.chat.id, message.message_id, originalText, statusLine);
    }
  });

  bot.on("message:text", async (ctx, next) => {
    const replyToId = ctx.message.reply_to_message?.message_id;
    if (!replyToId) return next();

    const pending = await takePendingReply(replyToId);
    if (!pending) return next();

    if (pending.kind === "review") {
      await handleReviewNoteReply(ctx, pending.postId, pending.chatId, pending.originalMessageId, pending.originalText);
      return;
    }

    const adminUser = await findAdminUser();
    if (!adminUser) {
      await ctx.reply("Admin foydalanuvchi topilmadi — javob yaratilmadi.");
      return;
    }

    let created: Awaited<ReturnType<typeof replyToCommentAsAdmin>>;
    try {
      created = await replyToCommentAsAdmin(pending.commentId, ctx.message.text, adminUser);
    } catch (error) {
      if (error instanceof TelegramReplyError) {
        await ctx.reply(error.message);
        return;
      }
      throw error;
    }
    if (!created) {
      await ctx.reply("Izoh topilmadi — javob yaratilmadi.");
      return;
    }

    await ctx.reply(`✅ Javob yuborildi: ${config.WEB_ORIGIN}/${created.postSlug}#comment-${created.id}`);
  });
}

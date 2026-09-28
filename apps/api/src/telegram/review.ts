import { InlineKeyboard } from "grammy";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { posts } from "../db/schema.js";
import { events, type PostSubmittedEventPayload } from "../lib/events.js";
import { approvePost, requestPostChanges } from "../lib/post-review.js";
import { getSettings } from "../lib/settings.js";
import { setPendingReply } from "../lib/site-settings.js";
import { bot } from "./client.js";
import { findAdminUser } from "./comments.js";
import { escapeHtml, escapeHtmlAttr, stripHtml, truncate } from "./format.js";

const EXCERPT_LIMIT = 500;

function previewUrl(postId: string): string {
  return `${config.WEB_ORIGIN}/admin/postlar/${postId}/preview`;
}

function reviewKeyboard(postId: string): InlineKeyboard {
  return new InlineKeyboard()
    .url("👁 Ko'rish", previewUrl(postId))
    .row()
    .text("✅ Chop etish", `pr:ok:${postId}`)
    .text("✏️ Qaytarish", `pr:back:${postId}`);
}

async function notificationText(payload: PostSubmittedEventPayload): Promise<string> {
  const [row] = await db.select({ contentText: posts.contentText }).from(posts).where(eq(posts.id, payload.id)).limit(1);
  const excerpt = truncate(stripHtml(row?.contentText ?? ""), EXCERPT_LIMIT);
  return [
    "📝 Ko'rib chiqish uchun yangi post",
    "",
    `<b>${escapeHtml(payload.title)}</b>`,
    `Yozgan: ${escapeHtml(payload.authorName)}`,
    "",
    escapeHtml(excerpt),
  ].join("\n");
}

async function handlePostSubmitted(payload: PostSubmittedEventPayload): Promise<void> {
  const settings = await getSettings();
  if (!bot || !settings.telegram.enabled || !settings.telegram.adminChatId) return;

  try {
    await bot.api.sendMessage(settings.telegram.adminChatId, await notificationText(payload), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: reviewKeyboard(payload.id),
    });
  } catch (error: unknown) {
    console.error("Telegram post ko'rib chiqish bildirishnomasi xatosi:", error);
  }
}

/** `bot.ts`dagi `initTelegram()` BIR MARTA chaqiradi (bot instansiga bog'liq emas). */
export function registerReviewEvents(): void {
  events.on("post.submitted", (payload) => void handlePostSubmitted(payload));
}

async function editOriginalMessage(
  chatId: number | string,
  messageId: number,
  originalText: string,
  statusLine: string,
): Promise<void> {
  if (!bot) return;
  try {
    await bot.api.editMessageText(chatId, messageId, `${originalText}\n\n${statusLine}`, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch {
    // Xabar allaqachon o'zgargan yoki juda eski — e'tiborsiz qoldiramiz (idempotentlik).
  }
}

/**
 * `telegram/comments.ts`dagi umumiy ForceReply javob handler'i — pending
 * yozuv `kind: "review"` bo'lsa shu yerga yo'naltiriladi (izoh matni admin
 * yozgan `ctx.message.text`).
 */
export async function handleReviewNoteReply(
  ctx: { message: { text: string }; reply: (text: string) => Promise<unknown> },
  postId: string,
  chatId: number | string,
  originalMessageId: number,
  originalText: string,
): Promise<void> {
  const adminUser = await findAdminUser();
  if (!adminUser) {
    await ctx.reply("Admin foydalanuvchi topilmadi — izoh saqlanmadi.");
    return;
  }

  const note = ctx.message.text.trim();
  const result = await requestPostChanges(postId, adminUser.id, note);

  if (!result.ok) {
    const message = result.reason === "not_in_review" ? "Post allaqachon ko'rib chiqilgan." : "Post topilmadi.";
    await ctx.reply(message);
    return;
  }

  const statusLine = `✏️ Qaytarildi: ${escapeHtml(note)}`;
  await editOriginalMessage(chatId, originalMessageId, originalText, statusLine);
  await ctx.reply("✅ Izoh yuborildi — xodim admin panelda ko'radi.");
}

/** `bot.ts` — bot instansi (qayta) yaratilganda chaqiradi — callback_query handler'ini JORIY bot'ga ulaydi. */
export function registerReviewHandlers(): void {
  if (!bot) return;

  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    const [prefix, action, postId] = data.split(":");
    if (prefix !== "pr" || !postId) return next();

    const message = ctx.callbackQuery.message;
    const originalText = message && "text" in message ? (message.text ?? "") : "";

    if (action === "ok") {
      const adminUser = await findAdminUser();
      if (!adminUser) {
        await ctx.answerCallbackQuery({ text: "Admin foydalanuvchi topilmadi" });
        return;
      }

      const result = await approvePost(postId, adminUser.id);
      if (!result.ok) {
        await ctx.answerCallbackQuery({
          text: result.reason === "not_in_review" ? "Post allaqachon ko'rib chiqilgan" : "Topilmadi",
        });
        return;
      }

      await ctx.answerCallbackQuery({ text: "✅ Chop etildi" });
      if (message) {
        const url = `${config.WEB_ORIGIN}/${result.post.slug}`;
        const statusLine = `✅ Chop etildi: <a href="${escapeHtmlAttr(url)}">${escapeHtml(result.post.title)}</a>`;
        await editOriginalMessage(message.chat.id, message.message_id, originalText, statusLine);
      }
      return;
    }

    if (action === "back") {
      if (!message) {
        await ctx.answerCallbackQuery();
        return;
      }

      const prompt = await ctx.reply("Nima tuzatilsin?", {
        reply_markup: { force_reply: true, selective: true },
        reply_parameters: { message_id: message.message_id },
      });
      await setPendingReply(prompt.message_id, {
        kind: "review",
        postId,
        chatId: message.chat.id,
        originalMessageId: message.message_id,
        originalText,
      });
      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.answerCallbackQuery();
  });
}

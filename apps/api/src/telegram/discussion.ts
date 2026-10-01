import type { Context } from "grammy";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { comments, telegramRefs } from "../db/schema.js";
import { MAX_COMMENT_DEPTH, nextCommentPath, recountPostComments } from "../lib/comments.js";
import { renderCommentBody } from "../lib/markdown.js";
import { getSettings, setDiscussionGroupId } from "../lib/settings.js";
import { bot } from "./client.js";

/**
 * Kanalga bog'langan muhokama guruhidan kelgan xabarlarni izohlarga aylantiradi:
 *
 * 1. Kanal posti guruhga AVTOMATIK forward qilinganda (`is_automatic_forward`)
 *    — shu forward xabarini tegishli `telegram_refs` yozuviga bog'laydi
 *    (`discussion_chat_id`/`discussion_message_id`).
 * 2. Shu forward xabariga (yoki uning ostidagi boshqa Telegram izohiga) javob
 *    sifatida guruhga yozilgan har qanday xabarni — izoh sifatida saqlaydi.
 * 3. `edited_message` — mos izohning matnini yangilaydi.
 *
 * MUHIM: bu handler'lar `bot.ts`dagi admin-only gate middleware'dan OLDIN
 * ro'yxatga olinishi SHART — aks holda oddiy o'quvchilar yozgan guruh
 * xabarlari (admin bo'lmagani uchun) hech qachon bu yerga yetib kelmaydi.
 */

let cachedChannelResolution: { input: string; numericId: number } | null = null;

/** `settings.telegram.channelId` (`@username` yoki `-100...`) ni raqamli chat id'ga aylantiradi — `getChat` faqat bir marta (keshlanadi) chaqiriladi. */
async function resolveChannelNumericId(channelId: string): Promise<number | null> {
  if (!channelId) return null;
  if (/^-?\d+$/.test(channelId)) return Number(channelId);
  if (cachedChannelResolution?.input === channelId) return cachedChannelResolution.numericId;
  if (!bot) return null;

  try {
    const chat = await bot.api.getChat(channelId);
    cachedChannelResolution = { input: channelId, numericId: chat.id };
    return chat.id;
  } catch (error) {
    console.error("Telegram kanal ID'sini aniqlashda xatolik (getChat):", error);
    return null;
  }
}

type GroupMessage = NonNullable<Context["message"]>;

function bodyFromMessage(message: GroupMessage): string {
  if ("text" in message && message.text) return message.text;
  if ("caption" in message && message.caption) return message.caption;
  if ("photo" in message) return "[rasm]";
  if ("video" in message) return "[video]";
  if ("sticker" in message) return "[stiker]";
  if ("voice" in message) return "[ovozli xabar]";
  if ("document" in message) return "[fayl]";
  if ("audio" in message) return "[fayl]";
  return "[fayl]";
}

function authorNameFrom(from: { first_name: string; last_name?: string }): string {
  return from.last_name ? `${from.first_name} ${from.last_name}` : from.first_name;
}

export type ForwardLike = Pick<GroupMessage, "message_id" | "is_automatic_forward" | "forward_origin">;

/**
 * Guruhdagi avtomatik forward xabarini (kanal postining nusxasi) tegishli postga bog'laydi.
 * `true` — bog'landi (yoki allaqachon bog'langan edi).
 */
export async function mapForwardToPost(chatId: number, forward: ForwardLike): Promise<boolean> {
  if (!forward.is_automatic_forward) return false;

  const origin = forward.forward_origin;
  if (!origin || origin.type !== "channel") return false;

  const settings = await getSettings();
  const channelId = settings.telegram.channelId;
  if (!channelId) return false;

  const numericChannelId = await resolveChannelNumericId(channelId);
  if (numericChannelId === null || origin.chat.id !== numericChannelId) return false;

  // Albom (media group) bo'lsa BIR NECHTA kanal xabari bitta postga tegishli
  // bo'ladi (`channel_message_ids`) — shu sabab forward'ning `message_id`si
  // legacy yagona ustunga ("channel_message_id") YOKI shu jsonb massivning
  // ICHIDA (@> containment) mos kelishi kifoya.
  const [ref] = await db
    .select({ postId: telegramRefs.postId, discussionMessageId: telegramRefs.discussionMessageId })
    .from(telegramRefs)
    .where(
      sql`${telegramRefs.channelMessageId} = ${origin.message_id} OR ${telegramRefs.channelMessageIds} @> ${JSON.stringify([origin.message_id])}::jsonb`,
    )
    .limit(1);
  if (!ref) return false; // boshqa (bizga tegishli bo'lmagan) kanal xabarining forward'i
  if (ref.discussionMessageId === forward.message_id) return true;
  // Albom bir nechta xabar sifatida forward qilinadi (har biri o'z
  // `forward_origin.message_id`si bilan) — ASOSIY (thread ildizi) sifatida
  // FAQAT BIRINCHI kelgan forward saqlanadi, keyingi albom elementlari uni
  // qayta yozib yubormaydi (aks holda oldingi bog'lanish yo'qolib qolardi).
  if (ref.discussionMessageId) return true;

  await db
    .update(telegramRefs)
    .set({
      discussionChatId: chatId,
      discussionMessageId: forward.message_id,
      updatedAt: new Date(),
    })
    .where(eq(telegramRefs.postId, ref.postId));

  await setDiscussionGroupId(chatId);

  return true;
}

/** `sender_chat` nomidan yozilgan izoh muallifi: kanal/guruh nomi, guruhning o'zi bo'lsa — anonim admin. */
function senderChatName(senderChat: { id: number; title?: string; username?: string }, groupChatId: number): string {
  if (senderChat.id === groupChatId) return senderChat.title ? `${senderChat.title} (admin)` : "Anonim admin";
  return senderChat.title ?? (senderChat.username ? `@${senderChat.username}` : "Kanal");
}

/**
 * Guruhdan kelgan, lekin izoh sifatida saqlanmagan xabar uchun diagnostika (matn log qilinmaydi).
 * "Izohlar kelmayapti" holatida sababni journal'dan ko'rish uchun.
 */
function logIgnored(reason: string, ctx: Context): void {
  const m = ctx.message;
  console.log(
    `TG guruh xabari izoh sifatida olinmadi: sabab=${reason} chat=${ctx.chat?.id} msg=${m?.message_id}` +
      ` thread=${m?.message_thread_id ?? "-"} reply=${m?.reply_to_message?.message_id ?? "-"}` +
      ` from_bot=${ctx.from?.is_bot ?? "-"} sender_chat=${m && "sender_chat" in m && m.sender_chat ? m.sender_chat.id : "-"}`,
  );
}

/** Kanaldan avtomatik forward qilingan xabarni tegishli postga bog'laydi. `true` — ushbu xabar shu tarzda ishlov berilgani (boshqa handler urinmasin). */
async function tryHandleAutomaticForward(ctx: Context): Promise<boolean> {
  const message = ctx.message;
  if (!message?.is_automatic_forward) return false;
  return mapForwardToPost(ctx.chat!.id, message);
}

/** Guruhdagi (forward'ning o'zi bo'lmagan) xabarni izoh sifatida saqlaydi — mos kelmasa `false`. */
export async function tryHandleGroupComment(ctx: Context): Promise<boolean> {
  const message = ctx.message;
  if (!message) return false;
  if (!ctx.from) return false;
  if (message.is_automatic_forward) return false; // bizga tegishli bo'lmagan kanal posti forward'i — izoh emas

  const chatId = ctx.chat!.id;
  // Kanal nomidan ("send as channel") yoki anonim admin sifatida yozilgan izohlarda Telegram
  // `sender_chat`ni to'ldiradi, `from` esa xizmat boti (Channel_Bot / GroupAnonymousBot) bo'ladi.
  // Kanal egasi o'z postiga ko'pincha aynan shunday izoh yozadi — bular ham izoh sifatida olinadi.
  const senderChat = "sender_chat" in message && message.sender_chat ? message.sender_chat : null;
  if (!senderChat && ctx.from.is_bot) {
    logIgnored("bot_message", ctx);
    return false; // haqiqiy bot (shu jumladan o'zimiz) yozgan xabar
  }
  const threadId = message.message_thread_id ?? null;
  const replyToId = message.reply_to_message?.message_id ?? null;

  // Kechikkan bog'lash: kanal posti bot guruhga admin bo'lishidan OLDIN forward qilingan
  // bo'lsa, forward update'i bizga kelmagan. Birinchi izoh `reply_to_message` ichida o'sha
  // forward'ni (forward_origin bilan) olib keladi — bog'lanishni shundan tiklaymiz.
  if (message.reply_to_message?.is_automatic_forward) {
    await mapForwardToPost(chatId, message.reply_to_message);
  }
  const candidateRootId = threadId ?? replyToId;
  if (!candidateRootId) {
    logIgnored("not_in_thread", ctx);
    return false;
  }

  let postId: string | null = null;
  let parentCommentId: string | null = null;

  const [rootRef] = await db
    .select({ postId: telegramRefs.postId })
    .from(telegramRefs)
    .where(and(eq(telegramRefs.discussionChatId, chatId), eq(telegramRefs.discussionMessageId, candidateRootId)))
    .limit(1);

  if (rootRef) {
    postId = rootRef.postId;
    // Thread ichida forward'ning o'ziga emas, balki boshqa saqlangan TG izohga javob bo'lsa — nested reply.
    if (replyToId && replyToId !== candidateRootId) {
      const [parentComment] = await db
        .select({ id: comments.id, postId: comments.postId })
        .from(comments)
        .where(and(eq(comments.tgChatId, chatId), eq(comments.tgMessageId, replyToId), eq(comments.source, "telegram")))
        .limit(1);
      if (parentComment && parentComment.postId === postId) parentCommentId = parentComment.id;
    }
  } else if (replyToId) {
    const [parentComment] = await db
      .select({ id: comments.id, postId: comments.postId })
      .from(comments)
      .where(and(eq(comments.tgChatId, chatId), eq(comments.tgMessageId, replyToId), eq(comments.source, "telegram")))
      .limit(1);
    if (!parentComment) {
      logIgnored("unmapped_thread", ctx);
      return false;
    }
    postId = parentComment.postId;
    parentCommentId = parentComment.id;
  }

  if (!postId) {
    logIgnored("unmapped_thread", ctx);
    return false; // guruhdagi boshqa (bizga aloqasi bo'lmagan) xabar — e'tiborsiz qoldiriladi
  }

  const [existing] = await db
    .select({ id: comments.id })
    .from(comments)
    .where(and(eq(comments.tgChatId, chatId), eq(comments.tgMessageId, message.message_id)))
    .limit(1);
  if (existing) return true; // webhook qayta yuborilgan — idempotent, qayta yozmaymiz

  let parent: { id: string; path: string; depth: number } | null = null;
  if (parentCommentId) {
    const [parentRow] = await db
      .select({ id: comments.id, path: comments.path, depth: comments.depth })
      .from(comments)
      .where(eq(comments.id, parentCommentId))
      .limit(1);
    parent = parentRow ?? null;
  }

  const { path, depth } = await nextCommentPath(postId, parent);
  if (depth > MAX_COMMENT_DEPTH) return true; // juda chuqur — e'tiborsiz (lekin "ishlov berildi" deb belgilanadi)

  const body = bodyFromMessage(message);
  const bodyHtml = renderCommentBody(body);

  const created = await db
    .insert(comments)
    .values({
      postId,
      parentId: parentCommentId,
      path,
      depth,
      authorName: senderChat ? senderChatName(senderChat, chatId) : authorNameFrom(ctx.from),
      body,
      bodyHtml,
      status: "visible",
      source: "telegram",
      tgChatId: chatId,
      tgMessageId: message.message_id,
      tgUsername: senderChat ? (senderChat.username ?? null) : (ctx.from.username ?? null),
      // Kanal/anonim admin nomidan yozilganda haqiqiy foydalanuvchi id'si yo'q (bloklab bo'lmaydi).
      tgUserId: senderChat ? null : ctx.from.id,
    })
    .onConflictDoNothing()
    .returning();

  if (created.length > 0) {
    await recountPostComments(postId);
  }

  return true;
}

/** `edited_message` — mos Telegram izohining matnini yangilaydi. */
async function tryHandleEditedMessage(ctx: Context): Promise<boolean> {
  const message = ctx.editedMessage;
  if (!message || !ctx.chat) return false;

  const body = bodyFromMessage(message);
  const bodyHtml = renderCommentBody(body);

  const updated = await db
    .update(comments)
    .set({ body, bodyHtml, editedAt: new Date() })
    .where(
      and(
        eq(comments.tgChatId, ctx.chat.id),
        eq(comments.tgMessageId, message.message_id),
        eq(comments.source, "telegram"),
      ),
    )
    .returning();

  return updated.length > 0;
}

function isGroupChat(ctx: Context): boolean {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

/**
 * `bot.ts` — bot instansi (qayta) yaratilganda, ADMIN-GATE MIDDLEWARE'DAN
 * OLDIN chaqirilishi kerak. Mos kelmagan yangilanishlar `next()` orqali
 * qoldirilgan handler'larga (buyruqlar, admin-chat callback'lari) o'tkaziladi.
 */
export function registerDiscussionHandlers(): void {
  if (!bot) return;

  bot.on("message", async (ctx, next) => {
    if (!isGroupChat(ctx)) return next();

    if (await tryHandleAutomaticForward(ctx)) return;
    if (await tryHandleGroupComment(ctx)) return;
    return next();
  });

  bot.on("edited_message", async (ctx, next) => {
    if (!isGroupChat(ctx)) return next();

    const handled = await tryHandleEditedMessage(ctx);
    if (!handled) return next();
  });
}

import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { GrammyError, InputFile, InputMediaBuilder } from "grammy";
import sharp from "sharp";
import { isChannelComboValid, type ChannelMediaKind, type ChannelMode, type ChannelVariant } from "@blog/shared";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { posts, telegramRefs } from "../db/schema.js";
import { uploadsDir } from "../lib/media/store.js";
import { getSettings } from "../lib/settings.js";
import { tagsForPostIds } from "../routes/posts.js";
import { bot } from "./client.js";
import { buildChannelPost, MAX_CHANNEL_MEDIA } from "./channel-post.js";

/**
 * "Kanalga yuborish" dialogi (admin panel) va Telegram tasdiqlash oqimi
 * (`review.ts`) ISHLATADIGAN yagona joy — HTTP marshrut va bot callback'i bir
 * xil funksiyalarni chaqiradi, shu sabab ikkalasi ham bir xil natijaga olib
 * keladi (idempotentlik ham shu yerda ta'minlanadi).
 */

const DOWNLOAD_TIMEOUT_MS = 10_000;
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const JPEG_QUALITY = 88;
const MAX_SIDE = 2560;

type ChannelMessageType = "text" | "photo" | "album";

export interface ChannelMediaEntry {
  url: string;
  kind: ChannelMediaKind;
  alt: string | null;
}

export interface ChannelComputed {
  post: { id: string; slug: string; title: string; coverUrl: string | null };
  mode: ChannelMode;
  captionHtml: string;
  visibleLength: number;
  limit: number;
  truncated: boolean;
  media: ChannelMediaEntry[];
}

export type ComputeChannelPostResult =
  | { ok: true; data: ChannelComputed }
  | { ok: false; reason: "not_found" | "not_published" | "invalid_combo" | "no_media" };

export async function loadTelegramRef(postId: string) {
  const [row] = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, postId)).limit(1);
  return row ?? null;
}

export async function upsertTelegramRef(
  postId: string,
  patch: Partial<{
    telegraphPath: string | null;
    telegraphUrl: string | null;
    channelMessageId: number | null;
    channelMessageType: ChannelMessageType | null;
    channelVariant: ChannelVariant | null;
    channelMode: ChannelMode | null;
    channelMessageIds: number[] | null;
    channelSentAt: Date | null;
  }>,
): Promise<void> {
  const existing = await loadTelegramRef(postId);
  if (existing) {
    await db
      .update(telegramRefs)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(telegramRefs.postId, postId));
    return;
  }
  await db.insert(telegramRefs).values({ postId, ...patch, updatedAt: new Date() });
}

/** grammY `GrammyError.description` "Bad Request: message is not modified" bo'lsa — muvaffaqiyat sifatida ko'riladi (log qilinmaydi). */
function isNotModifiedError(error: unknown): boolean {
  return error instanceof GrammyError && /message is not modified/i.test(error.description);
}

/** `@kanalnomi` ko'rinishidagi kanallar uchun ochiq havola quradi — `-100...` raqamli id'lar uchun (xususiy kanal) havola yasab bo'lmaydi. */
function messageUrlFor(channelId: string, messageId: number): string | null {
  if (!channelId.startsWith("@")) return null;
  return `https://t.me/${channelId.slice(1)}/${messageId}`;
}

/** Post + tanlangan rejim/variant asosida caption (yoki matn) va media ro'yxatini quradi (yuborish HAM, oldindan ko'rish HAM shundan foydalanadi). */
export async function computeChannelPost(
  postId: string,
  mode: ChannelMode,
  variant: ChannelVariant,
): Promise<ComputeChannelPostResult> {
  if (!isChannelComboValid(mode, variant)) return { ok: false, reason: "invalid_combo" };

  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post) return { ok: false, reason: "not_found" };
  if (post.status !== "published") return { ok: false, reason: "not_published" };

  const ref = await loadTelegramRef(postId);
  const tagMap = await tagsForPostIds([postId]);
  const tagNames = (tagMap.get(postId) ?? []).map((t) => t.name);

  const built = buildChannelPost({
    post: {
      title: post.title,
      slug: post.slug,
      contentJson: post.contentJson,
      tags: tagNames,
      coverUrl: post.coverUrl,
    },
    siteUrl: config.WEB_ORIGIN,
    telegraphUrl: ref?.telegraphUrl ?? null,
    mode,
    variant,
  });

  const media: ChannelMediaEntry[] = [];
  if (mode === "media") {
    if (post.coverUrl) media.push({ url: post.coverUrl, kind: "cover", alt: null });
    for (const image of built.images) {
      if (media.length >= MAX_CHANNEL_MEDIA) break;
      media.push({ url: image.url, kind: "content", alt: image.alt });
    }
    // 🖼 Rasmli tanlangan, lekin postda na kover, na band ichidagi rasm bor — UI oldindan taqiqlaydi, bu yerda ikkinchi himoya qatlami.
    if (media.length === 0) return { ok: false, reason: "no_media" };
  }

  return {
    ok: true,
    data: {
      post: { id: post.id, slug: post.slug, title: post.title, coverUrl: post.coverUrl },
      mode,
      captionHtml: built.html,
      visibleLength: built.visibleLength,
      limit: built.limit,
      truncated: built.truncated,
      media,
    },
  };
}

export interface ChannelAlreadySentInfo {
  at: string;
  mode: ChannelMode;
  variant: ChannelVariant;
  messageUrl: string | null;
}

/**
 * Saqlangan `channelMode` — eski qatorlarda `null` bo'lishi mumkin
 * (`0006_luxuriant_blob.sql`dan oldin yuborilgan postlar): shu holda
 * `channelMessageType`ga qarab aniqlanadi ('text' -> 'text', 'photo'/'album' -> 'media').
 */
function resolveChannelMode(ref: { channelMode: ChannelMode | null; channelMessageType: ChannelMessageType | null }): ChannelMode {
  if (ref.channelMode) return ref.channelMode;
  return ref.channelMessageType === "text" ? "text" : "media";
}

/** Post allaqachon kanalga yuborilgan bo'lsa — qachon, qaysi rejim/variant bilan va havolasi (bo'lsa). */
export async function getChannelAlreadySent(postId: string): Promise<ChannelAlreadySentInfo | null> {
  const ref = await loadTelegramRef(postId);
  if (!ref?.channelSentAt || !ref.channelVariant) return null;
  const settings = await getSettings();
  const messageUrl = ref.channelMessageId ? messageUrlFor(settings.telegram.channelId, ref.channelMessageId) : null;
  return { at: ref.channelSentAt.toISOString(), mode: resolveChannelMode(ref), variant: ref.channelVariant, messageUrl };
}

/** Mahalliy yuklamalar (`/uploads/...`) diskdan to'g'ridan-to'g'ri o'qiladi — tashqi URL'lar HTTP orqali (timeout + hajm chegarasi bilan) olinadi. */
async function fetchImageBytes(url: string): Promise<Buffer> {
  const localPrefix = `${config.API_ORIGIN}/uploads/`;
  if (url.startsWith(localPrefix)) {
    const key = url.slice(localPrefix.length);
    return readFile(path.join(uploadsDir, key));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentLength = res.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_DOWNLOAD_BYTES) {
      throw new Error("Fayl hajmi 10 MB dan katta");
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MAX_DOWNLOAD_BYTES) throw new Error("Fayl hajmi 10 MB dan katta");
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

/** JPEG'ga aylantiradi (sifat ~88, uzun tomoni ko'pi bilan 2560px) — `sharp` metadata'ni standart holatda saqlamaydi (strip). */
async function convertToJpeg(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
}

/** Bitta media elementini yuklab, JPEG'ga aylantiradi — muvaffaqiyatsiz bo'lsa `null` (log qilinib, o'sha rasm o'tkazib yuboriladi). */
async function prepareMediaFile(url: string): Promise<InputFile | null> {
  try {
    const raw = await fetchImageBytes(url);
    const jpeg = await convertToJpeg(raw);
    return new InputFile(jpeg, "photo.jpg");
  } catch (error) {
    console.error(`Kanal uchun rasmni tayyorlashda xatolik (${url}):`, error);
    return null;
  }
}

export type SendChannelPostResult =
  | {
      ok: true;
      mode: ChannelMode;
      variant: ChannelVariant;
      messageType: ChannelMessageType;
      messageIds: number[];
      messageUrl: string | null;
      sentAt: string;
    }
  | {
      ok: false;
      reason: "not_found" | "not_published" | "telegram_disabled" | "already_sent" | "invalid_combo" | "no_media";
    };

/** Kanalning barcha saqlangan xabarlarini (albom bo'lsa hammasini) o'chiradi va `telegram_refs`dagi kanal maydonlarini tozalaydi. */
export async function deleteChannelMessages(postId: string): Promise<void> {
  const settings = await getSettings();
  const channelId = settings.telegram.channelId;
  const ref = await loadTelegramRef(postId);
  if (!ref) return;

  const ids = ref.channelMessageIds && ref.channelMessageIds.length > 0
    ? ref.channelMessageIds
    : ref.channelMessageId
      ? [ref.channelMessageId]
      : [];

  if (bot && channelId) {
    for (const id of ids) {
      try {
        await bot.api.deleteMessage(channelId, id);
      } catch (error) {
        console.error(`Kanal xabarini o'chirishda xatolik (post ${postId}, message ${id}):`, error);
      }
    }
  }

  // Eski xabarlar o'chirilgani sababli ularning muhokama guruhidagi
  // forward'lari ham endi yaroqsiz — bog'lanishni ham tozalaymiz, shunda
  // qayta yuborilgan (yoki hech qachon qayta yuborilmagan) post uchun eski
  // (o'chirilgan) izoh iplariga noto'g'ri bog'lanib qolmaydi.
  await db
    .update(telegramRefs)
    .set({
      channelMessageId: null,
      channelMessageType: null,
      channelVariant: null,
      channelMessageIds: null,
      channelSentAt: null,
      discussionChatId: null,
      discussionMessageId: null,
      updatedAt: new Date(),
    })
    .where(eq(telegramRefs.postId, postId));
}

/**
 * Postni kanalga yuboradi — kover haqiqiy rasm sifatida, undan keyin (bo'lsa)
 * kontent rasmlari BITTA albom (yoki yolg'iz bo'lsa `sendPhoto`) ko'rinishida,
 * caption albomning BIRINCHI elementida. Rasm umuman bo'lmasa — oddiy matn
 * xabari (preview o'chirilgan). Inline tugma (keyboard) HECH QACHON qo'shilmaydi.
 *
 * `POST /admin/posts/:id/channel/send` va Telegram tasdiqlash oqimidagi
 * "✅ Kanalga yuborish" callback'i AYNAN shu funksiyani chaqiradi.
 */
interface DeliverResult {
  messageType: ChannelMessageType;
  messageIds: number[];
}

/**
 * Media + caption'ni berilgan chat'ga jo'natadi (haqiqiy kanalga HAM, admin
 * chatidagi oldindan ko'rish uchun HAM ishlatiladi) — DB'ga hech narsa
 * yozmaydi, faqat Telegram'ga yuborish mexanikasi (rasm yuklash/JPEG'ga
 * aylantirish/sendPhoto/sendMediaGroup/matn fallback) shu yerda markazlashgan.
 */
async function deliverChannelMessage(chatId: number | string, data: ChannelComputed): Promise<DeliverResult> {
  if (!bot) throw new Error("Telegram bot sozlanmagan");

  // 📝 Rasmsiz — har doim oddiy matn xabari (preview o'chirilgan), rasm umuman ishlatilmaydi.
  if (data.mode === "text") {
    const sent = await bot.api.sendMessage(chatId, data.captionHtml, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    return { messageType: "text", messageIds: [sent.message_id] };
  }

  const prepared: { file: InputFile; alt: string | null }[] = [];
  for (const item of data.media) {
    const file = await prepareMediaFile(item.url);
    if (file) prepared.push({ file, alt: item.alt });
  }

  const caption = data.captionHtml;

  if (prepared.length === 0) {
    // 🖼 Rasmli tanlangan, lekin rasm yuklab bo'lmadi (masalan tarmoq xatosi) — oxirgi chora sifatida matn.

    const sent = await bot.api.sendMessage(chatId, caption, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    return { messageType: "text", messageIds: [sent.message_id] };
  }

  if (prepared.length === 1) {
    const sent = await bot.api.sendPhoto(chatId, prepared[0]!.file, { caption, parse_mode: "HTML" });
    return { messageType: "photo", messageIds: [sent.message_id] };
  }

  const mediaPayload = prepared.map((item, idx) =>
    InputMediaBuilder.photo(item.file, idx === 0 ? { caption, parse_mode: "HTML" } : {}),
  );
  const sent = await bot.api.sendMediaGroup(chatId, mediaPayload);
  return { messageType: "album", messageIds: sent.map((message) => message.message_id) };
}

/**
 * Telegram tasdiqlash oqimi (`review.ts`) uchun — kanalga yuborilishi mumkin
 * bo'lgan AYNAN o'sha ko'rinishni (albom/rasm+caption) admin chatiga oldindan
 * ko'rsatadi. Hech narsa saqlamaydi (DB write yo'q) — faqat jonli namuna.
 */
export async function sendChannelPreviewToChat(chatId: number | string, data: ChannelComputed): Promise<void> {
  await deliverChannelMessage(chatId, data);
}

export async function sendPostToChannel(
  postId: string,
  mode: ChannelMode,
  variant: ChannelVariant,
  opts: { replaceExisting?: boolean } = {},
): Promise<SendChannelPostResult> {
  const settings = await getSettings();
  if (!settings.telegram.enabled || !bot || !settings.telegram.channelId) {
    return { ok: false, reason: "telegram_disabled" };
  }

  const existingRef = await loadTelegramRef(postId);
  if (existingRef?.channelSentAt && !opts.replaceExisting) {
    return { ok: false, reason: "already_sent" };
  }

  const computed = await computeChannelPost(postId, mode, variant);
  if (!computed.ok) return computed;

  if (existingRef?.channelSentAt && opts.replaceExisting) {
    await deleteChannelMessages(postId);
  }

  const channelId = settings.telegram.channelId;
  const { messageType, messageIds } = await deliverChannelMessage(channelId, computed.data);

  const sentAt = new Date();
  await upsertTelegramRef(postId, {
    channelMessageId: messageIds[0] ?? null,
    channelMessageType: messageType,
    channelVariant: variant,
    channelMode: mode,
    channelMessageIds: messageIds,
    channelSentAt: sentAt,
  });

  return {
    ok: true,
    mode,
    variant,
    messageType,
    messageIds,
    messageUrl: messageIds[0] !== undefined ? messageUrlFor(channelId, messageIds[0]) : null,
    sentAt: sentAt.toISOString(),
  };
}

/**
 * `post.updated` hodisasi uchun — post ALLAQACHON kanalga yuborilgan bo'lsa,
 * saqlangan variant bilan caption'ni qayta quradi va JOYIDA tahrirlaydi
 * (`editMessageCaption`/legacy `editMessageText`). Albom mediasi HECH QACHON
 * avtomatik o'zgartirilmaydi — faqat caption (albomning birinchi elementi).
 */
export async function editChannelCaptionForPost(postId: string): Promise<void> {
  const settings = await getSettings();
  if (!settings.telegram.enabled || !bot || !settings.telegram.channelId) return;

  const ref = await loadTelegramRef(postId);
  if (!ref?.channelSentAt || !ref.channelMessageId || !ref.channelVariant) return;

  // Saqlangan rejim bilan qayta quramiz (eski qatorlarda `channelMode` `null` — `resolveChannelMode` orqali aniqlanadi).
  const mode = resolveChannelMode(ref);
  const computed = await computeChannelPost(postId, mode, ref.channelVariant);
  if (!computed.ok) return;

  const channelId = settings.telegram.channelId;
  try {
    if (mode === "text") {
      await bot.api.editMessageText(channelId, ref.channelMessageId, computed.data.captionHtml, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } else {
      // 'photo' va 'album' (birinchi element) — ikkalasi ham editMessageCaption bilan tahrirlanadi.
      await bot.api.editMessageCaption(channelId, ref.channelMessageId, {
        caption: computed.data.captionHtml,
        parse_mode: "HTML",
      });
    }
  } catch (error: unknown) {
    if (isNotModifiedError(error)) return;
    console.error(`Kanal caption'ini yangilashda xatolik (post ${postId}):`, error);
  }
}

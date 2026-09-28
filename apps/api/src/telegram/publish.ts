import { InlineKeyboard } from "grammy";
import { eq } from "drizzle-orm";
import { DEFAULT_POST_SETTINGS, PostSettingsSchema } from "@blog/shared";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { posts, telegramRefs } from "../db/schema.js";
import { events, type PostEventPayload } from "../lib/events.js";
import { getSettings } from "../lib/settings.js";
import { tagsForPostIds } from "../routes/posts.js";
import { bot } from "./client.js";
import { escapeHtml, tagsToHashtags, truncate } from "./format.js";
import { createOrUpdateTelegraphPage, tiptapToTelegraphNodes } from "./telegraph.js";

const CAPTION_LIMIT = 900; // Telegram caption limiti 1024 — zaxira bilan.

function postUrlFor(slug: string): string {
  return `${config.WEB_ORIGIN}/${slug}`;
}

async function loadTelegramRef(postId: string) {
  const [row] = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, postId)).limit(1);
  return row ?? null;
}

async function upsertTelegramRef(
  postId: string,
  patch: Partial<{ telegraphPath: string | null; telegraphUrl: string | null; channelMessageId: number | null }>,
) {
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

function buildChannelText(params: {
  title: string;
  excerpt: string | null;
  hashtags: string;
}): string {
  const parts = [`<b>${escapeHtml(params.title)}</b>`];
  if (params.excerpt) parts.push(escapeHtml(params.excerpt));
  if (params.hashtags) parts.push(params.hashtags);
  return parts.join("\n\n");
}

function buildKeyboard(postUrl: string, telegraphUrl: string | null): InlineKeyboard {
  const kb = new InlineKeyboard().url("📖 Saytda o'qish", postUrl);
  if (telegraphUrl) kb.url("⚡ Telegramda o'qish", telegraphUrl);
  return kb;
}

/**
 * Chop etilgan/yangilangan postni Telegraph'ga ko'zguladi (agar
 * `telegraphMirror` yoqilgan bo'lsa) va Telegram kanaliga yuboradi/tahrirlaydi
 * (agar `channelAutoPost` yoqilgan va kanal sozlangan bo'lsa). HTTP so'rov
 * yo'liga hech qachon tashlamaydi — barcha xatolar shu yerda log qilinadi.
 */
async function syncPostToTelegram(postId: string): Promise<void> {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post || post.status !== "published") return;

  const postSettings = PostSettingsSchema.parse({
    ...DEFAULT_POST_SETTINGS,
    ...((post.settings as Record<string, unknown>) ?? {}),
  });
  const integrationSettings = await getSettings();

  const postUrl = postUrlFor(post.slug);
  let telegraphUrl: string | null = null;

  if (postSettings.telegraphMirror && integrationSettings.telegraph.enabled) {
    try {
      const ref = await loadTelegramRef(post.id);
      const nodes = tiptapToTelegraphNodes(post.contentJson, {
        title: post.title,
        authorName: config.API_ORIGIN,
        authorUrl: postUrl,
        postUrl,
      });
      const page = await createOrUpdateTelegraphPage(ref?.telegraphPath ?? null, nodes, {
        title: post.title,
        authorName: "Blog",
        authorUrl: postUrl,
        postUrl,
      });
      telegraphUrl = page.url;
      await upsertTelegramRef(post.id, { telegraphPath: page.path, telegraphUrl: page.url });
    } catch (error: unknown) {
      console.error(`Telegraph mirror xatosi (${post.slug}):`, error);
    }
  }

  const channelId = integrationSettings.telegram.channelId;
  if (!integrationSettings.telegram.enabled || !bot || !channelId) return;
  if (!postSettings.channelAutoPost) return;

  try {
    const tagMap = await tagsForPostIds([post.id]);
    const hashtags = tagsToHashtags((tagMap.get(post.id) ?? []).map((t) => t.name));
    const text = buildChannelText({ title: post.title, excerpt: post.excerpt, hashtags });
    const keyboard = buildKeyboard(postUrl, telegraphUrl);
    const ref = await loadTelegramRef(post.id);

    if (ref?.channelMessageId) {
      if (post.coverUrl) {
        await bot.api.editMessageCaption(channelId, ref.channelMessageId, {
          caption: truncate(text, CAPTION_LIMIT),
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
      } else {
        await bot.api.editMessageText(channelId, ref.channelMessageId, text, {
          parse_mode: "HTML",
          reply_markup: keyboard,
          link_preview_options: { url: telegraphUrl ?? postUrl, prefer_large_media: true },
        });
      }
      return;
    }

    if (post.coverUrl) {
      const sent = await bot.api.sendPhoto(channelId, post.coverUrl, {
        caption: truncate(text, CAPTION_LIMIT),
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      await upsertTelegramRef(post.id, { channelMessageId: sent.message_id });
    } else {
      const sent = await bot.api.sendMessage(channelId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
        link_preview_options: { url: telegraphUrl ?? postUrl, prefer_large_media: true },
      });
      await upsertTelegramRef(post.id, { channelMessageId: sent.message_id });
    }
  } catch (error: unknown) {
    console.error(`Telegram kanal post xatosi (${post.slug}):`, error);
  }
}

async function removeFromChannel(postId: string): Promise<void> {
  const settings = await getSettings();
  const channelId = settings.telegram.channelId;
  if (!settings.telegram.enabled || !bot || !channelId) return;

  const ref = await loadTelegramRef(postId);
  if (!ref?.channelMessageId) return;

  try {
    await bot.api.deleteMessage(channelId, ref.channelMessageId);
  } catch (error: unknown) {
    console.error(`Telegram kanal xabarini o'chirishda xatolik (post ${postId}):`, error);
  }

  await upsertTelegramRef(postId, { channelMessageId: null });
}

function handlePublishedOrUpdated(payload: PostEventPayload): void {
  void syncPostToTelegram(payload.id);
}

function handleUnpublished(payload: PostEventPayload): void {
  void removeFromChannel(payload.id);
}

/** `app.ts`/`index.ts` ishga tushganda bir marta chaqiriladi — post hodisalariga obuna bo'ladi. */
export function registerTelegramPublishing(): void {
  events.on("post.published", handlePublishedOrUpdated);
  events.on("post.updated", handlePublishedOrUpdated);
  events.on("post.unpublished", handleUnpublished);
}

/** Admin HTTP endpoint'lari (`/admin/posts/:id/telegram/*`) uchun to'g'ridan-to'g'ri chaqiriladigan versiyalar. */
export async function refreshTelegraphMirror(postId: string): Promise<void> {
  await syncPostToTelegram(postId);
}

export async function repostToChannel(postId: string): Promise<void> {
  await removeFromChannel(postId);
  await syncPostToTelegram(postId);
}

export async function getTelegramRefForPost(postId: string) {
  return loadTelegramRef(postId);
}

import { GrammyError, InlineKeyboard } from "grammy";
import { eq } from "drizzle-orm";
import { DEFAULT_POST_SETTINGS, PostSettingsSchema } from "@blog/shared";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { posts, telegramRefs } from "../db/schema.js";
import { events, type PostEventPayload } from "../lib/events.js";
import { getSettings } from "../lib/settings.js";
import { tagsForPostIds } from "../routes/posts.js";
import { bot } from "./client.js";
import { buildChannelPost, CHANNEL_CAPTION_LIMIT, CHANNEL_TEXT_LIMIT } from "./channel-post.js";
import { createOrUpdateTelegraphPage, tiptapToTelegraphNodes } from "./telegraph.js";

type ChannelMessageType = "text" | "photo";

function postUrlFor(slug: string): string {
  return `${config.WEB_ORIGIN}/${slug}`;
}

async function loadTelegramRef(postId: string) {
  const [row] = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, postId)).limit(1);
  return row ?? null;
}

async function upsertTelegramRef(
  postId: string,
  patch: Partial<{
    telegraphPath: string | null;
    telegraphUrl: string | null;
    channelMessageId: number | null;
    channelMessageType: ChannelMessageType | null;
  }>,
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

function buildKeyboard(postUrl: string, telegraphUrl: string | null): InlineKeyboard {
  const kb = new InlineKeyboard().url("📖 Saytda o'qish", postUrl);
  if (telegraphUrl) kb.url("⚡ Telegramda o'qish", telegraphUrl);
  return kb;
}

/** grammY `GrammyError.description` "Bad Request: message is not modified" bo'lsa — muvaffaqiyat sifatida ko'riladi (log qilinmaydi). */
function isNotModifiedError(error: unknown): boolean {
  return error instanceof GrammyError && /message is not modified/i.test(error.description);
}

/** editMessageCaption'ni text-turdagi xabarga (caption yo'q) qo'llashga urinishda Telegram qaytaradigan xato. */
function isCaptionTypeMismatch(error: unknown): boolean {
  return (
    error instanceof GrammyError &&
    (/there is no caption/i.test(error.description) || /message can't be edited/i.test(error.description))
  );
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
  } else {
    telegraphUrl = (await loadTelegramRef(post.id))?.telegraphUrl ?? null;
  }

  const channelId = integrationSettings.telegram.channelId;
  if (!integrationSettings.telegram.enabled || !bot || !channelId) return;
  if (!postSettings.channelAutoPost) return;

  try {
    const tagMap = await tagsForPostIds([post.id]);
    const tagNames = (tagMap.get(post.id) ?? []).map((t) => t.name);
    const keyboard = buildKeyboard(postUrl, telegraphUrl);
    const ref = await loadTelegramRef(post.id);

    if (ref?.channelMessageId) {
      if (ref.channelMessageType === "text") {
        const built = buildChannelPost({
          post: { title: post.title, slug: post.slug, contentJson: post.contentJson, tags: tagNames },
          siteUrl: config.WEB_ORIGIN,
          telegraphUrl,
          limit: CHANNEL_TEXT_LIMIT,
        });
        try {
          await bot.api.editMessageText(channelId, ref.channelMessageId, built.html, {
            parse_mode: "HTML",
            reply_markup: keyboard,
            link_preview_options: {
              url: post.coverUrl ?? postUrl,
              prefer_large_media: true,
              show_above_text: true,
            },
          });
        } catch (error: unknown) {
          if (!isNotModifiedError(error)) throw error;
        }
        return;
      }

      // channelMessageType === 'photo' yoki null (legacy) — avval caption yo'li, mos kelmasa editMessageText'ga o'tamiz.
      const captionBuilt = buildChannelPost({
        post: { title: post.title, slug: post.slug, contentJson: post.contentJson, tags: tagNames },
        siteUrl: config.WEB_ORIGIN,
        telegraphUrl,
        limit: CHANNEL_CAPTION_LIMIT,
      });
      try {
        await bot.api.editMessageCaption(channelId, ref.channelMessageId, {
          caption: captionBuilt.html,
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
        return;
      } catch (error: unknown) {
        if (isNotModifiedError(error)) return;
        if (!isCaptionTypeMismatch(error)) throw error;
      }

      const textBuilt = buildChannelPost({
        post: { title: post.title, slug: post.slug, contentJson: post.contentJson, tags: tagNames },
        siteUrl: config.WEB_ORIGIN,
        telegraphUrl,
        limit: CHANNEL_TEXT_LIMIT,
      });
      try {
        await bot.api.editMessageText(channelId, ref.channelMessageId, textBuilt.html, {
          parse_mode: "HTML",
          reply_markup: keyboard,
          link_preview_options: {
            url: post.coverUrl ?? postUrl,
            prefer_large_media: true,
            show_above_text: true,
          },
        });
      } catch (error: unknown) {
        if (!isNotModifiedError(error)) throw error;
      }
      await upsertTelegramRef(post.id, { channelMessageType: "text" });
      return;
    }

    // Yangi post — har doim sendMessage (rasm bo'lsa ham) — kover linkPreview orqali ko'rsatiladi.
    const built = buildChannelPost({
      post: { title: post.title, slug: post.slug, contentJson: post.contentJson, tags: tagNames },
      siteUrl: config.WEB_ORIGIN,
      telegraphUrl,
      limit: CHANNEL_TEXT_LIMIT,
    });
    const sent = await bot.api.sendMessage(channelId, built.html, {
      parse_mode: "HTML",
      reply_markup: keyboard,
      link_preview_options: {
        url: post.coverUrl ?? postUrl,
        prefer_large_media: true,
        show_above_text: true,
      },
    });
    await upsertTelegramRef(post.id, { channelMessageId: sent.message_id, channelMessageType: "text" });
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

  // MUHIM: kanal xabarini avtomatik o'chirib qayta yubormaymiz — bu izoh
  // muhokamasi (discussion thread) bog'lanishini buzadi. Faqat `post.unpublished`
  // hodisasida haqiqatan o'chiramiz (quyida), qayta chop etishda esa tahrirlanadi.
  try {
    await bot.api.deleteMessage(channelId, ref.channelMessageId);
  } catch (error: unknown) {
    console.error(`Telegram kanal xabarini o'chirishda xatolik (post ${postId}):`, error);
  }

  await upsertTelegramRef(postId, { channelMessageId: null, channelMessageType: null });
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

/**
 * DIQQAT: bu funksiya kanal xabarini o'chirib, qaytadan yuboradi — muhokama
 * guruhidagi eski forward/thread bog'lanishini buzadi. Faqat admin panelda
 * foydalanuvchi ONGLI ravishda "qayta yuborish" bosgandagina chaqirilishi
 * kerak (avtomatik update oqimida ISHLATILMAYDI — u `syncPostToTelegram`
 * orqali xabarni JOYIDA tahrirlaydi).
 */
export async function repostToChannel(postId: string): Promise<void> {
  await removeFromChannel(postId);
  await syncPostToTelegram(postId);
}

export async function getTelegramRefForPost(postId: string) {
  return loadTelegramRef(postId);
}

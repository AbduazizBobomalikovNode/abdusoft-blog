import { eq } from "drizzle-orm";
import { DEFAULT_POST_SETTINGS, PostSettingsSchema } from "@blog/shared";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { posts } from "../db/schema.js";
import { deleteChannelMessages, editChannelCaptionForPost, loadTelegramRef, upsertTelegramRef } from "./channel-send.js";
import { events, type PostEventPayload } from "../lib/events.js";
import { getSettings } from "../lib/settings.js";
import { createOrUpdateTelegraphPage, tiptapToTelegraphNodes } from "./telegraph.js";

/**
 * Chop etilgan/yangilangan postni Telegraph'ga ko'zguladi (agar
 * `telegraphMirror` yoqilgan bo'lsa). Telegram KANALIGA yuborish ENDI
 * BUTUNLAY QO'LDA — "Kanalga yuborish" dialogidan (`channel-send.ts`,
 * `POST /admin/posts/:id/channel/send`) yoki Telegram tasdiqlash oqimidan
 * (`review.ts`). Bu funksiya faqat allaqachon yuborilgan postlar uchun
 * caption'ni yangilaydi (`post.updated`da) — YANGI post HECH QACHON
 * avtomatik yuborilmaydi. HTTP so'rov yo'liga hech qachon tashlamaydi —
 * barcha xatolar shu yerda log qilinadi.
 */
async function syncPostToTelegram(postId: string): Promise<void> {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post || post.status !== "published") return;

  const postSettings = PostSettingsSchema.parse({
    ...DEFAULT_POST_SETTINGS,
    ...((post.settings as Record<string, unknown>) ?? {}),
  });
  const integrationSettings = await getSettings();

  const postUrl = `${config.WEB_ORIGIN}/${post.slug}`;

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
      await upsertTelegramRef(post.id, { telegraphPath: page.path, telegraphUrl: page.url });
    } catch (error: unknown) {
      console.error(`Telegraph mirror xatosi (${post.slug}):`, error);
    }
  }

  // Post allaqachon kanalga (qo'lda) yuborilgan bo'lsa — caption'ni yangi
  // kontent bilan qayta quramiz. Hali yuborilmagan bo'lsa — HECH NARSA
  // qilinmaydi (avtomatik yuborish YO'Q).
  try {
    await editChannelCaptionForPost(post.id);
  } catch (error: unknown) {
    console.error(`Telegram kanal caption yangilash xatosi (${post.slug}):`, error);
  }
}

function handlePublishedOrUpdated(payload: PostEventPayload): void {
  void syncPostToTelegram(payload.id);
}

function handleUnpublished(payload: PostEventPayload): void {
  void deleteChannelMessages(payload.id).catch((error: unknown) => {
    console.error(`Telegram kanal xabarini o'chirishda xatolik (post ${payload.id}):`, error);
  });
}

/** `app.ts`/`index.ts` ishga tushganda bir marta chaqiriladi — post hodisalariga obuna bo'ladi. */
export function registerTelegramPublishing(): void {
  events.on("post.published", handlePublishedOrUpdated);
  events.on("post.updated", handlePublishedOrUpdated);
  events.on("post.unpublished", handleUnpublished);
}

/** Admin HTTP endpoint'lari (`/admin/posts/:id/telegram/telegraph`) uchun to'g'ridan-to'g'ri chaqiriladigan versiya. */
export async function refreshTelegraphMirror(postId: string): Promise<void> {
  await syncPostToTelegram(postId);
}

export async function getTelegramRefForPost(postId: string) {
  return loadTelegramRef(postId);
}

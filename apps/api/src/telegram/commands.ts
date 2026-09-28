import { desc, eq } from "drizzle-orm";
import { DEFAULT_POST_SETTINGS, PostSettingsSchema } from "@blog/shared";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { comments, posts } from "../db/schema.js";
import { events } from "../lib/events.js";
import { pathsForPost, revalidateWeb } from "../lib/revalidate.js";
import { pendingCommentsCount, resolveRange, totalsForRange } from "../lib/stats.js";
import { TELEGRAM_KEY, loadSiteSettings, upsertSiteSetting } from "../lib/site-settings.js";
import { tagsForPostIds } from "../routes/posts.js";
import { bot } from "./client.js";
import { moderationKeyboard } from "./comments.js";
import { sendDigestNow } from "./digest.js";
import { escapeHtml, stripHtml, truncate } from "./format.js";

const POSTS_LIST_LIMIT = 10;
const PENDING_LIST_LIMIT = 10;
const EXCERPT_LIMIT = 200;

const STATUS_EMOJI: Record<string, string> = {
  draft: "📝",
  scheduled: "⏰",
  published: "✅",
  archived: "🗄",
};

function postUrl(slug: string): string {
  return `${config.WEB_ORIGIN}/${slug}`;
}

async function findPostBySlug(slug: string) {
  const [post] = await db.select().from(posts).where(eq(posts.slug, slug)).limit(1);
  return post ?? null;
}

/** `/publish` va `/unpublish` — `routes/admin-posts.ts`dagi bir xil hodisa/revalidate mantig'ini takrorlaydi. */
async function publishPostBySlug(slug: string): Promise<string> {
  const post = await findPostBySlug(slug);
  if (!post) return `"${slug}" topilmadi`;

  const now = new Date();
  await db
    .update(posts)
    .set({ status: "published", publishedAt: post.publishedAt ?? now, updatedAt: now })
    .where(eq(posts.id, post.id));

  events.emit("post.published", { id: post.id, slug: post.slug });
  const tagSlugs = (await tagsForPostIds([post.id])).get(post.id)?.map((t) => t.slug) ?? [];
  revalidateWeb(pathsForPost(post.slug, tagSlugs));

  return `✅ "${post.title}" chop etildi.`;
}

async function unpublishPostBySlug(slug: string): Promise<string> {
  const post = await findPostBySlug(slug);
  if (!post) return `"${slug}" topilmadi`;

  const wasPublished = post.status === "published";
  await db.update(posts).set({ status: "draft", updatedAt: new Date() }).where(eq(posts.id, post.id));

  if (wasPublished) {
    events.emit("post.unpublished", { id: post.id, slug: post.slug });
    const tagSlugs = (await tagsForPostIds([post.id])).get(post.id)?.map((t) => t.slug) ?? [];
    revalidateWeb(pathsForPost(post.slug, tagSlugs));
  }

  return `↩️ "${post.title}" qoralamaga qaytarildi.`;
}

async function toggleComments(slug: string, on: boolean): Promise<string> {
  const post = await findPostBySlug(slug);
  if (!post) return `"${slug}" topilmadi`;

  const settings = PostSettingsSchema.parse({
    ...DEFAULT_POST_SETTINGS,
    ...((post.settings as Record<string, unknown>) ?? {}),
    commentsEnabled: on,
  });

  await db.update(posts).set({ settings, updatedAt: new Date() }).where(eq(posts.id, post.id));

  if (post.status === "published") {
    revalidateWeb(pathsForPost(post.slug));
  }

  return on ? `💬 "${post.title}" uchun izohlar yoqildi.` : `🔕 "${post.title}" uchun izohlar o'chirildi.`;
}

async function statsOverviewMessage(): Promise<string> {
  const window7d = resolveRange("7d");
  const window30d = resolveRange("30d");
  const todayWindow = { startDay: window7d.endDay, endDay: window7d.endDay, days: 1 };

  const [today, last7d, last30d, pending] = await Promise.all([
    totalsForRange(null, todayWindow),
    totalsForRange(null, window7d),
    totalsForRange(null, window30d),
    pendingCommentsCount(null),
  ]);

  return [
    "📊 <b>Statistika</b>",
    "",
    `Bugun: ${today.views} ko'rish`,
    `7 kun: ${last7d.views} ko'rish, ${last7d.likes} layk, ${last7d.dislikes} dizlayk, ${last7d.comments} izoh`,
    `30 kun: ${last30d.views} ko'rish, ${last30d.likes} layk, ${last30d.dislikes} dizlayk, ${last30d.comments} izoh`,
    `Kutilayotgan izohlar: ${pending}`,
  ].join("\n");
}

async function statsForPostMessage(slug: string): Promise<string> {
  const post = await findPostBySlug(slug);
  if (!post) return `"${slug}" topilmadi`;

  const window7d = resolveRange("7d");
  const totals = await totalsForRange(post.id, window7d);

  return [
    `📊 <b>${escapeHtml(post.title)}</b>`,
    "",
    `Jami: ${post.viewsCount} ko'rish, ${post.likesCount} layk, ${post.dislikesCount} dizlayk, ${post.commentsCount} izoh`,
    `So'nggi 7 kun: ${totals.views} ko'rish, ${totals.likes} layk, ${totals.comments} izoh`,
  ].join("\n");
}

async function postsListMessage(): Promise<string> {
  const rows = await db
    .select()
    .from(posts)
    .orderBy(desc(posts.pinned), desc(posts.updatedAt))
    .limit(POSTS_LIST_LIMIT);

  if (rows.length === 0) return "Postlar topilmadi.";

  const lines = rows.map((row) => `${STATUS_EMOJI[row.status] ?? "•"} ${escapeHtml(row.title)} — <code>${row.slug}</code>`);
  return [`📄 <b>So'nggi ${rows.length} ta post</b>`, "", ...lines].join("\n");
}

async function sendPendingComments(chatId: number | string): Promise<void> {
  if (!bot) return;

  const rows = await db
    .select({
      id: comments.id,
      body: comments.body,
      bodyHtml: comments.bodyHtml,
      authorName: comments.authorName,
      postSlug: posts.slug,
      postTitle: posts.title,
    })
    .from(comments)
    .innerJoin(posts, eq(comments.postId, posts.id))
    .where(eq(comments.status, "pending"))
    .orderBy(desc(comments.createdAt))
    .limit(PENDING_LIST_LIMIT);

  if (rows.length === 0) {
    await bot.api.sendMessage(chatId, "Kutilayotgan izohlar yo'q. ✅");
    return;
  }

  for (const row of rows) {
    const text = [
      `⏳ <a href="${postUrl(row.postSlug)}">${escapeHtml(row.postTitle)}</a>`,
      `${escapeHtml(row.authorName)}`,
      escapeHtml(truncate(stripHtml(row.bodyHtml || row.body), EXCERPT_LIMIT)),
    ].join("\n\n");

    await bot.api.sendMessage(chatId, text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: moderationKeyboard(row.id, true, row.postSlug),
    });
  }
}

/** `bot.ts` chaqiradi — barcha `/komanda`larni ro'yxatga oladi. */
export function registerCommands(): void {
  if (!bot) return;

  bot.command("start", async (ctx) => {
    await ctx.reply(
      [
        "👋 Salom! Bu blog boshqaruv boti.",
        "",
        "/stats — umumiy statistika",
        "/stats &lt;slug&gt; — post statistikasi",
        "/posts — so'nggi 10 ta post",
        "/pending — kutilayotgan izohlar",
        "/comments &lt;slug&gt; on|off — izohlarni yoqish/o'chirish",
        "/publish &lt;slug&gt; — chop etish",
        "/unpublish &lt;slug&gt; — qoralamaga qaytarish",
        "/digest — bugungi hisobotni yuborish",
        "/digest on|off — kunlik hisobotni yoqish/o'chirish",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.command("stats", async (ctx) => {
    const slug = ctx.match?.toString().trim();
    const text = slug ? await statsForPostMessage(slug) : await statsOverviewMessage();
    await ctx.reply(text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });

  bot.command("posts", async (ctx) => {
    await ctx.reply(await postsListMessage(), { parse_mode: "HTML" });
  });

  bot.command("pending", async (ctx) => {
    await sendPendingComments(ctx.chat.id);
  });

  bot.command("comments", async (ctx) => {
    const args = ctx.match?.toString().trim().split(/\s+/) ?? [];
    const [slug, mode] = args;
    if (!slug || (mode !== "on" && mode !== "off")) {
      await ctx.reply("Foydalanish: /comments <slug> on|off");
      return;
    }
    await ctx.reply(await toggleComments(slug, mode === "on"));
  });

  bot.command("publish", async (ctx) => {
    const slug = ctx.match?.toString().trim();
    if (!slug) {
      await ctx.reply("Foydalanish: /publish <slug>");
      return;
    }
    await ctx.reply(await publishPostBySlug(slug));
  });

  bot.command("unpublish", async (ctx) => {
    const slug = ctx.match?.toString().trim();
    if (!slug) {
      await ctx.reply("Foydalanish: /unpublish <slug>");
      return;
    }
    await ctx.reply(await unpublishPostBySlug(slug));
  });

  bot.command("digest", async (ctx) => {
    const mode = ctx.match?.toString().trim();
    if (mode === "on" || mode === "off") {
      const current = await loadSiteSettings();
      await upsertSiteSetting(TELEGRAM_KEY, { ...current.telegram, digestEnabled: mode === "on" });
      await ctx.reply(mode === "on" ? "🟢 Kunlik hisobot yoqildi." : "🔴 Kunlik hisobot o'chirildi.");
      return;
    }

    const sent = await sendDigestNow();
    if (!sent) await ctx.reply("Admin chat sozlanmagan.");
  });
}

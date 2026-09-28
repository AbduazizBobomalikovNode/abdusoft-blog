import { pendingCommentsCount, resolveRange, topPostsForRange, totalsForRange } from "../lib/stats.js";
import { config } from "../config.js";
import { getSettings } from "../lib/settings.js";
import { bot } from "./client.js";
import { escapeHtml } from "./format.js";

const TOP_POSTS_LIMIT = 3;

/** `/digest` buyrug'i va kunlik avtomatik yuborish (`scheduler.ts`) uchun umumiy xabar matni. */
export async function buildDigestMessage(): Promise<string> {
  const window7d = resolveRange("7d");
  const todayWindow = { startDay: window7d.endDay, endDay: window7d.endDay, days: 1 };

  const [today, last7d, pending, topPosts] = await Promise.all([
    totalsForRange(null, todayWindow),
    totalsForRange(null, window7d),
    pendingCommentsCount(null),
    topPostsForRange(window7d, TOP_POSTS_LIMIT),
  ]);

  const lines = [
    "📊 <b>Kunlik hisobot</b>",
    "",
    `Bugun: ${today.views} ko'rish`,
    `So'nggi 7 kun: ${last7d.views} ko'rish, ${last7d.likes} layk, ${last7d.comments} izoh`,
    `Kutilayotgan izohlar: ${pending}`,
  ];

  if (topPosts.length > 0) {
    lines.push("", "<b>Top postlar (7 kun):</b>");
    for (const post of topPosts) {
      lines.push(`• <a href="${config.WEB_ORIGIN}/${post.slug}">${escapeHtml(post.title)}</a> — ${post.views} ko'rish`);
    }
  }

  return lines.join("\n");
}

export async function sendDigestNow(): Promise<boolean> {
  const settings = await getSettings();
  if (!bot || !settings.telegram.enabled || !settings.telegram.adminChatId) return false;

  const text = await buildDigestMessage();
  await bot.api.sendMessage(settings.telegram.adminChatId, text, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  return true;
}

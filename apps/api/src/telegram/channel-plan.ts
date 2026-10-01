import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { ChannelPlanSchema, type ChannelPlan } from "@blog/shared";
import { db } from "../db/index.js";
import { posts } from "../db/schema.js";
import { getSettings } from "../lib/settings.js";
import { bot } from "./client.js";
import { sendPostToChannel, sendVersionToChannel, type SendChannelPostResult } from "./channel-send.js";
import { summarizePreflightErrors } from "./channel-preflight.js";
import { escapeHtml } from "./format.js";
import { awaitPostSync } from "./publish.js";

/** Rejalashtirilgan kanalga yuborish — nechta urinishdan keyin to'xtatiladi. */
export const MAX_CHANNEL_PLAN_ATTEMPTS = 5;

/** Admin chatga (bot sozlangan bo'lsa) xabar yuboradi — xatolar log qilinadi, tashlanmaydi. */
async function notifyAdmin(text: string): Promise<void> {
  try {
    const settings = await getSettings();
    if (!bot || !settings.telegram.enabled || !settings.telegram.adminChatId) return;
    await bot.api.sendMessage(settings.telegram.adminChatId, text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch (error: unknown) {
    console.error("Admin chatga kanal bildirishnomasi yuborilmadi:", error);
  }
}

/** Rejani va `channel_send_at`ni tozalaydi. */
async function clearPlan(postId: string): Promise<void> {
  await db.update(posts).set({ channelPlan: null, channelSendAt: null }).where(eq(posts.id, postId));
}

function failureReason(result: Exclude<SendChannelPostResult, { ok: true }>): string {
  switch (result.reason) {
    case "telegram_disabled":
      return "Telegram bot yoki kanal sozlanmagan";
    case "invalid_combo":
      return "rejim va uzunlik mos emas";
    case "no_media":
      return "postda rasm yo'q";
    case "not_published":
      return "post chop etilmagan";
    case "not_found":
      return "post topilmadi";
    case "already_sent":
      return "allaqachon yuborilgan";
    case "version_not_found":
      return "tanlangan versiya topilmadi (o'chirilgan)";
    case "preflight_failed":
      return `Telegram cheklovlari: ${result.preflight ? summarizePreflightErrors(result.preflight) : "tekshiruv o'tmadi"}`;
  }
}

/**
 * Jarayon "claim"dan keyin, yuborish tugamasdan to'xtab qolgan bo'lsa (masalan, deploy
 * restart'i) post `channel_plan` bilan, lekin `channel_send_at = NULL` holatida qoladi va
 * hech qachon yuborilmaydi. Ilova ishga tushganda (in-flight yuborish yo'q paytda) bunday
 * postlar qayta navbatga qo'yiladi. Ikki marta yuborishdan `already_sent` tekshiruvi saqlaydi.
 */
export async function recoverInterruptedChannelSends(now: Date = new Date()): Promise<number> {
  const rows = await db
    .update(posts)
    .set({ channelSendAt: now })
    .where(and(eq(posts.status, "published"), isNotNull(posts.channelPlan), isNull(posts.channelSendAt)))
    .returning();
  return rows.length;
}

/**
 * Vaqti kelgan (`status = 'published' and channel_send_at <= now()`) kanal
 * rejalarini bajaradi. Ikki marta yubormaslik uchun har bir post avval ATOMIK
 * "claim" qilinadi (`channel_send_at`ni NULL qiladi, faqat hali NULL bo'lmasa),
 * qayta urinish kerak bo'lsa — qaytarib qo'yiladi.
 */
export async function runDueChannelSends(now: Date = new Date()): Promise<void> {
  const due = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.status, "published"), isNotNull(posts.channelSendAt), lte(posts.channelSendAt, now)));

  for (const { id } of due) {
    const [claimed] = await db
      .update(posts)
      .set({ channelSendAt: null })
      .where(and(eq(posts.id, id), eq(posts.status, "published"), isNotNull(posts.channelSendAt)))
      .returning();
    if (!claimed) continue; // boshqa tick/jarayon allaqachon oldi

    const parsedPlan = ChannelPlanSchema.safeParse(claimed.channelPlan);
    if (!parsedPlan.success) {
      await clearPlan(id);
      continue;
    }
    const plan: ChannelPlan = parsedPlan.data;
    const attempts = (plan.attempts ?? 0) + 1;

    try {
      // Telegraph havolasi caption'ga kirishi uchun chop etish sinxronizatsiyasi tugashini kutamiz.
      await awaitPostSync(id);

      // Yuborish vaqtida preflight QAYTA ishga tushadi (`sendPostToChannel`/`sendVersionToChannel` ichida);
      // o'tmasa — bu muvaffaqiyatsiz urinish, sababi admin xabarida ko'rsatiladi.
      let result = plan.versionId
        ? await sendVersionToChannel(id, plan.versionId)
        : await sendPostToChannel(id, plan.mode, plan.variant!);
      let fellBack = false;
      if (!plan.versionId && !result.ok && result.reason === "no_media" && plan.mode === "media") {
        // Rasm/kover endi yo'q — shu uzunlik bilan rasmsiz matnga o'tamiz.
        fellBack = true;
        result = await sendPostToChannel(id, "text", plan.variant!);
      }

      if (result.ok) {
        await clearPlan(id);
        const link = result.messageUrl ? `\n${escapeHtml(result.messageUrl)}` : "";
        const note = fellBack ? "\nRasm topilmadi — rasmsiz yuborildi." : "";
        await notifyAdmin(`✅ Kanalga yuborildi: ${escapeHtml(claimed.title)}${note}${link}`);
        continue;
      }

      if (result.reason === "already_sent" || result.reason === "not_found" || result.reason === "not_published") {
        await clearPlan(id);
        continue;
      }

      await handleFailure(id, claimed.title, plan, attempts, failureReason(result), now);
    } catch (error: unknown) {
      console.error(`Rejalashtirilgan kanal yuborish xatosi (post ${id}):`, error);
      await handleFailure(id, claimed.title, plan, attempts, error instanceof Error ? error.message : String(error), now);
    }
  }
}

async function handleFailure(
  postId: string,
  title: string,
  plan: ChannelPlan,
  attempts: number,
  reason: string,
  now: Date,
): Promise<void> {
  if (attempts >= MAX_CHANNEL_PLAN_ATTEMPTS) {
    await clearPlan(postId);
    await notifyAdmin(`⚠️ Kanalga yuborilmadi: ${escapeHtml(title)} — ${escapeHtml(reason)}`);
    return;
  }
  // Keyingi tick'da qayta uriniladi (faqat reja hali bekor qilinmagan bo'lsa).
  await db
    .update(posts)
    .set({ channelPlan: { ...plan, attempts }, channelSendAt: now })
    .where(and(eq(posts.id, postId), isNotNull(posts.channelPlan)));
}

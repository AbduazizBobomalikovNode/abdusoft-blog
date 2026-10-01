import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { ChannelPlanSchema, type ChannelPlan, type ChannelSelection } from "@blog/shared";
import { db } from "../db/index.js";
import { posts } from "../db/schema.js";
import { getSettings } from "../lib/settings.js";
import { bot } from "./client.js";
import { sendPostToChannel, sendVersionToChannel, type SendChannelPostResult } from "./channel-send.js";
import { summarizePreflightErrors } from "./channel-preflight.js";
import { resolveChoiceForSend } from "./channel-choice.js";
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

/** Bitta rejani bajarish natijasi — HTTP (`publish` + "kanalga ham yuborilsin") shundan toast quradi. */
export type PlanOutcome =
  | { state: "sent"; messageUrl: string | null; note: string | null }
  | { state: "skipped" }
  | { state: "failed"; reason: string; willRetry: boolean };

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
    await runChannelPlanFor(id, now);
  }
}

/**
 * Bitta postning rejasini ATOMIK "claim" qilib bajaradi (scheduler va "chop etilgach
 * kanalga ham yuborilsin" yo'li bir xil mexanizmdan foydalanadi).
 */
export async function runChannelPlanFor(id: string, now: Date = new Date()): Promise<PlanOutcome> {
  const [claimed] = await db
    .update(posts)
    .set({ channelSendAt: null })
    .where(and(eq(posts.id, id), eq(posts.status, "published"), isNotNull(posts.channelSendAt)))
    .returning();
  if (!claimed) return { state: "skipped" }; // boshqa tick/jarayon allaqachon oldi

  const parsedPlan = ChannelPlanSchema.safeParse(claimed.channelPlan);
  if (!parsedPlan.success) {
    await clearPlan(id);
    return { state: "skipped" };
  }
  const plan: ChannelPlan = parsedPlan.data;
  const attempts = (plan.attempts ?? 0) + 1;

  try {
    // Telegraph havolasi caption'ga kirishi uchun chop etish sinxronizatsiyasi tugashini kutamiz.
    await awaitPostSync(id);

    // Nima yuboriladi: `useChoice` — YUBORISH VAQTIDAGI joriy belgi (yo'q bo'lsa standart); aks holda reja ichidagi aniq tanlov.
    let selection: ChannelSelection;
    let noMark = false;
    if (plan.useChoice) {
      const resolved = await resolveChoiceForSend(id);
      if (!resolved) {
        await clearPlan(id);
        return { state: "skipped" };
      }
      selection = resolved.selection;
      noMark = resolved.fallback;
    } else if (plan.versionId) {
      selection = { versionId: plan.versionId };
    } else {
      selection = { mode: plan.mode!, variant: plan.variant! };
    }

    // Yuborish vaqtida preflight QAYTA ishga tushadi (`sendPostToChannel`/`sendVersionToChannel` ichida);
    // o'tmasa — bu muvaffaqiyatsiz urinish, sababi admin xabarida ko'rsatiladi.
    let result =
      "versionId" in selection ? await sendVersionToChannel(id, selection.versionId) : await sendPostToChannel(id, selection.mode, selection.variant);
    let fellBack = false;
    if (!("versionId" in selection) && !result.ok && result.reason === "no_media" && selection.mode === "media") {
      // Rasm/kover endi yo'q — shu uzunlik bilan rasmsiz matnga o'tamiz.
      fellBack = true;
      result = await sendPostToChannel(id, "text", selection.variant);
    }

    if (result.ok) {
      await clearPlan(id);
      const link = result.messageUrl ? `\n${escapeHtml(result.messageUrl)}` : "";
      const notes = [
        noMark ? "Belgilangan versiya yo'q edi — standart ko'rinish yuborildi." : null,
        fellBack ? "Rasm topilmadi — rasmsiz yuborildi." : null,
      ].filter((n): n is string => n !== null);
      await notifyAdmin(`✅ Kanalga yuborildi: ${escapeHtml(claimed.title)}${notes.map((n) => `\n${n}`).join("")}${link}`);
      return { state: "sent", messageUrl: result.messageUrl, note: notes.length > 0 ? notes.join(" ") : null };
    }

    if (result.reason === "already_sent" || result.reason === "not_found" || result.reason === "not_published") {
      await clearPlan(id);
      return { state: "skipped" };
    }

    const reason = failureReason(result);
    const willRetry = await handleFailure(id, claimed.title, plan, attempts, reason, now);
    return { state: "failed", reason, willRetry };
  } catch (error: unknown) {
    console.error(`Rejalashtirilgan kanal yuborish xatosi (post ${id}):`, error);
    const reason = error instanceof Error ? error.message : String(error);
    const willRetry = await handleFailure(id, claimed.title, plan, attempts, reason, now);
    return { state: "failed", reason, willRetry };
  }
}

/** Belgilangan versiyani chop etilgandan keyin yuborish rejasini (kechikishsiz) qo'yadi va darhol bajaradi. */
export async function sendMarkedChoiceNow(postId: string): Promise<PlanOutcome> {
  const now = new Date();
  await db
    .update(posts)
    .set({ channelPlan: { useChoice: true, delayMinutes: 0, attempts: 0 }, channelSendAt: now })
    .where(and(eq(posts.id, postId), eq(posts.status, "published")));
  return runChannelPlanFor(postId, now);
}

/** `true` — qayta uriniladi; `false` — urinishlar tugadi (reja o'chirildi, admin xabardor). */
async function handleFailure(
  postId: string,
  title: string,
  plan: ChannelPlan,
  attempts: number,
  reason: string,
  now: Date,
): Promise<boolean> {
  if (attempts >= MAX_CHANNEL_PLAN_ATTEMPTS) {
    await clearPlan(postId);
    await notifyAdmin(`⚠️ Kanalga yuborilmadi: ${escapeHtml(title)} — ${escapeHtml(reason)}`);
    return false;
  }
  // Keyingi tick'da qayta uriniladi (faqat reja hali bekor qilinmagan bo'lsa).
  await db
    .update(posts)
    .set({ channelPlan: { ...plan, attempts }, channelSendAt: now })
    .where(and(eq(posts.id, postId), isNotNull(posts.channelPlan)));
  return true;
}

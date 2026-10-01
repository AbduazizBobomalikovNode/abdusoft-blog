import { isChannelComboValid, type ChannelMode, type ChannelVariant } from "@blog/shared";
import { InlineKeyboard } from "grammy";
import { desc, eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { channelPostVersions, posts } from "../db/schema.js";
import { events, type PostSubmittedEventPayload } from "../lib/events.js";
import { approvePost, requestPostChanges } from "../lib/post-review.js";
import { getSettings } from "../lib/settings.js";
import { setPendingReply } from "../lib/site-settings.js";
import { bot } from "./client.js";
import {
  computeChannelPost,
  computeChannelVersionPost,
  sendChannelPreviewToChat,
  sendPostToChannel,
  sendVersionToChannel,
  type SendChannelPostResult,
} from "./channel-send.js";
import { computeChannelPreflight, summarizePreflightErrors } from "./channel-preflight.js";
import { findAdminUser } from "./comments.js";
import { escapeHtml, escapeHtmlAttr, stripHtml, truncate } from "./format.js";
import type { ChannelPreflightResponse } from "@blog/shared";

const EXCERPT_LIMIT = 500;
/** Tasdiqlash oqimida ko'rsatiladigan maxsus versiyalar soni (eng yangilari). */
const MAX_VERSION_BUTTONS = 6;
const VERSION_LABEL_MAX = 28;
const MAX_REASONS_SHOWN = 5;
const REASON_MAX_CHARS = 200;

interface VersionChoice {
  id: string;
  name: string;
}

/** Postning maxsus kanal versiyalari — eng yangisi birinchi, ko'pi bilan `MAX_VERSION_BUTTONS` ta. */
async function listVersionChoices(postId: string): Promise<VersionChoice[]> {
  return db
    .select({ id: channelPostVersions.id, name: channelPostVersions.name })
    .from(channelPostVersions)
    .where(eq(channelPostVersions.postId, postId))
    .orderBy(desc(channelPostVersions.createdAt))
    .limit(MAX_VERSION_BUTTONS);
}

/** Preflight xatolarini admin chati uchun qisqa, HTML-escape qilingan matnga aylantiradi. */
function preflightReasonsHtml(preflight: ChannelPreflightResponse): string {
  const errors = preflight.checks.filter((c) => c.status === "error");
  const lines = errors.slice(0, MAX_REASONS_SHOWN).map((c) => `• ${escapeHtml(truncate(c.message, REASON_MAX_CHARS))}`);
  if (errors.length > MAX_REASONS_SHOWN) lines.push(`… va yana ${errors.length - MAX_REASONS_SHOWN} ta`);
  return ["⚠️ <b>Telegram cheklovi — hozircha yuborib bo'lmaydi:</b>", ...lines].join("\n");
}

/** `preflight_failed` bo'lsa — sabablarni admin chatiga yuboradi (xatolik yutilmaydi, lekin oqimni buzmaydi). */
async function reportPreflightFailure(
  chatId: number | string | undefined,
  result: Extract<SendChannelPostResult, { ok: false }>,
): Promise<void> {
  if (!bot || !chatId || result.reason !== "preflight_failed" || !result.preflight) return;
  try {
    await bot.api.sendMessage(chatId, preflightReasonsHtml(result.preflight), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch (error: unknown) {
    console.error("Preflight sabablarini yuborishda xatolik:", error);
  }
}

/** `sendPostToChannel`/`sendVersionToChannel` xatosining qisqa (callback toast) matni. */
function sendFailureText(result: Extract<SendChannelPostResult, { ok: false }>): string {
  switch (result.reason) {
    case "already_sent":
      return "Allaqachon kanalga yuborilgan";
    case "telegram_disabled":
      return "Telegram kanal sozlanmagan";
    case "no_media":
      return "Postda rasm yo'q";
    case "invalid_combo":
      return "Noto'g'ri kombinatsiya";
    case "version_not_found":
      return "Versiya topilmadi";
    case "preflight_failed":
      return result.preflight
        ? `Telegram cheklovi: ${summarizePreflightErrors(result.preflight)}`.slice(0, 190)
        : "Yuborib bo'lmadi";
    default:
      return "Yuborib bo'lmadi";
  }
}

const VARIANT_LABELS: Record<ChannelVariant, string> = {
  s: "Qisqa",
  m: "O'rtacha",
  l: "Batafsil",
  xl: "Maksimal",
};

const MODE_LABELS: Record<ChannelMode, string> = {
  media: "🖼 Rasmli",
  text: "📝 Rasmsiz",
};

/** `cs`/`cc` callback'lari uchun 2 belgili kompakt kod: rejim harfi (`m`|`t`) + uzunlik harfi (`s`|`m`|`l`|`x`, `x` = `xl`). */
function modeVariantCode(mode: ChannelMode, variant: ChannelVariant): string {
  return `${mode === "media" ? "m" : "t"}${variant === "xl" ? "x" : variant}`;
}

/** `modeVariantCode` teskarisi — noto'g'ri/notanish kod bo'lsa `null` (masalan eski/begona callback). */
function parseModeVariantCode(code: string): { mode: ChannelMode; variant: ChannelVariant } | null {
  if (code.length !== 2) return null;
  const modeChar = code[0];
  const variantChar = code[1];
  const mode: ChannelMode | null = modeChar === "m" ? "media" : modeChar === "t" ? "text" : null;
  const variant: ChannelVariant | null =
    variantChar === "s" ? "s" : variantChar === "m" ? "m" : variantChar === "l" ? "l" : variantChar === "x" ? "xl" : null;
  if (!mode || !variant || !isChannelComboValid(mode, variant)) return null;
  return { mode, variant };
}

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

/**
 * "✅ Chop etish"dan keyin — kanalga yuborish rejim+uzunlik tanlash tugmalari.
 * Callback data KOMPAKT: `cs:<m|t><s|m|l|x>:<postId>`. 🖼 qatori FAQAT postda
 * kover yoki band ichida rasm bo'lsa ko'rsatiladi (`hasMedia`).
 */
function channelVariantKeyboard(postId: string, hasMedia: boolean, versions: VersionChoice[] = []): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (hasMedia) {
    kb.text("🖼 O'rtacha", `cs:${modeVariantCode("media", "m")}:${postId}`)
      .text("🖼 Batafsil", `cs:${modeVariantCode("media", "l")}:${postId}`)
      .row();
  }
  kb.text("📝 Qisqa", `cs:${modeVariantCode("text", "s")}:${postId}`)
    .text("📝 O'rtacha", `cs:${modeVariantCode("text", "m")}:${postId}`)
    .text("📝 Batafsil", `cs:${modeVariantCode("text", "l")}:${postId}`)
    .text("📝 Maksimal", `cs:${modeVariantCode("text", "xl")}:${postId}`)
    .row();
  // Maxsus versiyalar: `cv:<versionId>` (3 + 36 = 39 bayt, Telegram chegarasi 64), har biri alohida qatorda.
  for (const version of versions.slice(0, MAX_VERSION_BUTTONS)) {
    kb.text(`✍️ ${truncate(version.name, VERSION_LABEL_MAX)}`, `cv:${version.id}`).row();
  }
  kb.text("Yubormaslik", `cs:no:${postId}`);
  return kb;
}

/** Maxsus versiya tanlangandan keyingi tasdiqlash tugmalari: `cvc:<ok|back|cancel>:<versionId>` (4+len bayt <= 64). */
function versionConfirmKeyboard(versionId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Kanalga yuborish", `cvc:ok:${versionId}`)
    .row()
    .text("🔁 Boshqa variant", `cvc:back:${versionId}`)
    .text("✖️ Bekor", `cvc:cancel:${versionId}`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Versiya id'sidan postId (versiya yo'q yoki id noto'g'ri bo'lsa `null`). */
async function postIdForVersion(versionId: string): Promise<string | null> {
  if (!UUID_RE.test(versionId)) return null;
  const [row] = await db
    .select({ postId: channelPostVersions.postId })
    .from(channelPostVersions)
    .where(eq(channelPostVersions.id, versionId))
    .limit(1);
  return row?.postId ?? null;
}

/** Rejim+uzunlik tanlangandan keyingi tasdiqlash tugmalari. Callback data: `cc:<ok|back|cancel>:<kod|->:<postId>` (`back`/`cancel`da kod "-"). */
function channelConfirmKeyboard(postId: string, mode: ChannelMode, variant: ChannelVariant): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Kanalga yuborish", `cc:ok:${modeVariantCode(mode, variant)}:${postId}`)
    .row()
    .text("🔁 Boshqa variant", `cc:back:-:${postId}`)
    .text("✖️ Bekor", `cc:cancel:-:${postId}`);
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

        // Kanalga yuborish ENDI avtomatik EMAS — shu yerda rejim+uzunlik so'raymiz.
        // 🖼 qatori faqat postda kover yoki band ichida rasm bo'lsa ko'rsatiladi.
        try {
          const mediaCheck = await computeChannelPost(postId, "media", "m");
          const versions = await listVersionChoices(postId);
          await bot!.api.sendMessage(
            message.chat.id,
            `Kanalga yuborish uchun rejim va uzunlikni tanlang: <b>${escapeHtml(result.post.title)}</b>`,
            {
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
              reply_markup: channelVariantKeyboard(postId, mediaCheck.ok, versions),
            },
          );
        } catch (error: unknown) {
          console.error("Kanal varianti tugmalarini yuborishda xatolik:", error);
        }
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

  // "Kanalga yuborish" — rejim+uzunlik tanlash (`cs:<m|t><s|m|l|x>:<postId>` yoki `cs:no:<postId>`).
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    const [prefix, code, postId] = data.split(":");
    if (prefix !== "cs" || !code || !postId) return next();

    if (code === "no") {
      await ctx.answerCallbackQuery({ text: "Kanalga yuborilmadi" });
      return;
    }

    const parsed = parseModeVariantCode(code);
    if (!parsed) return next();
    const { mode, variant } = parsed;

    const computed = await computeChannelPost(postId, mode, variant);
    if (!computed.ok) {
      const text =
        computed.reason === "not_found"
          ? "Post topilmadi"
          : computed.reason === "not_published"
            ? "Post chop etilmagan"
            : computed.reason === "no_media"
              ? "Postda rasm yo'q — 📝 Rasmsiz rejimni tanlang"
              : "Noto'g'ri kombinatsiya";
      await ctx.answerCallbackQuery({ text });
      return;
    }

    await ctx.answerCallbackQuery();
    const chatId = ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id;
    if (!chatId) return;

    try {
      // Server preflight (panel bilan bir xil): o'tmasa sabablar ko'rsatiladi, tugmalar qoladi.
      const check = await computeChannelPreflight(postId, { mode, variant }, { requirePublished: true });
      if (check.ok && !check.preflight.canSend) {
        await bot!.api.sendMessage(chatId, preflightReasonsHtml(check.preflight), {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
        return;
      }
      // AYNAN shu ko'rinish kanalga yuboriladi — admin chatida oldindan namuna.
      await sendChannelPreviewToChat(chatId, computed.data);
      await bot!.api.sendMessage(chatId, "Shu ko'rinishda kanalga yuborilsinmi?", {
        reply_markup: channelConfirmKeyboard(postId, mode, variant),
      });
    } catch (error: unknown) {
      console.error("Kanal oldindan ko'rishni yuborishda xatolik:", error);
      await bot!.api.sendMessage(chatId, "Oldindan ko'rishni tayyorlashda xatolik yuz berdi.");
    }
  });

  // Rejim+uzunlik tasdiqlash (`cc:<ok|back|cancel>:<kod|->:<postId>`).
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    const [prefix, action, code, postId] = data.split(":");
    if (prefix !== "cc" || !action || !postId) return next();

    if (action === "cancel") {
      await ctx.answerCallbackQuery({ text: "Bekor qilindi" });
      return;
    }

    if (action === "back") {
      await ctx.answerCallbackQuery();
      const chatId = ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id;
      if (!chatId) return;
      const mediaCheck = await computeChannelPost(postId, "media", "m");
      const versions = await listVersionChoices(postId);
      await bot!.api.sendMessage(chatId, "Kanalga yuborish uchun rejim va uzunlikni tanlang:", {
        reply_markup: channelVariantKeyboard(postId, mediaCheck.ok, versions),
      });
      return;
    }

    if (action === "ok") {
      const parsed = code ? parseModeVariantCode(code) : null;
      if (!parsed) return next();
      const { mode, variant } = parsed;

      // Idempotentlik: allaqachon yuborilgan bo'lsa `sendPostToChannel`
      // `already_sent` bilan qaytadi — ikkinchi marta yubormaydi.
      const result = await sendPostToChannel(postId, mode, variant);
      if (!result.ok) {
        await ctx.answerCallbackQuery({ text: sendFailureText(result) });
        await reportPreflightFailure(ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id, result);
        return;
      }

      await ctx.answerCallbackQuery({ text: "✅ Kanalga yuborildi" });
      const chatId = ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id;
      if (chatId) {
        const label = `${MODE_LABELS[mode]} · ${VARIANT_LABELS[variant]}`;
        const note = result.messageUrl
          ? `✅ Kanalga yuborildi (${label}): ${result.messageUrl}`
          : `✅ Kanalga yuborildi (${label})`;
        await bot!.api.sendMessage(chatId, note, { link_preview_options: { is_disabled: true } });
      }
      return;
    }

    await ctx.answerCallbackQuery();
  });

  // Maxsus versiya tanlash (`cv:<versionId>`) — preflight -> aniq preview -> tasdiqlash tugmalari.
  bot.on("callback_query:data", async (ctx, next) => {
    const [prefix, versionId] = ctx.callbackQuery.data.split(":");
    if (prefix !== "cv" || !versionId) return next();

    const postId = await postIdForVersion(versionId);
    if (!postId) {
      await ctx.answerCallbackQuery({ text: "Versiya topilmadi" });
      return;
    }

    const computed = await computeChannelVersionPost(postId, versionId);
    if (!computed.ok) {
      await ctx.answerCallbackQuery({
        text:
          computed.reason === "not_published"
            ? "Post chop etilmagan"
            : computed.reason === "no_media"
              ? "Versiyada rasm yo'q"
              : "Versiya topilmadi",
      });
      return;
    }

    await ctx.answerCallbackQuery();
    const chatId = ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id;
    if (!chatId) return;

    try {
      const check = await computeChannelPreflight(postId, { versionId }, { requirePublished: true });
      if (check.ok && !check.preflight.canSend) {
        await bot!.api.sendMessage(chatId, preflightReasonsHtml(check.preflight), {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
        return;
      }
      await sendChannelPreviewToChat(chatId, computed.data);
      await bot!.api.sendMessage(chatId, `Shu ko'rinishda (✍️ ${escapeHtml(truncate(computed.data.versionName ?? "", 60))}) kanalga yuborilsinmi?`, {
        parse_mode: "HTML",
        reply_markup: versionConfirmKeyboard(versionId),
      });
    } catch (error: unknown) {
      console.error("Versiya oldindan ko'rishni yuborishda xatolik:", error);
      await bot!.api.sendMessage(chatId, "Oldindan ko'rishni tayyorlashda xatolik yuz berdi.");
    }
  });

  // Maxsus versiya tasdiqlash (`cvc:<ok|back|cancel>:<versionId>`).
  bot.on("callback_query:data", async (ctx, next) => {
    const [prefix, action, versionId] = ctx.callbackQuery.data.split(":");
    if (prefix !== "cvc" || !action || !versionId) return next();

    if (action === "cancel") {
      await ctx.answerCallbackQuery({ text: "Bekor qilindi" });
      return;
    }

    const postId = await postIdForVersion(versionId);
    if (!postId) {
      await ctx.answerCallbackQuery({ text: "Versiya topilmadi" });
      return;
    }
    const chatId = ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id;

    if (action === "back") {
      await ctx.answerCallbackQuery();
      if (!chatId) return;
      const mediaCheck = await computeChannelPost(postId, "media", "m");
      const versions = await listVersionChoices(postId);
      await bot!.api.sendMessage(chatId, "Kanalga yuborish uchun rejim va uzunlikni tanlang:", {
        reply_markup: channelVariantKeyboard(postId, mediaCheck.ok, versions),
      });
      return;
    }

    if (action === "ok") {
      // Idempotentlik: `sendVersionToChannel` allaqachon yuborilgan bo'lsa `already_sent` qaytaradi.
      const result = await sendVersionToChannel(postId, versionId);
      if (!result.ok) {
        await ctx.answerCallbackQuery({ text: sendFailureText(result) });
        await reportPreflightFailure(chatId, result);
        return;
      }

      await ctx.answerCallbackQuery({ text: "✅ Kanalga yuborildi" });
      if (chatId) {
        const [version] = await db
          .select({ name: channelPostVersions.name })
          .from(channelPostVersions)
          .where(eq(channelPostVersions.id, versionId))
          .limit(1);
        const label = `✍️ ${truncate(version?.name ?? "versiya", 60)}`;
        const note = result.messageUrl
          ? `✅ Kanalga yuborildi (${label}): ${result.messageUrl}`
          : `✅ Kanalga yuborildi (${label})`;
        await bot!.api.sendMessage(chatId, note, { link_preview_options: { is_disabled: true } });
      }
      return;
    }

    await ctx.answerCallbackQuery();
  });
}

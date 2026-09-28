import { timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { config } from "../config.js";
import { getSettings, onSettingsChange, type MergedSettings } from "../lib/settings.js";
import { bot, reconfigureBot } from "./client.js";
import { registerCommands } from "./commands.js";
import { registerCommentBotHandlers, registerCommentEvents } from "./comments.js";
import { registerDiscussionHandlers } from "./discussion.js";
import { registerTelegramPublishing } from "./publish.js";
import { registerReviewEvents, registerReviewHandlers } from "./review.js";

let initialized = false;
/** Faqat bot buyruqlariga ruxsat berilgan Telegram user id'lar — settings o'zgarganda yangilanadi. */
let allowedAdminUserIds: number[] = [];

/** `/` yozilganda Telegram mijozida ko'rinadigan buyruqlar menyusi (o'zbek tavsiflari). */
const BOT_COMMANDS = [
  { command: "start", description: "Botni tanishtirish" },
  { command: "stats", description: "Statistika (umumiy yoki /stats <slug>)" },
  { command: "posts", description: "So'nggi 10 ta post" },
  { command: "pending", description: "Kutilayotgan izohlar" },
  { command: "comments", description: "Izohlarni yoqish/o'chirish: <slug> on|off" },
  { command: "publish", description: "Postni chop etish: <slug>" },
  { command: "unpublish", description: "Postni qoralamaga qaytarish: <slug>" },
  { command: "digest", description: "Kunlik hisobot: yuborish yoki on|off" },
];

/** Yangi Bot instansi yaratilganda (token/apiRoot o'zgarganda) handler'lar qayta ulanadi — eski instansidagi ulanishlar chiqindiga aylanadi. */
function attachHandlersToCurrentBot(): void {
  if (!bot) return;

  // MUHIM: muhokama guruhi handler'lari admin-gate'dan OLDIN ro'yxatga
  // olinadi — aks holda oddiy o'quvchilar (admin bo'lmagani uchun) guruhga
  // yozgan izohlari hech qachon bu yergacha yetib kelmasdi. Bu handler'lar
  // mos kelmagan yangilanishlarni o'zi `next()` orqali pastga o'tkazadi.
  registerDiscussionHandlers();

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !allowedAdminUserIds.includes(userId)) return;
    await next();
  });

  registerCommands();
  // MUHIM: "pr:" (post review) callback'lari "c:" (izoh) prefiksidan OLDIN
  // ro'yxatga olinishi kerak — comments.ts'dagi handler mos kelmasa `next()`
  // chaqirmaydi (early `return`), shu sabab tartib teskari bo'lsa "pr:"
  // callback'lari hech qachon review handler'iga yetib bormas edi.
  registerReviewHandlers();
  registerCommentBotHandlers();
}

async function applySettings(settings: MergedSettings): Promise<void> {
  allowedAdminUserIds = settings.telegram.adminUserIds;

  const token = settings.telegram.enabled ? settings.telegram.botToken : "";
  const { changed } = reconfigureBot(token, settings.telegram.apiRoot);

  if (!bot) {
    if (changed) {
      const reason = settings.telegram.disabledReason;
      console.log(reason ?? "Telegram bot o'chiq (bot token yo'q) — faqat Telegraph mirror ishlaydi (agar sozlansa).");
    }
    return;
  }

  if (changed) attachHandlersToCurrentBot();

  try {
    await bot.api.setWebhook(`${config.API_ORIGIN}/telegram/webhook`, {
      secret_token: settings.telegram.webhookSecret,
      // Mavjudlari (message, callback_query) + edited_message (Telegram izohlari
      // tahrirlanganda `discussion.ts`ga yetib borishi uchun SHART).
      allowed_updates: ["message", "edited_message", "callback_query"],
    });
    // Idempotent — xavfsiz qayta-qayta chaqirilaveradi; xatolik bo'lsa bot ishlashda davom etadi.
    await bot.api.setMyCommands(BOT_COMMANDS);
    if (changed) console.log("Telegram bot ishga tushdi (webhook rejimi) — webhook va buyruqlar o'rnatildi.");
  } catch (error) {
    console.warn("Telegram setWebhook/setMyCommands muvaffaqiyatsiz (e'tiborsiz qoldirildi):", error);
  }
}

/**
 * Bot komandalari va event-listener'larni bir marta ro'yxatga oladi, so'ng
 * `lib/settings.ts`dagi `onSettingsChange`ga obuna bo'ladi — token/webhook
 * secret/admin ro'yxati admin panelda o'zgarganda bot RESTART'SIZ qayta
 * sozlanadi (yangi Bot instansi, yangi webhook, yangi buyruqlar menyusi).
 */
export function initTelegram(): void {
  if (initialized) return;
  initialized = true;

  // post.published/updated/unpublished — Telegram sozlanmagan bo'lsa ham
  // Telegraph mirror ishlashi mumkin (bot shart emas), shu sabab har doim ro'yxatga olinadi.
  registerTelegramPublishing();
  // comment.created / post.submitted — bot instansiga bog'liq emas, shu sabab BIR MARTA
  // ro'yxatga olinadi (bot qayta yaratilganda qayta ro'yxatga olinsa, bildirishnoma bir
  // necha marta yuborilardi).
  registerCommentEvents();
  registerReviewEvents();

  onSettingsChange((settings) => {
    void applySettings(settings);
  });

  void getSettings().then(applySettings);
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * `app.ts` — `POST /telegram/webhook` marshrutini SHART-SHAROITSIZ o'rnatadi
 * (bot boot vaqtida sozlanmagan bo'lsa ham) — chunki admin keyinroq DB orqali
 * bot'ni yoqishi mumkin, restart'siz. Har so'rovda JORIY bot instansi va
 * JORIY webhook secret (`getSettings()`) bilan tekshiriladi.
 */
export function mountTelegramWebhook(app: Hono): void {
  app.post("/telegram/webhook", async (c: Context) => {
    const settings = await getSettings();

    if (!bot || !settings.telegram.enabled) {
      return c.json({ error: "Telegram bot sozlanmagan" }, 404);
    }

    const provided = c.req.header("x-telegram-bot-api-secret-token") ?? "";
    if (!timingSafeEqualStrings(settings.telegram.webhookSecret, provided)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    try {
      await bot.init();
      const update = await c.req.json();
      await bot.handleUpdate(update);
    } catch (error: unknown) {
      console.error("Telegram webhook handleUpdate xatosi:", error);
    }

    return c.json({ ok: true });
  });
}

import { autoRetry } from "@grammyjs/auto-retry";
import { Bot } from "grammy";

/**
 * grammY `Bot` instansi — ESM live-binding (`export let`) tufayli bu modulni
 * import qilgan boshqa fayllar (`commands.ts`, `comments.ts`, `digest.ts`,
 * `publish.ts`, `admin-telegram.ts`) `bot`ni qayta import qilmasdan ham har
 * doim ENG SO'NGGI qiymatni ko'radi — `reconfigureBot()` admin panelda
 * token/webhook secret o'zgarganda shu bindingni qayta belgilaydi (restart shart emas).
 */
export let bot: Bot | null = null;

let currentToken = "";
let currentApiRoot = "";

/** `lib/settings.ts`dagi `onSettingsChange` orqali chaqiriladi — token yoki apiRoot o'zgarganda YANGI Bot instansi yaratadi. */
export function reconfigureBot(token: string, apiRoot: string): { changed: boolean; bot: Bot | null } {
  if (token === currentToken && apiRoot === currentApiRoot) {
    return { changed: false, bot };
  }

  currentToken = token;
  currentApiRoot = apiRoot;

  if (!token) {
    bot = null;
    return { changed: true, bot: null };
  }

  bot = new Bot(token, { client: { apiRoot } });
  // 429 (Too Many Requests) javoblarini avtomatik qayta yuboradi.
  bot.api.config.use(autoRetry());
  return { changed: true, bot };
}

export function requireBot(): Bot {
  if (!bot) throw new Error("Telegram bot sozlanmagan (bot token bo'sh yoki webhook secret yaroqsiz)");
  return bot;
}

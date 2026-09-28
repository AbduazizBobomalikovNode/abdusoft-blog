import "dotenv/config";
import { config, TELEGRAM_ENABLED } from "../src/config.js";
import { bot } from "../src/telegram/client.js";

/**
 * `TELEGRAM_BOT_TOKEN` bilan `${API_ORIGIN}/telegram/webhook`ni Telegram'ga
 * webhook sifatida ro'yxatdan o'tkazadi. Ishga tushirish: `tsx scripts/telegram-set-webhook.ts`.
 */
async function main() {
  if (!TELEGRAM_ENABLED || !bot) {
    console.error("TELEGRAM_BOT_TOKEN sozlanmagan — webhook o'rnatilmadi.");
    process.exitCode = 1;
    return;
  }

  const url = `${config.API_ORIGIN}/telegram/webhook`;

  await bot.api.setWebhook(url, {
    secret_token: config.TELEGRAM_WEBHOOK_SECRET || undefined,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });

  console.log(`Webhook o'rnatildi: ${url}`);
}

main().catch((error: unknown) => {
  console.error("Webhook o'rnatishda xatolik:", error);
  process.exitCode = 1;
});

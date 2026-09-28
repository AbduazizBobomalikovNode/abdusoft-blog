import { Hono } from "hono";
import type { TelegramStatus } from "@blog/shared";
import { requireAdmin } from "../lib/require-admin.js";
import { getSettings } from "../lib/settings.js";
import { bot } from "../telegram/client.js";

export const adminTelegramRoute = new Hono()
  .use("*", requireAdmin)
  .get("/status", async (c) => {
    const settings = await getSettings();

    if (!settings.telegram.enabled || !bot) {
      return c.json({ configured: false } satisfies TelegramStatus);
    }

    const [me, webhookInfo] = await Promise.all([
      bot.api.getMe().catch(() => null),
      bot.api.getWebhookInfo().catch(() => null),
    ]);

    const status: TelegramStatus = {
      configured: true,
      me: me ? { id: me.id, username: me.username ?? null, firstName: me.first_name } : null,
      webhook: webhookInfo
        ? {
            url: webhookInfo.url ?? "",
            hasCustomCertificate: webhookInfo.has_custom_certificate,
            pendingUpdateCount: webhookInfo.pending_update_count,
            lastErrorDate: webhookInfo.last_error_date,
            lastErrorMessage: webhookInfo.last_error_message,
          }
        : null,
      channel: settings.telegram.channelId || null,
      adminChat: settings.telegram.adminChatId || null,
    };

    return c.json(status);
  })
  .post("/test", async (c) => {
    const settings = await getSettings();
    if (!settings.telegram.enabled || !bot) return c.json({ error: "Telegram sozlanmagan" }, 400);
    if (!settings.telegram.adminChatId) return c.json({ error: "Admin chat ID sozlanmagan" }, 400);

    await bot.api.sendMessage(settings.telegram.adminChatId, "Salom! Bot ulandi ✅");
    return c.json({ ok: true });
  });

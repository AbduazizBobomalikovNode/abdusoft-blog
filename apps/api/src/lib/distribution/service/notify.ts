import { bot } from "../../../telegram/client.js";
import { escapeHtml } from "../../../telegram/format.js";
import { getSettings } from "../../settings.js";

/**
 * Egasiga mavjud admin Telegram chatiga xabar. Bot/chat sozlanmagan bo'lsa jimgina `false` (hech narsa yuborilmadi).
 * Xato tashlanmaydi — `"error"` qaytadi (chaqiruvchi qayta urinishni hal qiladi). Matnda token/sir bo'lmaydi.
 */
export async function notifyOwner(text: string): Promise<"sent" | "skipped" | "error"> {
  try {
    const settings = await getSettings();
    if (!bot || !settings.telegram.enabled || !settings.telegram.adminChatId) return "skipped";
    await bot.api.sendMessage(settings.telegram.adminChatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    return "sent";
  } catch (error: unknown) {
    console.error("Egasiga tarqatish bildirishnomasi yuborilmadi:", error instanceof Error ? error.message : "noma'lum xato");
    return "error";
  }
}

export { escapeHtml };

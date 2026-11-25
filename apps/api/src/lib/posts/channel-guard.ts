import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { telegramRefs } from "../../db/schema.js";
import type { Actor } from "./types.js";

/**
 * Telegram kanal xabariga tegish huquqi: panel/tizim aktyorlari — ha (avvalgidek); ulangan yordamchi — faqat `channels:send`
 * ruxsati berilgan bo'lsa. Ruxsatsiz yordamchi sayt postini o'zgartira oladi, lekin kanalda allaqachon turgan xabarni
 * tahrirlay yoki o'chira olmaydi.
 */
export function actorMayTouchChannel(actor: Actor): boolean {
  return !actor.mcp || actor.mcp.channelsSend === true;
}

/** Postning kanalga yuborilgan (hozir turgan) xabari bormi? */
export async function postHasChannelMessage(postId: string): Promise<boolean> {
  const [ref] = await db
    .select({ id: telegramRefs.channelMessageId, ids: telegramRefs.channelMessageIds })
    .from(telegramRefs)
    .where(eq(telegramRefs.postId, postId))
    .limit(1);
  return !!ref && (ref.id != null || (ref.ids?.length ?? 0) > 0);
}

export const CHANNEL_REMOVAL_REFUSED =
  "Bu post Telegram kanalga yuborilgan; uni saytdan olib tashlash kanal xabarini ham o'chiradi. Buning uchun 'kanalga yuborish' ruxsati kerak";

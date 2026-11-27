import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { posts } from "../db/schema.js";

/** Panelda ko'rsatiladigan oxirgi xato matnining eng ko'p uzunligi. */
export const CHANNEL_LAST_ERROR_MAX = 500;

/**
 * Xato matnini saqlash/ko'rsatish uchun tozalaydi: bot tokenlari (`123456:ABC...`, `bot<token>` URL'lari), `Bearer`/`token=` qiymatlari
 * yashiriladi, bo'shliqlar siqiladi, uzunligi cheklanadi. Bo'sh qolsa — umumiy matn.
 */
export function sanitizeChannelError(raw: unknown): string {
  const text = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : "Noma'lum xato";
  const cleaned = text
    .replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, "[token]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [token]")
    .replace(/\b(token|secret|api[_-]?key|authorization|password)\s*[=:]\s*\S+/gi, "$1=[yashirildi]")
    .replace(/\s+/g, " ")
    .trim();
  const safe = cleaned || "Noma'lum xato";
  return safe.length > CHANNEL_LAST_ERROR_MAX ? `${safe.slice(0, CHANNEL_LAST_ERROR_MAX - 1)}…` : safe;
}

/**
 * Kanalga yuborishning muvaffaqiyatsiz urinishini postga yozadi (`channel_last_error` + `_at`). Yordamchi yozuv: xato bo'lsa
 * log qilinadi, yuborish oqimini BUZMAYDI (qayta urinishlar/xabarnoma o'zgarmaydi).
 */
export async function recordChannelError(postId: string, raw: unknown, now: Date = new Date()): Promise<void> {
  try {
    await db.update(posts).set({ channelLastError: sanitizeChannelError(raw), channelLastErrorAt: now }).where(eq(posts.id, postId));
  } catch (error: unknown) {
    console.error(`Kanal xatosini yozib bo'lmadi (post ${postId}):`, error instanceof Error ? error.message : "noma'lum xato");
  }
}

/** Muvaffaqiyatli yuborishdan keyin oxirgi xatoni tozalaydi. */
export async function clearChannelError(postId: string): Promise<void> {
  try {
    await db.update(posts).set({ channelLastError: null, channelLastErrorAt: null }).where(eq(posts.id, postId));
  } catch (error: unknown) {
    console.error(`Kanal xatosini tozalab bo'lmadi (post ${postId}):`, error instanceof Error ? error.message : "noma'lum xato");
  }
}

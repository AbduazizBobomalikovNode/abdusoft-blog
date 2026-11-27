import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { posts } from "../db/schema.js";

/** Panelda ko'rsatiladigan oxirgi xato matnining eng ko'p uzunligi (Unicode belgilarda). */
export const CHANNEL_LAST_ERROR_MAX = 500;

/** Maxfiy qiymatga o'xshaydimi: kamida 16 belgi, base64/URL-xavfsiz alifbo (oddiy so'z/jumla emas). */
const SECRET_LIKE = "[A-Za-z0-9._~+/=-]{16,}";

/**
 * Xato matnini saqlash/ko'rsatish uchun tozalaydi: bot tokenlari (`123456:ABC...`, `bot<token>` URL'lari), maxfiyga o'xshash
 * `Bearer`/`Basic` qiymatlari va `token: <uzun qiymat>` yashiriladi; `password|secret|api_key|authorization` dan keyingi qiymat (`:` yoki `=`) uzunligidan qat'i nazar yashiriladi (oddiy so'zlar — masalan "Basic auth failed", "token: expired" —
 * tegilmaydi); `kalit=qiymat` ko'rinishi (so'rov parametri) har doim yashiriladi. Bo'shliqlar siqiladi, uzunligi Unicode belgilar
 * bo'yicha cheklanadi. Bo'sh qolsa — umumiy matn.
 */
export function sanitizeChannelError(raw: unknown): string {
  const text = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : "Noma'lum xato";
  const cleaned = text
    .replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, "[token]")
    .replace(new RegExp(`\\b(Bearer|Basic)\\s+${SECRET_LIKE}`, "gi"), "$1 [token]")
    .replace(/\b(token|secret|api[_-]?key|authorization|password)\s*=\s*\S+/gi, "$1=[yashirildi]")
    .replace(/\b(password|secret|api[_-]?key|authorization)\s*:\s*\S+/gi, "$1: [yashirildi]")
    .replace(new RegExp(`\\btoken\\s*:\\s*${SECRET_LIKE}`, "gi"), "token: [yashirildi]")
    .replace(/\s+/g, " ")
    .trim();
  const safe = cleaned || "Noma'lum xato";
  const points = Array.from(safe);
  return points.length > CHANNEL_LAST_ERROR_MAX ? `${points.slice(0, CHANNEL_LAST_ERROR_MAX - 1).join("")}…` : safe;
}

/**
 * Kanalga yuborishning muvaffaqiyatsiz urinishini postga yozadi (`channel_last_error` + `_at`). Yordamchi yozuv: xato bo'lsa
 * log qilinadi, yuborish oqimini BUZMAYDI (qayta urinishlar/xabarnoma o'zgarmaydi). `onlyIfPublished` — post hamon chop etilgan bo'lsa.
 */
export async function recordChannelError(postId: string, raw: unknown, now: Date = new Date(), opts: { onlyIfPublished?: boolean } = {}): Promise<void> {
  try {
    await db
      .update(posts)
      .set({ channelLastError: sanitizeChannelError(raw), channelLastErrorAt: now })
      .where(opts.onlyIfPublished ? and(eq(posts.id, postId), eq(posts.status, "published")) : eq(posts.id, postId));
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

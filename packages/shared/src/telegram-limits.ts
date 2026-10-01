/**
 * Telegram Bot API chegaralari — rasmiy hujjatdan TEKSHIRILGAN qiymatlar.
 * Manba: https://core.telegram.org/bots/api (2026-10-01 da tekshirilgan).
 *
 * - `sendPhoto` / `InputMediaPhoto`: "The photo must be at most 10 MB in size.
 *   The photo's width and height must not exceed 10000 in total. Width and
 *   height ratio must be at most 20."
 * - `sendPhoto.caption` / `InputMediaPhoto.caption`: "0-1024 characters after
 *   entities parsing".
 * - `sendMessage.text`: "1-4096 characters after entities parsing".
 * - `sendMediaGroup.media`: "must include 2-10 items".
 * - "Sending files": multipart/form-data — "10 MB max size for photos, 50 MB
 *   for other files"; HTTP URL orqali — "5 MB max size for photos and 20 MB
 *   max for other types of content" (biz URL yubormaymiz, faylni o'zimiz yuklaymiz).
 *   Hujjatda albom uchun JAMI hajm chegarasi KO'RSATILMAGAN — faqat har bir fayl uchun.
 * - "HTML style": b/strong, i/em, u/ins, s/strike/del, span.tg-spoiler/tg-spoiler,
 *   a, code, pre, blockquote (+ tg-emoji, tg-time); biz faqat quyidagi ro'yxatdan foydalanamiz.
 */
export const TELEGRAM_LIMITS = {
  /** sendPhoto: rasm fayli hajmi (multipart) — baytlarda. */
  photoMaxBytes: 10 * 1024 * 1024,
  /** sendPhoto: kenglik + balandlik yig'indisi. */
  photoMaxWidthPlusHeight: 10_000,
  /** sendPhoto: katta tomon / kichik tomon nisbati. */
  photoMaxAspectRatio: 20,
  /** sendMediaGroup: albomdagi elementlar soni (min/max). */
  mediaGroupMinItems: 2,
  mediaGroupMaxItems: 10,
  /** Caption (sendPhoto / InputMediaPhoto): entity'lar parse qilingandan keyingi belgilar soni. */
  captionMaxChars: 1024,
  /** sendMessage matni: entity'lar parse qilingandan keyingi belgilar soni (min 1). */
  textMaxChars: 4096,
  textMinChars: 1,
  /** multipart/form-data: rasm uchun / boshqa fayllar uchun (hujjat: "10 MB max size for photos, 50 MB for other files"). */
  multipartPhotoMaxBytes: 10 * 1024 * 1024,
  multipartOtherMaxBytes: 50 * 1024 * 1024,
} as const;

/** Biz yuboradigan HTML'da ruxsat etilgan Telegram teglari ("HTML style" bo'limi). */
export const TELEGRAM_ALLOWED_HTML_TAGS = ["b", "i", "u", "s", "code", "pre", "a", "blockquote", "tg-spoiler"] as const;

/** Bizning tomondagi (Telegram emas) chegaralar — preflight ogohlantirishlari uchun. */
export const CHANNEL_MEDIA_POLICY = {
  /** Yuborishdan oldin uzun tomon shu qiymatgacha kichraytiriladi. */
  maxSidePx: 2560,
  /** Shundan kichik tomon — "juda kichik rasm" ogohlantirishi. */
  tinySidePx: 320,
  /** Albom jami yuklanadigan hajmi shundan oshsa — ogohlantirish. */
  totalWarnBytes: 40 * 1024 * 1024,
  /** Bizning yuklab olish chegaramiz (original fayl) — shundan katta bo'lsa rasm olinmaydi. */
  fetchMaxBytes: 30 * 1024 * 1024,
} as const;

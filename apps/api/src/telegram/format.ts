/**
 * Telegram HTML parse_mode uchun escape va matn yordamchilari.
 * https://core.telegram.org/bots/api#html-style
 */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** `<a href>` ichidagi atribut qiymati uchun — qo'shtirnoqni ham escape qiladi. */
export function escapeHtmlAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/** HTML teglarni olib tashlab, matnni Telegram xabari uchun qisqartiradi (izoh matni odatda oddiy matn). */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Teg nomlaridan Telegram hashtag ro'yxati yasaydi (bo'shliq/tire olib tashlanadi, lotincha kichik harf). */
export function tagsToHashtags(tagNames: string[]): string {
  return tagNames
    .map((name) =>
      name
        .toLowerCase()
        .replace(/['’‘`]/g, "")
        .replace(/[^a-z0-9а-яёʻʼ]+/gi, "")
        .trim(),
    )
    .filter(Boolean)
    .map((tag) => `#${tag}`)
    .join(" ");
}

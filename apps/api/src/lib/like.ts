/**
 * `ILIKE '%...%'` naqshiga qo'yishdan oldin foydalanuvchi kiritgan matnni
 * qochiriladi — `%`, `_` SQL LIKE maxsus belgilari va `\` qochirish belgisi
 * o'zi ham qochirilishi kerak, aks holda qidiruv so'zi orqali (masalan `_`
 * bitta belgiga mos keladi) natijalarni buzish yoki keraksiz keng qidiruvga
 * olib kelishi mumkin.
 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}

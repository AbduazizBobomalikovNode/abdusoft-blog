/** RSS/XML chiqishida foydalaniladigan kichik yordamchi funksiyalar (test qilinishi uchun alohida modulga chiqarilgan). */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** CDATA ichida so'zma-so'z `]]>` uchrasa, blok yakunlanib qoladi — shu sabab yangi CDATA bilan bo'lib qo'yamiz. */
export function escapeCdata(value: string): string {
  return value.replace(/]]>/g, "]]]]><![CDATA[>");
}

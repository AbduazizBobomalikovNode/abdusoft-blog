/**
 * `DISTRIBUTION_ENABLED=true` bo'lganda tarqatish modullari ishga tushishda import qilinadi. Import yiqilsa — jarayon BAYROQ YOQIQ
 * holda ishlay olmaydi: xato qayta tashlanadi (API ishga tushmaydi; deploy'dagi health check avtomatik orqaga qaytaradi — bu ataylab
 * shunday). Bu yordamchi faqat sababni o'qiladigan qiladi: bitta aniq log qatori (modul + bayroq), keyin xato o'zgarmasdan tashlanadi.
 */
export async function loadDistributionModule<T>(moduleName: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "noma'lum xato";
    console.error(`[distribution] DISTRIBUTION_ENABLED=true, lekin "${moduleName}" modulini yuklab bo'lmadi: ${reason}. API ishga tushmaydi (deploy orqaga qaytariladi). Bayroqni o'chirish (DISTRIBUTION_ENABLED=false) bu qismni yuklamaydi.`);
    throw error;
  }
}

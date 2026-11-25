/**
 * READ-ONLY texnik xizmat skripti: bazadagi HAR BIR post, revision va "Haqida" hujjatini admin panel darajasidagi
 * tekshiruvchidan (`validatePanelDocument`) o'tkazadi. FAQAT sonlarni va rad etiladigan yozuvlarning id'larini chiqaradi
 * (kontent, sarlavha, sabab matni — HECH QACHON). Hech narsa yozmaydi.
 *
 *   DATABASE_URL=... pnpm --filter @blog/api exec tsx scripts/check-stored-docs.ts
 *
 * Chiqish kodi: 0 — hammasi o'tdi; 1 — kamida bitta hujjat rad etilardi (qoida noto'g'ri: yumshatish kerak); 2 — xato.
 */
import "dotenv/config";

async function main() {
  const { db } = await import("../src/db/index.js");
  const { checkStoredDocs } = await import("../src/lib/content/stored-docs-check.js");
  const report = await checkStoredDocs(db);
  console.log(`checked: posts=${report.counts.posts} revisions=${report.counts.revisions} about=${report.counts.about}`);
  console.log(`rejected: ${report.failures.length}`);
  for (const f of report.failures) console.log(`  ${f.kind} ${f.id}`);
  process.exit(report.failures.length === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error("check-stored-docs failed:", error instanceof Error ? error.name : "error");
  process.exit(2);
});

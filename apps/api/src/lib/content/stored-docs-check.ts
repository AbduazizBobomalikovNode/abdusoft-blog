import { asc, gt } from "drizzle-orm";
import type { Database } from "../../db/index.js";
import { postRevisions, posts, siteSettings } from "../../db/schema.js";
import { validatePanelDocument } from "./validate.js";

const PAGE = 100;

export interface StoredDocsReport {
  counts: { posts: number; revisions: number; about: number };
  failures: { kind: "post" | "revision" | "about"; id: string }[];
}

/** Faqat O'QIYDI. Hisobotda kontent yo'q: sonlar va rad etiladigan yozuvlarning id'lari. */
export async function checkStoredDocs(db: Database): Promise<StoredDocsReport> {
  const report: StoredDocsReport = { counts: { posts: 0, revisions: 0, about: 0 }, failures: [] };

  let after: string | null = null;
  for (;;) {
    const rows = await db.select({ id: posts.id, doc: posts.contentJson }).from(posts).where(after ? gt(posts.id, after) : undefined).orderBy(asc(posts.id)).limit(PAGE);
    if (rows.length === 0) break;
    for (const row of rows) {
      report.counts.posts++;
      if (!validatePanelDocument(row.doc).ok) report.failures.push({ kind: "post", id: row.id });
    }
    after = rows[rows.length - 1]!.id;
  }

  after = null;
  for (;;) {
    const rows = await db.select({ id: postRevisions.id, doc: postRevisions.contentJson }).from(postRevisions).where(after ? gt(postRevisions.id, after) : undefined).orderBy(asc(postRevisions.id)).limit(PAGE);
    if (rows.length === 0) break;
    for (const row of rows) {
      report.counts.revisions++;
      if (!validatePanelDocument(row.doc).ok) report.failures.push({ kind: "revision", id: row.id });
    }
    after = rows[rows.length - 1]!.id;
  }

  for (const row of await db.select().from(siteSettings)) {
    if (row.key !== "about") continue;
    report.counts.about++;
    const value = row.value as { json?: unknown } | null;
    if (!validatePanelDocument(value?.json).ok) report.failures.push({ kind: "about", id: "about" });
  }
  return report;
}

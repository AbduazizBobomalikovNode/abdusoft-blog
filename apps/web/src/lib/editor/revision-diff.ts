import type { PostRevision } from "@blog/shared";

export type RevisionField = "title" | "slug" | "excerpt" | "tags" | "cover" | "content" | "settings";

export const REVISION_FIELD_LABELS: Record<RevisionField, string> = {
  title: "Sarlavha",
  slug: "Havola (slug)",
  excerpt: "Qisqa tavsif",
  tags: "Teglar",
  cover: "Muqova rasmi",
  content: "Matn",
  settings: "Sozlamalar",
};

/** Kalitlari tartiblangan JSON satri — `jsonb` kalit tartibini o'zgartirishi taqqoslashni buzmasin. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Joriy (saqlangan) postning taqqoslanadigan qismi. */
export interface CurrentPostFields {
  title: string;
  slug: string;
  excerpt: string | null;
  coverUrl: string | null;
  tagSlugs: string[];
  contentJson: unknown;
  settings: Record<string, unknown>;
}

/**
 * Revision joriy versiyadan qaysi maydonlar bilan farq qilishini aytadi. Revision'dagi `settings` qisman bo'lishi mumkin
 * (eski qatorlar) — faqat revision'da BOR kalitlar solishtiriladi.
 */
export function changedFields(revision: PostRevision, current: CurrentPostFields): RevisionField[] {
  const out: RevisionField[] = [];
  if (revision.title !== current.title) out.push("title");
  if (revision.slug !== current.slug) out.push("slug");
  if ((revision.excerpt ?? null) !== (current.excerpt ?? null)) out.push("excerpt");
  if ([...revision.tagSlugs].sort().join("|") !== [...current.tagSlugs].sort().join("|")) out.push("tags");
  if ((revision.coverUrl ?? null) !== (current.coverUrl ?? null)) out.push("cover");
  if (stableStringify(revision.contentJson) !== stableStringify(current.contentJson)) out.push("content");
  const revisionSettings = (revision.settings ?? {}) as Record<string, unknown>;
  const settingsDiffer = Object.keys(revisionSettings).some(
    (key) => stableStringify(revisionSettings[key]) !== stableStringify(current.settings[key]),
  );
  if (settingsDiffer) out.push("settings");
  return out;
}

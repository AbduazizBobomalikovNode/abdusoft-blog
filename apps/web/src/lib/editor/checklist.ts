import type { JSONContent } from "@tiptap/core";
import { docPlainText } from "@blog/shared";
import { docHintTexts } from "@blog/shared";

export type FixTarget = "title" | "body" | "cover" | "excerpt" | "tags" | "slug" | "imageAlt" | "emptyHeading" | "hints";

export interface ChecklistItem {
  id: FixTarget;
  /** `block` — chop etishni to'xtatadi; `warn` — faqat ogohlantirish. */
  severity: "block" | "warn";
  ok: boolean;
  label: string;
  detail?: string;
  /** "Tuzatish" bosilganda qayerga o'tish. */
  fix?: FixTarget;
}

export interface ChecklistInput {
  title: string;
  slug: string;
  doc: JSONContent | null | undefined;
  coverUrl: string | null;
  excerpt: string;
  tagCount: number;
}

const DEFAULT_TITLE = "Nomsiz post";

function walk(node: JSONContent, visit: (n: JSONContent) => void): void {
  visit(node);
  (node.content ?? []).forEach((c) => walk(c, visit));
}

export function countImagesWithoutAlt(doc: JSONContent | null | undefined): number {
  let n = 0;
  if (doc) walk(doc, (node) => {
    if (node.type === "image" && !String((node.attrs as { alt?: string } | undefined)?.alt ?? "").trim()) n++;
  });
  return n;
}

export function countEmptyHeadings(doc: JSONContent | null | undefined): number {
  let n = 0;
  if (doc) walk(doc, (node) => {
    if (node.type === "heading" && docPlainText(node) === "") n++;
  });
  return n;
}

function hasMedia(doc: JSONContent | null | undefined): boolean {
  let found = false;
  if (doc) walk(doc, (node) => {
    if (node.type === "image" || node.type === "table") found = true;
  });
  return found;
}

export function isReadableSlug(slug: string): boolean {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return false;
  if (slug.length > 80 || /^\d+$/.test(slug)) return false;
  return !/^nomsiz-post(-\d+)?$/.test(slug);
}

export function buildPublishChecklist(input: ChecklistInput): ChecklistItem[] {
  const text = docPlainText(input.doc);
  const titleOk = input.title.trim().length > 0 && input.title.trim() !== DEFAULT_TITLE;
  const bodyOk = text.length > 0 || hasMedia(input.doc);
  const noAlt = countImagesWithoutAlt(input.doc);
  const emptyH = countEmptyHeadings(input.doc);
  const hints = docHintTexts(input.doc).length;
  const excerptOk = input.excerpt.trim().length > 0 || text.length > 0;

  return [
    { id: "title", severity: "block", ok: titleOk, label: "Sarlavha bor", fix: titleOk ? undefined : "title" },
    { id: "body", severity: "block", ok: bodyOk, label: "Matn bo'sh emas", fix: bodyOk ? undefined : "body" },
    { id: "cover", severity: "warn", ok: !!input.coverUrl, label: "Muqova rasm tanlangan", fix: input.coverUrl ? undefined : "cover" },
    {
      id: "excerpt",
      severity: "warn",
      ok: excerptOk,
      label: input.excerpt.trim() ? "Qisqacha tavsif yozilgan" : "Qisqacha tavsif (matndan avtomatik olinadi)",
      fix: excerptOk ? undefined : "excerpt",
    },
    { id: "tags", severity: "warn", ok: input.tagCount > 0, label: "Kamida 1 ta teg", fix: input.tagCount > 0 ? undefined : "tags" },
    {
      id: "imageAlt",
      severity: "warn",
      ok: noAlt === 0,
      label: "Rasmlarda alt matn bor",
      detail: noAlt > 0 ? `${noAlt} ta rasmda alt matn yo'q` : undefined,
      fix: noAlt > 0 ? "imageAlt" : undefined,
    },
    {
      id: "emptyHeading",
      severity: "warn",
      ok: emptyH === 0,
      label: "Bo'sh sarlavhalar yo'q",
      detail: emptyH > 0 ? `${emptyH} ta bo'sh sarlavha` : undefined,
      fix: emptyH > 0 ? "emptyHeading" : undefined,
    },
    {
      id: "hints",
      severity: "warn",
      ok: hints === 0,
      label: "Shablon maslahat matnlari qolmagan",
      detail: hints > 0 ? `${hints} ta maslahat matni hali o'zgartirilmagan` : undefined,
      fix: hints > 0 ? "hints" : undefined,
    },
    {
      id: "slug",
      severity: "warn",
      ok: isReadableSlug(input.slug),
      label: "Slug o'qiladigan",
      detail: isReadableSlug(input.slug) ? undefined : "faqat kichik lotin harflar, raqamlar va tire",
      fix: isReadableSlug(input.slug) ? undefined : "slug",
    },
  ];
}

export function hasBlockingIssue(items: ChecklistItem[]): boolean {
  return items.some((i) => i.severity === "block" && !i.ok);
}

import type { Editor } from "@tiptap/core";
import type { LucideIcon } from "lucide-react";
import { Code2, Heading2, Heading3, ImageIcon, Info, Lightbulb, List, ListOrdered, Minus, Pilcrow, Quote, Table2, TriangleAlert } from "lucide-react";
import { toggleCallout } from "./callout";
import { IMAGE_PICKER_EVENT } from "./events";

/** "/" menyusi, "+" tugmasi va asboblar panelidagi "Qo'shish" menyusi uchun yagona blok ro'yxati. */
export interface BlockItem {
  id: string;
  title: string;
  description: string;
  /** Qidiruv uchun o'zbek + ingliz kalit so'zlar. */
  keywords: string[];
  icon: LucideIcon;
  /** Faqat sxemada shu tugun bo'lsa ko'rsatiladi. */
  requires?: string;
  run: (editor: Editor) => void;
}


export const BLOCK_ITEMS: BlockItem[] = [
  { id: "paragraph", title: "Matn", description: "Oddiy abzats", keywords: ["matn", "abzats", "paragraph", "text", "p"], icon: Pilcrow, run: (e) => void e.chain().focus().setParagraph().run() },
  { id: "h2", title: "Sarlavha 2", description: "Katta bo'lim sarlavhasi", keywords: ["sarlavha", "heading", "h2", "bo'lim", "title"], icon: Heading2, run: (e) => void e.chain().focus().setNode("heading", { level: 2 }).run() },
  { id: "h3", title: "Sarlavha 3", description: "Kichik bo'lim sarlavhasi", keywords: ["sarlavha", "heading", "h3", "kichik"], icon: Heading3, run: (e) => void e.chain().focus().setNode("heading", { level: 3 }).run() },
  { id: "bullet", title: "Ro'yxat", description: "Nuqtali ro'yxat", keywords: ["royxat", "ro'yxat", "list", "bullet", "ul"], icon: List, run: (e) => void e.chain().focus().toggleBulletList().run() },
  { id: "ordered", title: "Raqamli ro'yxat", description: "1, 2, 3 ko'rinishidagi ro'yxat", keywords: ["raqamli", "royxat", "ro'yxat", "ordered", "numbered", "ol"], icon: ListOrdered, run: (e) => void e.chain().focus().toggleOrderedList().run() },
  { id: "quote", title: "Iqtibos", description: "Boshqadan olingan fikr", keywords: ["iqtibos", "quote", "blockquote", "sitata"], icon: Quote, run: (e) => void e.chain().focus().toggleBlockquote().run() },
  { id: "callout-info", title: "Callout — ma'lumot (ℹ️)", description: "Ma'lumot beruvchi quti", keywords: ["callout", "malumot", "ma'lumot", "info", "izoh", "eslatma"], icon: Info, run: (e) => toggleCallout(e, "info") },
  { id: "callout-warning", title: "Callout — ogohlantirish (⚠️)", description: "Diqqat talab qiladigan quti", keywords: ["callout", "ogohlantirish", "warning", "diqqat", "xavf"], icon: TriangleAlert, run: (e) => toggleCallout(e, "warning") },
  { id: "callout-tip", title: "Callout — maslahat (💡)", description: "Foydali maslahat qutisi", keywords: ["callout", "maslahat", "tip", "lifehack", "g'oya"], icon: Lightbulb, run: (e) => toggleCallout(e, "tip") },
  { id: "code", title: "Kod bloki", description: "Kod, tilni tanlash mumkin", keywords: ["kod", "code", "codeblock", "dastur", "```"], icon: Code2, run: (e) => void e.chain().focus().setNode("codeBlock").run() },
  { id: "image", title: "Rasm", description: "Yuklash yoki tashlash", keywords: ["rasm", "image", "foto", "surat", "img", "picture"], icon: ImageIcon, requires: "image", run: () => void window.dispatchEvent(new CustomEvent(IMAGE_PICKER_EVENT)) },
  { id: "table", title: "Jadval", description: "3×3 jadval, sarlavha qatori bilan", keywords: ["jadval", "table", "grid", "ustun", "qator"], icon: Table2, requires: "table", run: (e) => void e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { id: "divider", title: "Ajratgich", description: "Gorizontal chiziq", keywords: ["ajratgich", "divider", "hr", "chiziq", "separator", "line"], icon: Minus, run: (e) => void e.chain().focus().setHorizontalRule().run() },
];

export function availableBlockItems(editor: Editor): BlockItem[] {
  return BLOCK_ITEMS.filter((item) => !item.requires || !!editor.schema.nodes[item.requires]);
}

/** Qidiruv: sarlavha/kalit so'z boshlanishi yuqoriroq, so'ng "ichida bor". */
export function filterBlockItems(items: BlockItem[], query: string): BlockItem[] {
  const q = query.trim().toLowerCase().replace(/[ʻʼ’‘`]/g, "'");
  if (!q) return items;
  const score = (item: BlockItem): number => {
    const title = item.title.toLowerCase();
    if (title.startsWith(q)) return 3;
    if (item.keywords.some((k) => k.startsWith(q))) return 2;
    if (title.includes(q) || item.keywords.some((k) => k.includes(q))) return 1;
    return 0;
  };
  return items
    .map((item) => ({ item, s: score(item) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.item);
}

import type { ContentNode as JSONContent } from "./content-stats.js";

export interface OutlineItem {
  /** H2/H3 sarlavhalar orasidagi tartib raqami (DOM'dagi `h2, h3` ro'yxati bilan mos). */
  index: number;
  level: 2 | 3;
  text: string;
}

function textOf(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(textOf).join("");
}

/** Mundarija: hujjatdagi H2/H3 sarlavhalar, hujjat tartibida. */
export function extractOutline(doc: JSONContent | null | undefined): OutlineItem[] {
  const items: OutlineItem[] = [];
  const walk = (node: JSONContent) => {
    if (node.type === "heading") {
      const level = Number((node.attrs as { level?: number } | undefined)?.level);
      if (level === 2 || level === 3) items.push({ index: items.length, level, text: textOf(node).trim() });
      return;
    }
    (node.content ?? []).forEach(walk);
  };
  if (doc) walk(doc);
  return items;
}

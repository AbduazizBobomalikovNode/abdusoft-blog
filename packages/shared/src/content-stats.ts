/**
 * Tiptap hujjatidan so'z soni / o'qish vaqti — server (`renderPost`) qoidasi bilan bir xil:
 * matn bo'shliqlar bo'yicha bo'linadi, o'qish tezligi 200 so'z/daqiqa, kamida 1 daqiqa.
 * Server tomoni HTML'dan matn ajratadi; bu yerda blok tugunlari orasiga bo'shliq qo'yiladi (xuddi shu natija).
 */
export const WORDS_PER_MINUTE = 200;

export interface StatsNode {
  type?: string;
  text?: string;
  content?: StatsNode[];
}

/** Tiptap hujjat tuguni (JSON) — `@tiptap/core` ga bog'liq bo'lmagan yengil tur. */
export interface ContentNode extends StatsNode {
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: ContentNode[];
}

function collect(node: StatsNode, out: string[]): void {
  if (node.type === "text") {
    out.push(node.text ?? "");
    return;
  }
  if (node.type === "hardBreak") {
    out.push(" ");
    return;
  }
  out.push(" ");
  for (const child of node.content ?? []) collect(child, out);
  out.push(" ");
}

/** Hujjat matni, bo'shliqlar yig'ilgan holda. */
export function docPlainText(doc: StatsNode | null | undefined): string {
  if (!doc) return "";
  const out: string[] = [];
  collect(doc, out);
  return out.join("").replace(/\s+/g, " ").trim();
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

export function readingMinutes(words: number): number {
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
}

export interface DocStats {
  words: number;
  characters: number;
  readingMinutes: number;
}

export function docStats(doc: StatsNode | null | undefined): DocStats {
  const text = docPlainText(doc);
  const words = countWords(text);
  return { words, characters: text.length, readingMinutes: readingMinutes(words) };
}

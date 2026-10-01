import { TELEGRAM_ALLOWED_HTML_TAGS } from "@blog/shared";
import { CUSTOM_MARK_TAGS, inlineHtml, type TiptapNode } from "./channel-post.js";

/**
 * Maxsus kanal versiyalari uchun: cheklangan Tiptap JSON <-> Telegram HTML,
 * ko'rinadigan uzunlik va HTML tekshiruvi. Avtomatik variantlar
 * (`channel-post.ts`) shu yerdan foydalanmaydi.
 */

const ALLOWED_NODES = new Set([
  "doc",
  "paragraph",
  "text",
  "hardBreak",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
]);
const ALLOWED_MARKS = new Set(["bold", "italic", "underline", "strike", "code", "link"]);

export function emptyDoc(): TiptapNode {
  return { type: "doc", content: [] };
}

/** Hujjat faqat ruxsat etilgan tugun/belgilardan iboratmi? Xato bo'lsa — o'zbekcha sabab, aks holda `null`. */
export function validateRestrictedDoc(doc: unknown): string | null {
  if (!doc || typeof doc !== "object") return "Kontent Tiptap hujjati bo'lishi kerak";
  const root = doc as TiptapNode;
  if (root.type !== "doc") return "Kontent Tiptap hujjati (type: doc) bo'lishi kerak";
  let error: string | null = null;
  const walk = (node: TiptapNode): void => {
    if (error) return;
    if (!node.type || !ALLOWED_NODES.has(node.type)) {
      error = `Qo'llab-quvvatlanmaydigan tugun: ${String(node.type)}`;
      return;
    }
    for (const mark of node.marks ?? []) {
      if (!ALLOWED_MARKS.has(mark.type)) {
        error = `Qo'llab-quvvatlanmaydigan belgi: ${mark.type}`;
        return;
      }
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(root);
  return error;
}

function listItemLine(item: TiptapNode): string {
  return (item.content ?? [])
    .map((child) => inlineHtml(child.type === "paragraph" ? child.content : [child], CUSTOM_MARK_TAGS))
    .join(" ")
    .trim();
}

function blockHtml(node: TiptapNode): string | null {
  switch (node.type) {
    case "paragraph": {
      const html = inlineHtml(node.content, CUSTOM_MARK_TAGS);
      return html.trim() ? html.replace(/^\n+|\n+$/g, "") : null;
    }
    case "bulletList":
    case "orderedList": {
      const lines = (node.content ?? [])
        .map(listItemLine)
        .filter(Boolean)
        .map((text, idx) => `${node.type === "orderedList" ? `${idx + 1}.` : "•"} ${text}`);
      return lines.length > 0 ? lines.join("\n") : null;
    }
    case "blockquote": {
      const inner = (node.content ?? [])
        .map(blockHtml)
        .filter((b): b is string => Boolean(b))
        .join("\n");
      return inner ? `<blockquote>${inner}</blockquote>` : null;
    }
    default:
      return null;
  }
}

/** Cheklangan Tiptap hujjatini Telegram HTML'ga aylantiradi (bloklar "\n\n" bilan, hardBreak "\n"). */
export function renderRestrictedDoc(doc: unknown): string {
  const root = (doc ?? emptyDoc()) as TiptapNode;
  return (root.content ?? [])
    .map(blockHtml)
    .filter((b): b is string => Boolean(b))
    .join("\n\n");
}

function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_m, name: string) => {
    switch (name) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      default:
        return "'";
    }
  });
}

/** Telegram HTML'ning "ko'rinadigan" uzunligi (teglar olib tashlanadi, entity'lar bir marta dekod qilinadi, chekka bo'shliqlar kesiladi). */
export function telegramVisibleLength(html: string): number {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).trim().length;
}

export interface HtmlValidation {
  ok: boolean;
  /** Xato bo'lsa — qisqa o'zbekcha sabab. */
  reason: string | null;
}

/** Faqat Telegram qo'llab-quvvatlaydigan teglar (`TELEGRAM_ALLOWED_HTML_TAGS`) va ular to'g'ri yopilganmi. */
export function validateTelegramHtml(html: string): HtmlValidation {
  const allowed = new Set<string>(TELEGRAM_ALLOWED_HTML_TAGS);
  const stack: string[] = [];
  const tagRe = /<\s*(\/?)\s*([a-zA-Z][\w-]*)([^>]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    const closing = match[1] === "/";
    const name = match[2]!.toLowerCase();
    if (!allowed.has(name)) return { ok: false, reason: `Qo'llab-quvvatlanmaydigan teg: <${name}>` };
    if (closing) {
      if (stack.pop() !== name) return { ok: false, reason: `Teg noto'g'ri yopilgan: </${name}>` };
    } else {
      stack.push(name);
    }
  }
  if (stack.length > 0) return { ok: false, reason: `Teg yopilmagan: <${stack[stack.length - 1]}>` };
  // Tegdan tashqaridagi yalang'och "<" Telegram'da parse xatosiga olib keladi.
  const stripped = html.replace(/<[^>]+>/g, "");
  if (/</.test(stripped)) return { ok: false, reason: "Matnda escape qilinmagan '<' belgisi bor" };
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------
// Telegram HTML (bizning renderimiz chiqargan) -> Tiptap — "fork" uchun.
// ---------------------------------------------------------------------------

type Mark = { type: string; attrs?: Record<string, unknown> };

const TAG_TO_MARK: Record<string, string> = { b: "bold", i: "italic", u: "underline", s: "strike", code: "code" };

/** Bitta qator/paragraf ichidagi (blockquote'siz) inline HTML'ni Tiptap inline tugunlariga aylantiradi. */
function parseInline(html: string): TiptapNode[] {
  const out: TiptapNode[] = [];
  const stack: Mark[] = [];
  const tokenRe = /<(\/?)([a-z-]+)([^>]*)>|([^<]+)/gi;
  let m: RegExpExecArray | null;
  const pushText = (raw: string) => {
    const decoded = decodeEntities(raw);
    const parts = decoded.split("\n");
    parts.forEach((part, idx) => {
      if (idx > 0) out.push({ type: "hardBreak" });
      if (part) {
        const node: TiptapNode = { type: "text", text: part };
        if (stack.length > 0) node.marks = stack.map((mark) => ({ ...mark }));
        out.push(node);
      }
    });
  };
  while ((m = tokenRe.exec(html)) !== null) {
    if (m[4] !== undefined) {
      pushText(m[4]);
      continue;
    }
    const closing = m[1] === "/";
    const name = m[2]!.toLowerCase();
    if (closing) {
      stack.pop();
      continue;
    }
    if (name === "a") {
      const href = /href="([^"]*)"/.exec(m[3] ?? "")?.[1];
      stack.push({ type: "link", attrs: { href: href ? decodeEntities(href) : "" } });
    } else {
      stack.push({ type: TAG_TO_MARK[name] ?? "bold" });
    }
  }
  return out;
}

/**
 * Bizning `renderRestrictedDoc` / `buildChannelPost` chiqargan Telegram HTML'ni
 * Tiptap hujjatiga qaytaradi. Bloklar "\n\n" bilan ajratilgan; `<blockquote>`
 * ichidagi qatorlar alohida paragraf bo'ladi. Qaytadan render qilinganda
 * (deyarli) bir xil HTML chiqadi.
 */
export function telegramHtmlToDoc(html: string): TiptapNode {
  const content: TiptapNode[] = [];
  // blockquote ichida "\n\n" bo'lmaydi (bolalar "\n" bilan birlashtiriladi) — shuning uchun oddiy bo'lish xavfsiz.
  for (const chunk of html.split("\n\n")) {
    const text = chunk.trim();
    if (!text) continue;
    const quote = /^<blockquote>([\s\S]*)<\/blockquote>$/.exec(text);
    if (quote) {
      const paragraphs = quote[1]!
        .split("\n")
        .filter((line) => line.trim())
        .map((line): TiptapNode => ({ type: "paragraph", content: parseInline(line) }));
      content.push({ type: "blockquote", content: paragraphs.length ? paragraphs : [{ type: "paragraph" }] });
      continue;
    }
    content.push({ type: "paragraph", content: parseInline(text) });
  }
  return { type: "doc", content };
}

/** Test/yordamchi: oddiy matndan bitta paragrafli hujjat. */
export function plainTextDoc(text: string): TiptapNode {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

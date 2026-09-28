import { escapeHtml, escapeHtmlAttr, tagsToHashtags } from "./format.js";

/**
 * Kanal posti (Telegram HTML, parse_mode HTML) postning Tiptap JSON
 * kontentidan avtomatik quriladi — alohida "kanal matni" maydoni yo'q.
 * https://core.telegram.org/bots/api#html-style
 */

interface TiptapMark {
  type: string;
  attrs?: Record<string, unknown>;
}

interface TiptapNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  text?: string;
  marks?: TiptapMark[];
}

const INLINE_MARK_TAGS: Record<string, string> = {
  bold: "b",
  italic: "i",
  strike: "s",
  code: "code",
};

/** Safety margin — Telegram limitidan pastroq bo'lib qoladi (spec: ~100 belgi). */
const SAFETY_MARGIN = 100;

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function wrapInlineMarks(node: TiptapNode, innerHtml: string): string {
  let html = innerHtml;
  for (const mark of node.marks ?? []) {
    if (mark.type === "link") {
      const href = mark.attrs?.href;
      if (isHttpUrl(href)) {
        html = `<a href="${escapeHtmlAttr(href)}">${html}</a>`;
      }
      continue;
    }
    const tag = INLINE_MARK_TAGS[mark.type];
    if (tag) html = `<${tag}>${html}</${tag}>`;
  }
  return html;
}

/** Inline (paragraph/heading/blockquote/listItem ichidagi) tugunlarni HTML matnga aylantiradi. */
function inlineHtml(nodes: TiptapNode[] | undefined): string {
  if (!nodes) return "";
  return nodes
    .map((node) => {
      if (node.type === "text") {
        return wrapInlineMarks(node, escapeHtml(node.text ?? ""));
      }
      if (node.type === "hardBreak") return "\n";
      // Noma'lum inline tugun — bolalarini xavfsiz tekislab qo'shamiz.
      return inlineHtml(node.content);
    })
    .join("");
}

/** `listItem` tarkibidagi bitta paragraf/matnni bitta qatorga tushiradi (ichma-ich ro'yxatlar soddalik uchun e'tiborsiz qoldiriladi). */
function listItemText(item: TiptapNode): string {
  return (item.content ?? [])
    .filter((child) => child.type === "paragraph" || child.type === "text")
    .map((child) => (child.type === "paragraph" ? inlineHtml(child.content) : inlineHtml([child])))
    .join(" ")
    .trim();
}

/** Bitta top-level (blok darajasidagi) Tiptap tugunini Telegram HTML blokka aylantiradi. `null` — blok o'tkazib yuboriladi (bo'sh yoki qo'llab-quvvatlanmaydigan tur). */
function blockHtml(node: TiptapNode): string | null {
  switch (node.type) {
    case "paragraph": {
      const html = inlineHtml(node.content);
      return html.trim() ? html : null;
    }
    case "heading": {
      const html = inlineHtml(node.content);
      return html.trim() ? `<b>${html}</b>` : null;
    }
    case "bulletList": {
      const items = (node.content ?? [])
        .map((item) => listItemText(item))
        .filter(Boolean)
        .map((text) => `• ${text}`);
      return items.length > 0 ? items.join("\n") : null;
    }
    case "orderedList": {
      const items = (node.content ?? [])
        .map((item) => listItemText(item))
        .filter(Boolean)
        .map((text, idx) => `${idx + 1}. ${text}`);
      return items.length > 0 ? items.join("\n") : null;
    }
    case "blockquote": {
      const inner = (node.content ?? [])
        .map((child) => blockHtml(child))
        .filter((b): b is string => Boolean(b))
        .join("\n");
      return inner ? `<blockquote>${inner}</blockquote>` : null;
    }
    // Spec bo'yicha o'tkazib yuboriladi: kod bloki, jadval, rasm, gorizontal chiziq.
    case "codeBlock":
    case "table":
    case "image":
    case "horizontalRule":
      return null;
    default:
      return null;
  }
}

function stripTagsPlain(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Telegram HTML matnini "ko'rinadigan" uzunligiga aylantiradi (teglar olib tashlanadi, entity'lar dekod qilinadi). */
function visibleLength(html: string): number {
  return stripTagsPlain(html).length;
}

/** Gap chegarasida kesib, oxiriga "…" qo'shadi — chegara topilmasa qattiq kesadi. */
function cutAtSentenceBoundary(plainText: string, budget: number): string {
  // "…" o'ziga 1 belgi oladi — shu sabab kesish uzunligidan oldindan ayrib qo'yiladi,
  // natija hech qachon `budget`dan oshmasligi kafolatlanadi.
  const usable = Math.max(0, budget - 1);
  if (usable <= 0) return "…";
  if (plainText.length <= usable) return plainText;

  const slice = plainText.slice(0, usable);
  let boundary = -1;
  for (const terminator of [". ", "! ", "? ", ".\n", "!\n", "?\n"]) {
    const idx = slice.lastIndexOf(terminator);
    if (idx > boundary) boundary = idx;
  }

  if (boundary > 0) {
    return `${slice.slice(0, boundary + 1).trimEnd()}…`;
  }
  return `${slice.trimEnd()}…`;
}

function buildFooter(params: {
  siteUrl: string;
  slug: string;
  telegraphUrl: string | null;
  truncated: boolean;
  hashtags: string;
}): string {
  const postUrl = `${params.siteUrl}/${params.slug}`;
  const label = params.truncated ? "📖 Davomini o'qing:" : "📖 To'liq post:";
  const linkParts = [`<a href="${escapeHtmlAttr(postUrl)}">Blog saytida</a>`];
  if (params.telegraphUrl) {
    linkParts.push(`<a href="${escapeHtmlAttr(params.telegraphUrl)}">Telegraph'da</a>`);
  }
  const footerLine = `${label} ${linkParts.join(" · ")}`;
  return params.hashtags ? `${footerLine}\n${params.hashtags}` : footerLine;
}

export interface ChannelPostInput {
  post: {
    title: string;
    slug: string;
    contentJson: unknown;
    /** Teg nomlari — hashtag qatorini yasash uchun (bo'sh bo'lsa hashtag qatori chiqarilmaydi). */
    tags?: string[];
  };
  siteUrl: string;
  telegraphUrl: string | null;
  /** Text xabar uchun 4096, rasm caption uchun 1024. */
  limit: number;
}

export interface ChannelPostResult {
  html: string;
  visibleLength: number;
  truncated: boolean;
}

export function buildChannelPost(input: ChannelPostInput): ChannelPostResult {
  const { post, siteUrl, telegraphUrl, limit } = input;
  const effectiveLimit = Math.max(0, limit - SAFETY_MARGIN);

  const titleHtml = `<b>${escapeHtml(post.title)}</b>`;
  const doc = (post.contentJson ?? { type: "doc", content: [] }) as TiptapNode;
  const topNodes = doc.content ?? [];
  const rawItems = topNodes
    .map((n) => ({ html: blockHtml(n), heading: n.type === "heading" }))
    .filter((it): it is { html: string; heading: boolean } => Boolean(it.html));
  // Ostidagi matni tashlab ketilgan (jadval/kod/rasm) yoki hujjat oxiridagi sarlavha bo'sh qolmasin.
  const items = rawItems.filter((it, i) => !it.heading || (rawItems[i + 1] !== undefined && !rawItems[i + 1]!.heading));
  const blocks = items.map((it) => it.html);
  const hashtags = tagsToHashtags(post.tags ?? []);

  function assemble(contentBlocks: string[], truncated: boolean): string {
    const footer = buildFooter({ siteUrl, slug: post.slug, telegraphUrl, truncated, hashtags });
    const parts = [titleHtml];
    if (contentBlocks.length > 0) parts.push(contentBlocks.join("\n\n"));
    parts.push(footer);
    return parts.join("\n\n");
  }

  // 1) Hammasi (to'liq footer bilan) sig'ib qoladimi?
  const fullMessage = assemble(blocks, false);
  const fullLength = visibleLength(fullMessage);
  if (fullLength <= effectiveLimit) {
    return { html: fullMessage, visibleLength: fullLength, truncated: false };
  }

  // 2) Bloklarni bittalab qo'shib, sig'ganicha to'ldiramiz (hech qachon blok ichida kesmasdan).
  // Sarlavha faqat ostidagi birinchi blok bilan birga qo'shiladi — oxirida yolg'iz sarlavha qolmaydi.
  const kept: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const group = items[i]!.heading && items[i + 1] ? [items[i]!.html, items[i + 1]!.html] : [items[i]!.html];
    const candidate = assemble([...kept, ...group], true);
    if (visibleLength(candidate) <= effectiveLimit) {
      kept.push(...group);
      i += group.length - 1;
    } else {
      break;
    }
  }

  // 3) Birinchi blok o'zi ham sig'masa — gap chegarasida kesamiz.
  if (kept.length === 0 && blocks.length > 0) {
    const skeleton = assemble([], true);
    const overhead = visibleLength(skeleton) + 2; // ikki blok orasidagi "\n\n"
    const budget = Math.max(0, effectiveLimit - overhead);
    const plain = stripTagsPlain(items.find((it) => !it.heading)?.html ?? blocks[0]!);
    const cut = cutAtSentenceBoundary(plain, budget);
    kept.push(escapeHtml(cut));
  }

  const finalMessage = assemble(kept, true);
  return { html: finalMessage, visibleLength: visibleLength(finalMessage), truncated: true };
}

export const CHANNEL_TEXT_LIMIT = 4096;
export const CHANNEL_CAPTION_LIMIT = 1024;

import {
  CHANNEL_CAPTION_HARD_LIMIT,
  CHANNEL_TEXT_HARD_LIMIT,
  channelVariantBudget,
  isChannelComboValid,
  type ChannelMode,
  type ChannelVariant,
} from "@blog/shared";
import { escapeHtml, escapeHtmlAttr, tagsToHashtags } from "./format.js";

/**
 * Kanal posti (Telegram HTML, parse_mode HTML) postning Tiptap JSON
 * kontentidan avtomatik quriladi — alohida "kanal matni" maydoni yo'q.
 * https://core.telegram.org/bots/api#html-style
 *
 * Ikki rejim bor:
 * - `media` — kover rasm sifatida + band ichidagi rasmlar albom, matn caption'da
 *   (Telegram caption qattiq chegarasi 1024 — `CHANNEL_CAPTION_HARD_LIMIT`).
 * - `text` — oddiy matn xabari, rasmlar YO'Q (Telegram matn chegarasi 4096 —
 *   `CHANNEL_TEXT_HARD_LIMIT`).
 *
 * Har ikkala rejimda ham HAR BIR variant o'zining "ko'rinadigan" belgi
 * byudjetidan (`CHANNEL_VARIANT_BUDGETS`, `@blog/shared`) oshmasligi SHART.
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

export const CHANNEL_CAPTION_LIMIT = CHANNEL_CAPTION_HARD_LIMIT;
export const CHANNEL_TEXT_LIMIT = CHANNEL_TEXT_HARD_LIMIT;

/** Bitta postda eng ko'p nechta media (kover + kontent rasmlari) yuborilishi mumkin — Telegram media-group limiti. */
export const MAX_CHANNEL_MEDIA = 10;

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

export interface ChannelPostImage {
  url: string;
  alt: string | null;
}

export interface ChannelPostInput {
  post: {
    title: string;
    slug: string;
    contentJson: unknown;
    /** Teg nomlari — hashtag qatorini yasash uchun (bo'sh bo'lsa hashtag qatori chiqarilmaydi). */
    tags?: string[];
    /** Kover URL — mavjud bo'lsa, kontent ichidan topilgan bir xil URL'li rasm "kover" sifatida `images`dan chiqarib tashlanadi (ikki marta yuborilmasin). */
    coverUrl?: string | null;
  };
  siteUrl: string;
  telegraphUrl: string | null;
  mode: ChannelMode;
  variant: ChannelVariant;
}

export interface ChannelPostResult {
  html: string;
  visibleLength: number;
  limit: number;
  truncated: boolean;
  /** Kiritilgan bloklar oralig'idagi rasm tugunlari — hujjat tartibida, dublikatsiz, kover chiqarib tashlangan, ko'pi bilan `MAX_CHANNEL_MEDIA - 1` ta (kover uchun 1 joy qoldiriladi). */
  images: ChannelPostImage[];
}

interface TextItem {
  /** `topNodes` ichidagi original indeks — rasm oralig'ini aniqlash uchun. */
  order: number;
  html: string;
  heading: boolean;
  /** Ro'yxat bandlari uchun — bir ro'yxatning bandlari bir-biriga "\n" bilan qo'shiladi. */
  listGroup?: number;
}

interface ImageCandidate {
  order: number;
  url: string;
  alt: string | null;
}

export function buildChannelPost(input: ChannelPostInput): ChannelPostResult {
  const { post, siteUrl, telegraphUrl, mode, variant } = input;
  if (!isChannelComboValid(mode, variant)) {
    throw new Error(`Noto'g'ri mode/variant kombinatsiyasi: ${mode}/${variant}`);
  }
  const effectiveLimit = channelVariantBudget(mode, variant)!;

  const titleHtml = `<b>${escapeHtml(post.title)}</b>`;
  const doc = (post.contentJson ?? { type: "doc", content: [] }) as TiptapNode;
  const topNodes = doc.content ?? [];

  const rawItems: (TextItem & { heading: boolean })[] = [];
  const imageCandidates: ImageCandidate[] = [];

  topNodes.forEach((node, order) => {
    if (node.type === "image") {
      const src = node.attrs?.src;
      if (typeof src === "string" && src) {
        const alt = typeof node.attrs?.alt === "string" && node.attrs.alt ? node.attrs.alt : null;
        imageCandidates.push({ order, url: src, alt });
      }
      return;
    }
    // Ro'yxatlar bandma-band qo'shiladi: katta ro'yxat butunlay tashlab ketilmasin,
    // lekin har bir band butun qoladi.
    if (node.type === "bulletList" || node.type === "orderedList") {
      const texts = (node.content ?? []).map((item) => listItemText(item)).filter(Boolean);
      texts.forEach((text, idx) => {
        const bullet = node.type === "orderedList" ? `${idx + 1}.` : "•";
        rawItems.push({ order, html: `${bullet} ${text}`, heading: false, listGroup: order });
      });
      return;
    }
    const html = blockHtml(node);
    if (html) rawItems.push({ order, html, heading: node.type === "heading" });
  });

  // Ostidagi matni tashlab ketilgan (jadval/kod/rasm) yoki hujjat oxiridagi sarlavha bo'sh qolmasin.
  const items = rawItems.filter((it, i) => !it.heading || (rawItems[i + 1] !== undefined && !rawItems[i + 1]!.heading));
  const hashtags = tagsToHashtags(post.tags ?? []);

  function joinItems(list: TextItem[]): string {
    let out = "";
    list.forEach((it, i) => {
      const prev = list[i - 1];
      if (i > 0) out += prev?.listGroup !== undefined && prev.listGroup === it.listGroup ? "\n" : "\n\n";
      out += it.html;
    });
    return out;
  }

  function assemble(contentItems: TextItem[], truncated: boolean): string {
    const footer = buildFooter({ siteUrl, slug: post.slug, telegraphUrl, truncated, hashtags });
    const parts = [titleHtml];
    if (contentItems.length > 0) parts.push(joinItems(contentItems));
    parts.push(footer);
    return parts.join("\n\n");
  }

  /** Kiritilgan bloklarning eng oxirgi (dokument tartibidagi) indeksi — shu indeksgacha bo'lgan rasmlar "range ichida" hisoblanadi. `null` — hech qanday matn bloki kiritilmagan. */
  let cutoffOrder: number | null = null;
  let finalHtml: string;
  let finalTruncated: boolean;

  // 1) Hammasi (to'liq footer bilan) sig'ib qoladimi?
  const fullMessage = assemble(items, false);
  const fullLength = visibleLength(fullMessage);
  if (fullLength <= effectiveLimit) {
    finalHtml = fullMessage;
    finalTruncated = false;
    cutoffOrder = topNodes.length > 0 ? topNodes.length - 1 : null;
  } else {
    // 2) Bloklarni bittalab qo'shib, sig'ganicha to'ldiramiz (hech qachon blok ichida kesmasdan).
    // Sarlavha faqat ostidagi birinchi blok bilan birga qo'shiladi — oxirida yolg'iz sarlavha qolmaydi.
    const kept: TextItem[] = [];
    let lastKeptOrder: number | null = null;
    for (let i = 0; i < items.length; i++) {
      const group = items[i]!.heading && items[i + 1] ? [items[i]!, items[i + 1]!] : [items[i]!];
      const candidate = assemble([...kept, ...group], true);
      if (visibleLength(candidate) <= effectiveLimit) {
        kept.push(...group);
        lastKeptOrder = group[group.length - 1]!.order;
        i += group.length - 1;
      } else {
        break;
      }
    }

    // 3) Birinchi blok o'zi ham sig'masa — gap chegarasida kesamiz.
    if (kept.length === 0 && items.length > 0) {
      const firstItem = items.find((it) => !it.heading) ?? items[0]!;
      const skeleton = assemble([], true);
      const overhead = visibleLength(skeleton) + 2; // ikki blok orasidagi "\n\n"
      const budget = Math.max(0, effectiveLimit - overhead);
      const plain = stripTagsPlain(firstItem.html);
      const cut = cutAtSentenceBoundary(plain, budget);
      kept.push({ order: firstItem.order, html: escapeHtml(cut), heading: false });
      lastKeptOrder = firstItem.order;
    }

    cutoffOrder = lastKeptOrder;
    finalHtml = assemble(kept, true);
    finalTruncated = true;
  }

  // `text` rejimda rasmlar HECH QACHON yig'ilmaydi/yuborilmaydi (spec).
  const images: ChannelPostImage[] = [];
  if (mode === "media") {
    const seenUrls = new Set<string>();
    if (post.coverUrl) seenUrls.add(post.coverUrl);

    for (const candidate of imageCandidates) {
      if (cutoffOrder === null || candidate.order > cutoffOrder) continue;
      if (seenUrls.has(candidate.url)) continue;
      seenUrls.add(candidate.url);
      images.push({ url: candidate.url, alt: candidate.alt });
      // Kover uchun 1 joy qoldiramiz — jami (kover + kontent) hech qachon MAX_CHANNEL_MEDIA'dan oshmasin.
      if (images.length >= MAX_CHANNEL_MEDIA - 1) break;
    }
  }

  return {
    html: finalHtml,
    visibleLength: visibleLength(finalHtml),
    limit: effectiveLimit,
    truncated: finalTruncated,
    images,
  };
}

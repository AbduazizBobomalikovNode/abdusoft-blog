import { config } from "../config.js";
import { getSettings } from "../lib/settings.js";
import { getStoredTelegraphToken, storeTelegraphToken } from "../lib/site-settings.js";

const FALLBACK_AUTHOR_NAME = "Blog";

/** Telegraph muallif nomi — sozlamalardagi sayt nomi (`general.siteName`), topilmasa "Blog". */
export async function resolveTelegraphAuthorName(): Promise<string> {
  try {
    const settings = await getSettings();
    return settings.general.siteName?.trim() || FALLBACK_AUTHOR_NAME;
  } catch {
    return FALLBACK_AUTHOR_NAME;
  }
}

/** Nisbiy (`/uploads/...`) manzilni API origin'i bilan mutlaq URL'ga aylantiradi — Telegraph faqat mutlaq URL'ni ko'ra oladi. */
export function absolutizeImageSrc(src: string): string {
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith("//")) return `https:${src}`;
  if (src.startsWith("/")) return `${config.API_ORIGIN}${src}`;
  return src;
}

/** https://telegra.ph/api — Node DOM formati: string yoki {tag, attrs, children}. */
export type TelegraphNode =
  | string
  | {
      tag: string;
      attrs?: Record<string, string>;
      children?: TelegraphNode[];
    };

interface TiptapNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

const CONTENT_LIMIT_BYTES = 60_000; // Telegraph limiti 64 KB — xavfsizlik zaxirasi bilan.
const CONTINUE_NOTICE = "Davomi saytda →";

async function telegraphCall<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${config.TELEGRAPH_API_ROOT}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });

  const data = (await res.json()) as { ok: boolean; result?: T; error?: string };
  if (!data.ok) {
    throw new Error(`Telegraph API xatosi (${method}): ${data.error ?? res.statusText}`);
  }
  return data.result as T;
}

/**
 * `TELEGRAPH_ACCESS_TOKEN` bo'sh bo'lsa, avval `site_settings`da saqlangan
 * tokenni izlaydi, aks holda `createAccount` chaqirib yangi token yaratadi va
 * saqlaydi (shu jarayon faqat bir marta bo'ladi).
 */
export async function ensureTelegraphToken(): Promise<string> {
  if (config.TELEGRAPH_ACCESS_TOKEN) return config.TELEGRAPH_ACCESS_TOKEN;

  const stored = await getStoredTelegraphToken();
  if (stored) return stored;

  const account = await telegraphCall<{ access_token: string }>("createAccount", {
    short_name: "blog",
    author_name: await resolveTelegraphAuthorName(),
  });

  await storeTelegraphToken(account.access_token);
  return account.access_token;
}

/** `POST /admin/settings/test/telegraph` uchun — token bo'lmasa yaratadi (createAccount), bo'lsa hisobni tekshiradi (getAccountInfo). */
export async function testTelegraphConnection(): Promise<{ ok: boolean; message: string; details?: Record<string, unknown> }> {
  const accessToken = await ensureTelegraphToken();
  const info = await telegraphCall<{ short_name: string; author_name: string; page_count: number }>("getAccountInfo", {
    access_token: accessToken,
    fields: ["short_name", "author_name", "page_count"],
  });
  return {
    ok: true,
    message: `Telegraph hisobi ulandi: ${info.short_name} (${info.page_count} ta sahifa)`,
    details: { ...info },
  };
}

const MARK_TAGS: Record<string, string> = {
  bold: "b",
  italic: "i",
  strike: "s",
  underline: "u",
  code: "code",
};

function wrapMarks(node: TiptapNode, inner: TelegraphNode[]): TelegraphNode[] {
  let result = inner;
  for (const mark of node.marks ?? []) {
    if (mark.type === "link") {
      const href = typeof mark.attrs?.href === "string" ? mark.attrs.href : "#";
      result = [{ tag: "a", attrs: { href }, children: result }];
      continue;
    }
    const tag = MARK_TAGS[mark.type];
    if (tag) result = [{ tag, children: result }];
  }
  return result;
}

function convertChildren(nodes: TiptapNode[] | undefined): TelegraphNode[] {
  if (!nodes) return [];
  return nodes.flatMap((node) => convertNode(node));
}

function textOf(node: TiptapNode): string {
  if (node.text) return node.text;
  return (node.content ?? []).map(textOf).join(" ");
}

/** Katak ichidagi inline kontent (paragraflar " " bilan birlashtiriladi), marks/havolalar saqlanadi. */
function cellInline(cell: TiptapNode): TelegraphNode[] {
  const out: TelegraphNode[] = [];
  for (const block of cell.content ?? []) {
    const inline = block.type === "paragraph" ? convertChildren(block.content) : convertNode(block);
    if (inline.length === 0) continue;
    if (out.length > 0) out.push(" ");
    out.push(...inline);
  }
  return out;
}

/**
 * Jadval -> paragraflar. Birinchi qator sarlavha (barcha kataklari to'la va
 * kamida bitta ma'lumot qatori bor bo'lsa): har bir ma'lumot qatori uchun bitta
 * `p` — `<strong>katak0</strong>` + har bir keyingi katak uchun `br` va
 * `sarlavha_i: katak_i`. Sarlavha yaroqsiz bo'lsa — kataklar " — " bilan birlashtiriladi.
 */
function convertTable(table: TiptapNode): TelegraphNode[] {
  const rows = (table.content ?? []).map((row) =>
    (row.content ?? []).map((cell) => ({ inline: cellInline(cell), text: textOf(cell).trim() })),
  );
  const nonEmptyRows = rows.filter((cells) => cells.some((c) => c.text));
  if (nonEmptyRows.length === 0) return [];

  const header = rows[0];
  const hasHeader = rows.length >= 2 && header !== undefined && header.length > 0 && header.every((c) => c.text);
  const dataRows = hasHeader ? rows.slice(1) : rows;

  const result: TelegraphNode[] = [];
  for (const cells of dataRows) {
    if (!cells.some((c) => c.text)) continue;
    const children: TelegraphNode[] = [];

    if (hasHeader) {
      const [first, ...rest] = cells;
      if (first?.text) children.push({ tag: "strong", children: first.inline });
      rest.forEach((cell, i) => {
        if (!cell.text) return;
        if (children.length > 0) children.push({ tag: "br" });
        children.push(`${header[i + 1]?.text ?? ""}${header[i + 1]?.text ? ": " : ""}`, ...cell.inline);
      });
    } else {
      const filled = cells.filter((c) => c.text);
      filled.forEach((cell, i) => {
        if (i > 0) children.push(" \u2014 ");
        children.push(...cell.inline);
      });
    }
    if (children.length > 0) result.push({ tag: "p", children });
  }
  return result;
}

/** Bitta Tiptap tugunini bir yoki bir nechta Telegraph Node'ga aylantiradi (masalan `doc` — bir nechta bolalarga yoyiladi). */
function convertNode(node: TiptapNode): TelegraphNode[] {
  switch (node.type) {
    case "doc":
      return convertChildren(node.content);
    case "paragraph": {
      const children = convertChildren(node.content);
      if (children.length === 0) return [];
      return [{ tag: "p", children }];
    }
    case "heading": {
      const level = typeof node.attrs?.level === "number" ? node.attrs.level : 2;
      const tag = level <= 2 ? "h3" : "h4";
      return [{ tag, children: convertChildren(node.content) }];
    }
    case "bulletList":
      return [{ tag: "ul", children: convertChildren(node.content) }];
    case "orderedList":
      return [{ tag: "ol", children: convertChildren(node.content) }];
    case "listItem":
      return [{ tag: "li", children: convertChildren(node.content) }];
    case "blockquote":
      return [{ tag: "blockquote", children: convertChildren(node.content) }];
    case "codeBlock": {
      const text = (node.content ?? []).map((c) => c.text ?? "").join("");
      return [{ tag: "pre", children: [{ tag: "code", children: [text] }] }];
    }
    case "horizontalRule":
      return [{ tag: "hr" }];
    case "hardBreak":
      return [{ tag: "br" }];
    case "image": {
      const rawSrc = typeof node.attrs?.src === "string" ? node.attrs.src : null;
      if (!rawSrc) return [];
      const src = absolutizeImageSrc(rawSrc);
      const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
      const img: TelegraphNode = { tag: "img", attrs: { src } };
      if (alt) {
        return [{ tag: "figure", children: [img, { tag: "figcaption", children: [alt] }] }];
      }
      return [{ tag: "figure", children: [img] }];
    }
    // Jadvallar Telegraph'da qo'llab-quvvatlanmaydi — har bir qator alohida paragrafga aylantiriladi.
    case "table":
      return convertTable(node);
    case "text": {
      if (!node.text) return [];
      return wrapMarks(node, [node.text]);
    }
    default:
      // Noma'lum/qo'llab-quvvatlanmaydigan tugun — bolalarini xavfsiz tarzda tekislab qo'shamiz.
      return convertChildren(node.content);
  }
}

export interface TelegraphPageOptions {
  title: string;
  authorName: string;
  authorUrl: string;
  postUrl: string;
  /** Post koveri — bo'lsa sahifaning BIRINCHI tuguni sifatida qo'shiladi (Instant View preview uchun). */
  coverUrl?: string | null;
}

function byteLength(nodes: TelegraphNode[]): number {
  return new TextEncoder().encode(JSON.stringify(nodes)).length;
}

/** 64 KB limitidan oshsa, blok chegarasida kesib "Davomi saytda →" havolasini qo'shadi. */
function enforceSizeLimit(body: TelegraphNode[], footer: TelegraphNode, postUrl: string): TelegraphNode[] {
  const full = [...body, footer];
  if (byteLength(full) <= CONTENT_LIMIT_BYTES) return full;

  const continueNotice: TelegraphNode = {
    tag: "p",
    children: [{ tag: "a", attrs: { href: postUrl }, children: [CONTINUE_NOTICE] }],
  };

  const kept: TelegraphNode[] = [];
  for (const node of body) {
    const candidate = [...kept, node, continueNotice];
    if (byteLength(candidate) > CONTENT_LIMIT_BYTES) break;
    kept.push(node);
  }
  kept.push(continueNotice);
  return kept;
}

/** Birinchi kontent tuguni aynan shu `src`li rasmmi (kover ikki marta chiqmasligi uchun). */
function startsWithImage(body: TelegraphNode[], src: string): boolean {
  const first = body[0];
  if (!first || typeof first === "string" || first.tag !== "figure") return false;
  const img = (first.children ?? []).find((c) => typeof c !== "string" && c.tag === "img");
  return typeof img !== "string" && img?.attrs?.src === src;
}

/** Tiptap JSON doc'ni Telegraph Node massiviga aylantiradi, oxirida saytga havola qo'shadi. */
export function tiptapToTelegraphNodes(json: unknown, options: TelegraphPageOptions): TelegraphNode[] {
  const body = convertNode((json ?? { type: "doc", content: [] }) as TiptapNode);
  if (options.coverUrl) {
    const coverSrc = absolutizeImageSrc(options.coverUrl);
    if (!startsWithImage(body, coverSrc)) {
      body.unshift({ tag: "figure", children: [{ tag: "img", attrs: { src: coverSrc } }] });
    }
  }
  const footer: TelegraphNode = {
    tag: "p",
    children: [{ tag: "a", attrs: { href: options.postUrl }, children: ["Saytda o'qish va fikr bildirish →"] }],
  };
  return enforceSizeLimit(body, footer, options.postUrl);
}

export interface TelegraphPageResult {
  path: string;
  url: string;
  /** `editPage` "CONTENT_NOT_CHANGED" qaytargan — sahifa allaqachon shu kontentda (xato emas). */
  unchanged?: boolean;
}

/**
 * `existingPath` bo'lsa `editPage`, aks holda `createPage` chaqiradi. Telegraph
 * hisobi bo'lmasa (birinchi chaqiruv) `ensureTelegraphToken` orqali avtomatik
 * yaratiladi.
 */
export async function createOrUpdateTelegraphPage(
  existingPath: string | null,
  nodes: TelegraphNode[],
  options: TelegraphPageOptions,
): Promise<TelegraphPageResult> {
  const accessToken = await ensureTelegraphToken();

  if (existingPath) {
    try {
      return await telegraphCall<{ path: string; url: string }>("editPage", {
        access_token: accessToken,
        path: existingPath,
        title: options.title,
        content: nodes,
        author_name: options.authorName,
        author_url: options.authorUrl,
      });
    } catch (error: unknown) {
      if (error instanceof Error && /CONTENT_NOT_CHANGED/.test(error.message)) {
        return { path: existingPath, url: `https://telegra.ph/${existingPath}`, unchanged: true };
      }
      throw error;
    }
  }

  const result = await telegraphCall<{ path: string; url: string }>("createPage", {
    access_token: accessToken,
    title: options.title,
    content: nodes,
    author_name: options.authorName,
    author_url: options.authorUrl,
  });
  return result;
}

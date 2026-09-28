import { config } from "../config.js";
import { getStoredTelegraphToken, storeTelegraphToken } from "../lib/site-settings.js";

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
    author_name: "Blog",
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
      const src = typeof node.attrs?.src === "string" ? node.attrs.src : null;
      if (!src) return [];
      const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
      const img: TelegraphNode = { tag: "img", attrs: { src } };
      if (alt) {
        return [{ tag: "figure", children: [img, { tag: "figcaption", children: [alt] }] }];
      }
      return [{ tag: "figure", children: [img] }];
    }
    // Jadvallar Telegraph'da qo'llab-quvvatlanmaydi — oddiy paragraflarga tushiriladi (fallback).
    case "table": {
      const rows = (node.content ?? [])
        .map((row) => (row.content ?? []).map((cell) => textOf(cell).trim()).filter(Boolean).join(" | "))
        .filter(Boolean);
      return rows.map((row) => ({ tag: "p", children: [row] }));
    }
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

/** Tiptap JSON doc'ni Telegraph Node massiviga aylantiradi, oxirida saytga havola qo'shadi. */
export function tiptapToTelegraphNodes(json: unknown, options: TelegraphPageOptions): TelegraphNode[] {
  const body = convertNode((json ?? { type: "doc", content: [] }) as TiptapNode);
  const footer: TelegraphNode = {
    tag: "p",
    children: [{ tag: "a", attrs: { href: options.postUrl }, children: ["Saytda o'qish va fikr bildirish →"] }],
  };
  return enforceSizeLimit(body, footer, options.postUrl);
}

export interface TelegraphPageResult {
  path: string;
  url: string;
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
    const result = await telegraphCall<{ path: string; url: string }>("editPage", {
      access_token: accessToken,
      path: existingPath,
      title: options.title,
      content: nodes,
      author_name: options.authorName,
      author_url: options.authorUrl,
    });
    return result;
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

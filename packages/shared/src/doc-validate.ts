/**
 * Tiptap hujjatini RENDERDAN OLDIN tekshirish: resurs chegaralari + tugun/belgi turlari (+ konnektor uchun atribut ruxsat ro'yxati).
 * Sabab: `colspan: 1000000` kabi ~150 baytlik hujjat jadval renderini xotiradan chiqarib yuboradi. Bu yerda hech narsa render
 * qilinmaydi va ajratilmaydi — faqat bir marta aylanib chiqiladi (O(tugunlar soni), chegaralangan chuqurlik).
 *
 * Ikki daraja:
 *  - "panel"     — admin muharriri chiqaradigan HAR QANDAY hujjat o'tishi shart: faqat chegaralar, tur nomlari va atribut TURLARI.
 *                  Noma'lum atributlar rad etilmaydi.
 *  - "connector" — yuqoridagilar + har tugun/belgi uchun atribut ruxsat ro'yxati, xavfsiz URL, sarlavha darajasi 2..4.
 *                  Sukut qiymatiga teng (yoki null) ruxsat etilmagan atribut jimgina olib tashlanadi (get_post'dan olingan
 *                  hujjatni qaytarib yuborish ishlashi uchun); boshqa qiymat rad etiladi.
 */

export const DOC_NODE_TYPES = [
  "doc", "paragraph", "text", "heading", "bulletList", "orderedList", "listItem", "blockquote", "codeBlock",
  "horizontalRule", "hardBreak", "image", "table", "tableRow", "tableHeader", "tableCell",
] as const;
export const DOC_MARK_TYPES = ["bold", "italic", "strike", "code", "link", "underline"] as const;

export const DOC_LIMITS = {
  maxDepth: 40,
  maxNodes: 100_000,
  maxChildren: 20_000,
  maxMarksPerNode: 10,
  maxTextLength: 500_000,
  maxStringAttr: 16_384,
  maxTableRows: 1_000,
  maxTableCellsPerRow: 64,
  maxTableCells: 20_000,
  maxSpan: 64,
  maxColwidthEntries: 64,
  maxOrderedStart: 1_000_000,
  maxImageDimension: 100_000,
  // konnektor
  connectorMaxUrl: 2_048,
  connectorMaxText: 1_000,
} as const;

export type DocValidationMode = "panel" | "connector";

export interface DocValidationOptions {
  mode: DocValidationMode;
  /** konnektor: rasm `src` qiymati shu blogning o'z media manzilimi (R2 ochiq baza yoki `<API_ORIGIN>/uploads/...`)? */
  isAllowedImageUrl?: (url: string) => boolean;
}

export type DocValidationResult = { ok: true; doc: unknown } | { ok: false; message: string };

const NODE_SET: ReadonlySet<string> = new Set(DOC_NODE_TYPES);
const MARK_SET: ReadonlySet<string> = new Set(DOC_MARK_TYPES);
const SAFE_URL = /^(https?:\/\/|mailto:|\/(?!\/)|#)/i;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

class Reject extends Error {}
const bad = (message: string): never => {
  throw new Reject(message);
};

/** Muharrir schemasidagi sukut qiymatlari: ruxsat etilmagan atribut shunga teng bo'lsa — olib tashlanadi. */
const LINK_DEFAULTS: Record<string, unknown> = { target: "_blank", rel: "noopener noreferrer nofollow", class: null, title: null };

const NODE_ATTRS: Record<string, readonly string[]> = {
  heading: ["level"],
  orderedList: ["start", "type"],
  codeBlock: ["language"],
  image: ["src", "alt", "title", "width", "height"],
  tableHeader: ["colspan", "rowspan", "colwidth", "align"],
  tableCell: ["colspan", "rowspan", "colwidth", "align"],
};

function checkAttrValue(path: string, key: string, value: unknown): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) bad(`${path}: attrs.${key} must be a finite number`);
    return;
  }
  if (typeof value === "string") {
    if (value.length > DOC_LIMITS.maxStringAttr) bad(`${path}: attrs.${key} is longer than ${DOC_LIMITS.maxStringAttr} characters`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > DOC_LIMITS.maxColwidthEntries) bad(`${path}: attrs.${key} has too many entries`);
    for (const item of value) if (item !== null && !(typeof item === "number" && Number.isFinite(item))) bad(`${path}: attrs.${key} must hold numbers`);
    return;
  }
  bad(`${path}: attrs.${key} has an unsupported value type`);
}

function checkTypedNodeAttrs(type: string, attrs: Record<string, unknown>, path: string, mode: DocValidationMode): void {
  const a = attrs;
  if (type === "heading" && a.level !== undefined) {
    const [min, max] = mode === "connector" ? [2, 4] : [1, 6];
    if (!isInt(a.level, min, max)) bad(`${path}: heading level must be an integer ${min}-${max}`);
  }
  if (type === "orderedList") {
    if (a.start !== undefined && a.start !== null && !isInt(a.start, 0, DOC_LIMITS.maxOrderedStart)) bad(`${path}: orderedList start must be an integer 0-${DOC_LIMITS.maxOrderedStart}`);
    if (a.type !== undefined && a.type !== null && !(typeof a.type === "string" && ["1", "a", "A", "i", "I"].includes(a.type))) bad(`${path}: orderedList type is not supported`);
  }
  if (type === "codeBlock" && a.language !== undefined && a.language !== null && !(typeof a.language === "string" && a.language.length <= 64)) bad(`${path}: codeBlock language must be a string up to 64 characters`);
  if (type === "tableCell" || type === "tableHeader") {
    for (const k of ["colspan", "rowspan"] as const) {
      if (a[k] !== undefined && a[k] !== null && !isInt(a[k], 1, DOC_LIMITS.maxSpan)) bad(`${path}: ${k} must be an integer 1-${DOC_LIMITS.maxSpan}`);
    }
    if (a.colwidth !== undefined && a.colwidth !== null) {
      if (!Array.isArray(a.colwidth) || a.colwidth.length > DOC_LIMITS.maxColwidthEntries || !a.colwidth.every((w) => w === null || isInt(w, 0, 10_000))) bad(`${path}: colwidth must be a short array of integers`);
    }
    if (a.align !== undefined && a.align !== null && !(typeof a.align === "string" && a.align.length <= 16)) bad(`${path}: align must be a short string`);
  }
  if (type === "image") {
    for (const k of ["width", "height"] as const) {
      const v = a[k];
      if (v !== undefined && v !== null && !(isInt(v, 0, DOC_LIMITS.maxImageDimension) || (typeof v === "string" && v.length <= 16))) bad(`${path}: image ${k} is not valid`);
    }
  }
}

function connectorAttrs(type: string, attrs: Record<string, unknown>, path: string, opts: DocValidationOptions): Record<string, unknown> | undefined {
  const allowed = NODE_ATTRS[type] ?? [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (!allowed.includes(k)) {
      if (v === null || v === undefined) continue;
      bad(`${path}: attribute "${k}" is not allowed on ${type}`);
    }
    out[k] = v;
  }
  if (type === "image") {
    const src = out.src;
    if (typeof src !== "string" || src === "") bad(`${path}: image needs a src`);
    const s = src as string;
    if (s.length > DOC_LIMITS.connectorMaxUrl) bad(`${path}: image src is too long`);
    if (!SAFE_URL.test(s) || !/^(https?:\/\/|\/)/i.test(s)) bad(`${path}: image src must be an http(s) or site-relative URL`);
    if (!opts.isAllowedImageUrl || !opts.isAllowedImageUrl(s)) bad(`${path}: image src must be one of this blog's own media URLs (upload it with upload_image first)`);
    for (const k of ["alt", "title"] as const) {
      const v = out[k];
      if (v !== undefined && v !== null && !(typeof v === "string" && v.length <= DOC_LIMITS.connectorMaxText)) bad(`${path}: image ${k} must be a string up to ${DOC_LIMITS.connectorMaxText} characters`);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function connectorMark(mark: Record<string, unknown>, path: string): Record<string, unknown> {
  const type = mark.type as string;
  const attrs = isObj(mark.attrs) ? mark.attrs : {};
  if (type !== "link") {
    for (const v of Object.values(attrs)) if (v !== null && v !== undefined) bad(`${path}: mark ${type} takes no attributes`);
    return { type };
  }
  const href = attrs.href;
  if (typeof href !== "string" || href === "" || href.length > DOC_LIMITS.connectorMaxUrl) bad(`${path}: link needs an href up to ${DOC_LIMITS.connectorMaxUrl} characters`);
  if (!SAFE_URL.test(href as string)) bad(`${path}: link href must start with http://, https://, mailto:, / or #`);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "href" || v === null || v === undefined) continue;
    if (k in LINK_DEFAULTS && v === LINK_DEFAULTS[k]) continue;
    bad(`${path}: link attribute "${k}" is not allowed (only href)`);
  }
  return { type, attrs: { href } };
}

/**
 * `doc` — tekshiriladigan qiymat. Muvaffaqiyatda `doc` qaytadi: panel darajasida O'ZGARISHSIZ (xuddi shu obyekt),
 * konnektor darajasida — ruxsat etilmagan sukut atributlari olib tashlangan nusxa.
 */
export function validateDocument(doc: unknown, opts: DocValidationOptions): DocValidationResult {
  const connector = opts.mode === "connector";
  let nodes = 0;
  let cells = 0;

  const walk = (node: unknown, depth: number, path: string, parentType: string | null): unknown => {
    if (!isObj(node)) return bad(`${path}: a node must be an object`);
    if (depth > DOC_LIMITS.maxDepth) bad(`${path}: nested deeper than ${DOC_LIMITS.maxDepth} levels`);
    if (++nodes > DOC_LIMITS.maxNodes) bad(`the document has more than ${DOC_LIMITS.maxNodes} nodes`);
    const type = node.type;
    if (typeof type !== "string" || !NODE_SET.has(type)) return bad(`${path}: unknown node type${typeof type === "string" ? ` "${type.slice(0, 40)}"` : ""}`);
    if (depth === 0 && type !== "doc") bad(`the root must be a "doc" node`);
    if (depth > 0 && type === "doc") bad(`${path}: "doc" can only be the root`);

    const out: Record<string, unknown> = { type };
    const here = `${path}/${type}`;

    if (type === "text") {
      if (typeof node.text !== "string") bad(`${here}: text must be a string`);
      if ((node.text as string).length > DOC_LIMITS.maxTextLength) bad(`${here}: text is longer than ${DOC_LIMITS.maxTextLength} characters`);
      if (node.content !== undefined) bad(`${here}: text nodes have no content`);
      out.text = node.text;
    } else if (node.text !== undefined) {
      bad(`${here}: only text nodes carry text`);
    }

    if (node.attrs !== undefined && node.attrs !== null) {
      if (!isObj(node.attrs)) bad(`${here}: attrs must be an object`);
      const attrs = node.attrs as Record<string, unknown>;
      const keys = Object.keys(attrs);
      if (keys.length > 16) bad(`${here}: too many attributes`);
      for (const k of keys) checkAttrValue(here, k, attrs[k]);
      checkTypedNodeAttrs(type, attrs, here, opts.mode);
      if (connector) {
        const cleaned = connectorAttrs(type, attrs, here, opts);
        if (cleaned) out.attrs = cleaned;
      } else out.attrs = attrs;
    } else if (connector && type === "image") {
      bad(`${here}: image needs a src`);
    }

    if (node.marks !== undefined && node.marks !== null) {
      if (!Array.isArray(node.marks)) bad(`${here}: marks must be an array`);
      const marks = node.marks as unknown[];
      if (marks.length > DOC_LIMITS.maxMarksPerNode) bad(`${here}: too many marks`);
      const outMarks: unknown[] = [];
      for (const m of marks) {
        if (!isObj(m) || typeof m.type !== "string" || !MARK_SET.has(m.type)) return bad(`${here}: unknown mark type`);
        if (m.attrs !== undefined && m.attrs !== null) {
          if (!isObj(m.attrs)) bad(`${here}: mark attrs must be an object`);
          const mk = Object.keys(m.attrs as object);
          if (mk.length > 16) bad(`${here}: too many mark attributes`);
          for (const k of mk) checkAttrValue(here, k, (m.attrs as Record<string, unknown>)[k]);
        }
        outMarks.push(connector ? connectorMark(m, here) : m);
      }
      if (outMarks.length > 0 || !connector) out.marks = connector ? outMarks : marks;
    }

    if (node.content !== undefined && node.content !== null) {
      if (!Array.isArray(node.content)) bad(`${here}: content must be an array`);
      const content = node.content as unknown[];
      if (content.length > DOC_LIMITS.maxChildren) bad(`${here}: too many child nodes`);
      if (type === "table" && content.length > DOC_LIMITS.maxTableRows) bad(`${here}: a table can have at most ${DOC_LIMITS.maxTableRows} rows`);
      if (type === "tableRow") {
        if (content.length > DOC_LIMITS.maxTableCellsPerRow) bad(`${here}: a table row can have at most ${DOC_LIMITS.maxTableCellsPerRow} cells`);
        cells += content.length;
        if (cells > DOC_LIMITS.maxTableCells) bad(`the document has more than ${DOC_LIMITS.maxTableCells} table cells`);
      }
      const children: unknown[] = [];
      for (let i = 0; i < content.length; i++) children.push(walk(content[i], depth + 1, `${here}[${i}]`, type));
      out.content = children;
    }
    void parentType;
    return connector ? out : node;
  };

  try {
    return { ok: true, doc: walk(doc, 0, "doc", null) };
  } catch (error) {
    if (error instanceof Reject) return { ok: false, message: error.message };
    if (error instanceof RangeError) return { ok: false, message: "the document is nested too deeply" };
    throw error;
  }
}

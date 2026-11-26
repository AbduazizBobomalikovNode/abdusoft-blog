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
  /** Barcha tugunlar (matn tugunlari ham). Oddiy matn tugunlari arzon: asosiy xarajat `maxRenderElements`da. */
  maxNodes: 40_000,
  maxChildren: 20_000,
  maxMarksPerNode: 10,
  maxTextLength: 500_000,
  /** Barcha matn tugunlarining umumiy uzunligi (kod bloklari ham shu yerga kiradi). */
  maxTotalText: 1_000_000,
  /** Barcha kod bloklari matnining umumiy uzunligi (til ko'rsatilgan yoki ko'rsatilmagan). */
  maxTotalCode: 200_000,
  /** Tili ko'rsatilgan (sintaksis bo'yash qilinadigan) kod bloklarining umumiy uzunligi: bo'yash ~28 mks/belgi. */
  maxHighlightedCode: 30_000,
  maxStringAttr: 16_384,
  /** Hujjatning taxminiy serializatsiya hajmi (belgilarda); render va saqlashdan OLDIN yig'iladi, oshsa darhol to'xtaydi. */
  maxDocSize: 2_000_000,
  /** Rasm tugunlari soni. */
  maxImages: 500,
  /** Render qilinadigan element soni: blok/inline tugunlar (matn tugunlari va ildizdan tashqari) + qo'llangan belgilar (mark). */
  maxRenderElements: 12_000,
  maxTableRows: 300,
  maxTableCellsPerRow: 32,
  maxTableCells: 3_000,
  maxSpan: 32,
  maxColwidthEntries: 64,
  maxOrderedStart: 1_000_000,
  maxImageDimension: 100_000,
  // konnektor
  connectorMaxUrl: 2_048,
  connectorMaxText: 1_000,
  /** Konnektor jadvallari: kichikroq (assistent katta jadval yozishi kerak emas). */
  connectorMaxSpan: 10,
  connectorMaxTableCells: 500,
} as const;

/**
 * Renderdan OLDINGI narx baholash (`estimateRenderCost`): o'lchangan birlik narxlari (Apple M-seriya, `renderPost` = Tiptap HTML +
 * rehype + shiki, isitilgan jarayon) — element 48 mks va ~13 KB; bo'yaladigan kod 28 mks va ~300 B / belgi; oddiy kod 1 mks;
 * matn 0.3 mks va ~12 B / belgi. Byudjet: 0,9 soniya CPU va 190 MB. Har qanday o'tadigan hujjat shu byudjetdan oshmaydi — chegaralar
 * yig'indisi bilan ham (alohida chegaralarning har biri to'ldirilsa ham).
 */
export const RENDER_COST = {
  elementUs: 48,
  elementBytes: 13 * 1024,
  highlightedCodeUsPerChar: 28,
  highlightedCodeBytesPerChar: 300,
  plainCodeUsPerChar: 1,
  textUsPerChar: 0.3,
  textBytesPerChar: 12,
  budgetUs: 900_000,
  budgetBytes: 190 * 1024 * 1024,
} as const;

export interface RenderCostInput {
  elements: number;
  textChars: number;
  highlightedCodeChars: number;
  plainCodeChars: number;
}

/** Hujjat hisob-kitob ko'rsatkichlaridan taxminiy render vaqti (mks) va xotirasi (bayt). */
export function estimateRenderCost(input: RenderCostInput): { us: number; bytes: number } {
  const c = RENDER_COST;
  return {
    us: input.elements * c.elementUs + input.highlightedCodeChars * c.highlightedCodeUsPerChar + input.plainCodeChars * c.plainCodeUsPerChar + input.textChars * c.textUsPerChar,
    bytes: input.elements * c.elementBytes + input.highlightedCodeChars * c.highlightedCodeBytesPerChar + input.textChars * c.textBytesPerChar,
  };
}

export type DocValidationMode = "panel" | "connector";

export interface DocValidationOptions {
  mode: DocValidationMode;
  /** konnektor: rasm `src` qiymati shu blogning o'z media manzilimi (R2 ochiq baza yoki `<API_ORIGIN>/uploads/...`)? */
  isAllowedImageUrl?: (url: string) => boolean;
}

export type DocValidationResult = { ok: true; doc: unknown } | { ok: false; message: string };

const NODE_SET: ReadonlySet<string> = new Set(DOC_NODE_TYPES);
const MARK_SET: ReadonlySet<string> = new Set(DOC_MARK_TYPES);
/** `//host` va `/\\host` — brauzer ikkalasini ham protokolsiz tashqi manzil deb o'qiydi, shu sabab sayt ichidagi yo'l (`/...`) ularni qabul qilmaydi. */
const SAFE_URL = /^(https?:\/\/|mailto:|\/(?![/\\])|#)/i;

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
    const maxSpan = mode === "connector" ? DOC_LIMITS.connectorMaxSpan : DOC_LIMITS.maxSpan;
    for (const k of ["colspan", "rowspan"] as const) {
      if (a[k] !== undefined && a[k] !== null && !isInt(a[k], 1, maxSpan)) bad(`${path}: ${k} must be an integer 1-${maxSpan}`);
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
  let elements = 0;
  let images = 0;
  let size = 0;
  let textChars = 0;
  let highlightedCode = 0;
  let plainCode = 0;
  const grow = (n: number) => {
    size += n;
    if (size > DOC_LIMITS.maxDocSize) bad(`the document is larger than ${DOC_LIMITS.maxDocSize} characters (serialized)`);
  };

  const walk = (node: unknown, depth: number, path: string, parentType: string | null): unknown => {
    if (!isObj(node)) return bad(`${path}: a node must be an object`);
    if (depth > DOC_LIMITS.maxDepth) bad(`${path}: nested deeper than ${DOC_LIMITS.maxDepth} levels`);
    if (++nodes > DOC_LIMITS.maxNodes) bad(`the document has more than ${DOC_LIMITS.maxNodes} nodes`);
    grow(24);
    const type = node.type;
    if (typeof type !== "string" || !NODE_SET.has(type)) return bad(`${path}: unknown node type${typeof type === "string" ? ` "${type.slice(0, 40)}"` : ""}`);
    if (depth === 0 && type !== "doc") bad(`the root must be a "doc" node`);
    if (depth > 0 && type === "doc") bad(`${path}: "doc" can only be the root`);

    const out: Record<string, unknown> = { type };
    const here = `${path}/${type}`;

    if (type !== "text" && type !== "doc") {
      if (++elements > DOC_LIMITS.maxRenderElements) bad(`the document has more than ${DOC_LIMITS.maxRenderElements} rendered elements (blocks, inline nodes and formatting marks together)`);
    }
    if (type === "image" && ++images > DOC_LIMITS.maxImages) bad(`the document has more than ${DOC_LIMITS.maxImages} images`);

    if (type === "text") {
      if (typeof node.text !== "string") bad(`${here}: text must be a string`);
      if ((node.text as string).length > DOC_LIMITS.maxTextLength) bad(`${here}: text is longer than ${DOC_LIMITS.maxTextLength} characters`);
      textChars += (node.text as string).length;
      if (textChars > DOC_LIMITS.maxTotalText) bad(`the document has more than ${DOC_LIMITS.maxTotalText} characters of text in total`);
      grow((node.text as string).length);
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
      for (const k of keys) {
        checkAttrValue(here, k, attrs[k]);
        const v = attrs[k];
        grow(k.length + 4 + (typeof v === "string" ? v.length : Array.isArray(v) ? v.length * 6 : 8));
      }
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
      elements += marks.length;
      if (elements > DOC_LIMITS.maxRenderElements) bad(`the document has more than ${DOC_LIMITS.maxRenderElements} rendered elements (blocks, inline nodes and formatting marks together)`);
      grow(marks.length * 24);
      const outMarks: unknown[] = [];
      for (const m of marks) {
        if (!isObj(m) || typeof m.type !== "string" || !MARK_SET.has(m.type)) return bad(`${here}: unknown mark type`);
        if (m.attrs !== undefined && m.attrs !== null) {
          if (!isObj(m.attrs)) bad(`${here}: mark attrs must be an object`);
          const mk = Object.keys(m.attrs as object);
          if (mk.length > 16) bad(`${here}: too many mark attributes`);
          for (const k of mk) {
            checkAttrValue(here, k, (m.attrs as Record<string, unknown>)[k]);
            const mv = (m.attrs as Record<string, unknown>)[k];
            grow(k.length + 4 + (typeof mv === "string" ? mv.length : 8));
          }
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
      if (type === "table") {
        // Jadval renderi birinchi qatordagi HAR ustun uchun `<col>` chiqaradi (colspan'lar yig'indisi) — bular ham render elementlari.
        const first = content[0];
        let columns = 0;
        if (isObj(first) && first.type === "tableRow" && Array.isArray(first.content)) {
          for (const c of first.content as unknown[]) {
            const span = isObj(c) && isObj(c.attrs) && isInt(c.attrs.colspan, 1, DOC_LIMITS.maxSpan) ? c.attrs.colspan : 1;
            columns += span; // eng ko'pi bilan maxTableCellsPerRow * maxSpan (= 1024): qatorlar soni keyin tekshiriladi
          }
        }
        elements += columns;
        if (elements > DOC_LIMITS.maxRenderElements) bad(`the document has more than ${DOC_LIMITS.maxRenderElements} rendered elements (blocks, inline nodes, formatting marks and table columns together)`);
      }
      if (type === "tableRow") {
        if (content.length > DOC_LIMITS.maxTableCellsPerRow) bad(`${here}: a table row can have at most ${DOC_LIMITS.maxTableCellsPerRow} cells`);
        cells += content.length;
        const maxCells = connector ? DOC_LIMITS.connectorMaxTableCells : DOC_LIMITS.maxTableCells;
        if (cells > maxCells) bad(`the document has more than ${maxCells} table cells`);
      }
      const children: unknown[] = [];
      const textBefore = textChars;
      for (let i = 0; i < content.length; i++) children.push(walk(content[i], depth + 1, `${here}[${i}]`, type));
      out.content = children;
      if (type === "codeBlock") {
        const codeChars = textChars - textBefore;
        const language = isObj(node.attrs) ? (node.attrs as Record<string, unknown>).language : null;
        if (typeof language === "string" && language !== "") {
          highlightedCode += codeChars;
          if (highlightedCode > DOC_LIMITS.maxHighlightedCode) bad(`the document has more than ${DOC_LIMITS.maxHighlightedCode} characters of code blocks that have a language set (syntax highlighting is expensive; remove the language from the longest blocks or split the post)`);
        } else plainCode += codeChars;
        if (highlightedCode + plainCode > DOC_LIMITS.maxTotalCode) bad(`the document has more than ${DOC_LIMITS.maxTotalCode} characters of code in total`);
      }
    }
    void parentType;
    return connector ? out : node;
  };

  try {
    const walked = walk(doc, 0, "doc", null);
    const estimate = estimateRenderCost({ elements, textChars, highlightedCodeChars: highlightedCode, plainCodeChars: plainCode });
    if (estimate.us > RENDER_COST.budgetUs || estimate.bytes > RENDER_COST.budgetBytes) {
      bad(`the document is too heavy to render (estimated ${Math.round(estimate.us / 1000)} ms and ${Math.round(estimate.bytes / 1048576)} MB; the allowance is ${RENDER_COST.budgetUs / 1000} ms and ${Math.round(RENDER_COST.budgetBytes / 1048576)} MB) - split it into several posts`);
    }
    return { ok: true, doc: walked };
  } catch (error) {
    if (error instanceof Reject) return { ok: false, message: error.message };
    if (error instanceof RangeError) return { ok: false, message: "the document is nested too deeply" };
    throw error;
  }
}

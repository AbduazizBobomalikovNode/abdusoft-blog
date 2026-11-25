import type { ContentNode as JSONContent } from "./content-stats.js";

/**
 * Markdown → Tiptap JSON (faqat saytdagi 4 ta konverter tushunadigan tugunlar:
 * paragraph, heading 2/3, ro'yxatlar, blockquote, codeBlock, horizontalRule, image, table).
 * DOM kerak emas — Node'da ham ishlaydi (testlar uchun).
 */

export interface MarkdownResult {
  /** Birinchi `# ` sarlavha (hujjatdan olib tashlangan) — post sarlavhasi uchun. */
  title: string | null;
  doc: JSONContent;
  /**
   * Faqat chegaraga urilgan bo'lsagina: qaysi chegaralar ishga tushgani (matn jimgina soddalashtirilmasin deb xabar qilinadi).
   * `inline-nesting` / `block-nesting` — juda chuqur ichma-ich; `table-size` — jadval juda keng yoki katta.
   */
  limited?: string[];
}

/** Parser chegaralari: oddiy hujjatlar ularga yetmaydi; faqat zararli/buzuq kirishlar uchun (vaqt va xotira kafolati). */
export const MARKDOWN_LIMITS = { maxInlineDepth: 32, maxBlockDepth: 32, maxTableColumns: 64, maxTableCells: 20_000 } as const;

let limitNotes: Set<string> | null = null;
function noteLimit(reason: string): void {
  limitNotes?.add(reason);
}

interface Mark {
  type: string;
  attrs?: Record<string, unknown>;
}

const CALLOUT_ALERTS: Record<string, string> = {
  NOTE: "ℹ️",
  IMPORTANT: "ℹ️",
  INFO: "ℹ️",
  TIP: "💡",
  WARNING: "⚠️",
  CAUTION: "⚠️",
};

const LANGUAGE_ALIASES: Record<string, string> = {
  ts: "typescript",
  typescript: "typescript",
  js: "javascript",
  javascript: "javascript",
  jsx: "javascript",
  tsx: "tsx",
  json: "json",
  sh: "bash",
  shell: "bash",
  bash: "bash",
  zsh: "bash",
  py: "python",
  python: "python",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  css: "css",
  text: "plaintext",
  txt: "plaintext",
  plain: "plaintext",
  plaintext: "plaintext",
};

export function normalizeCodeLanguage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  return LANGUAGE_ALIASES[key] ?? (/^[a-z0-9+#-]{1,20}$/.test(key) ? key : null);
}

// ---------------------------------------------------------------- inline

function pushText(out: JSONContent[], text: string, marks: Mark[]): void {
  if (!text) return;
  const last = out[out.length - 1];
  const sameMarks = (a: Mark[] | undefined, b: Mark[]) => JSON.stringify(a ?? []) === JSON.stringify(b);
  if (last && last.type === "text" && sameMarks(last.marks as Mark[] | undefined, marks)) {
    last.text = (last.text ?? "") + text;
    return;
  }
  const node: JSONContent = { type: "text", text };
  if (marks.length > 0) node.marks = marks.map((m) => ({ ...m }));
  out.push(node);
}

const WS = /\s/;
const ALNUM = /[A-Za-z0-9]/;

/**
 * Qisqa satrlar (juda ko'pchilik hollar) uchun indeks qurish qimmatroq: ular eski to'g'ridan-to'g'ri skanerlashdan
 * foydalanadi (o'lcham bilan chegaralangan, shuning uchun kvadratik xavf yo'q). Uzun satrlar indeksga o'tadi.
 */
let SMALL_INLINE = 192;

/** Faqat testlar uchun: indekslangan yo'lni qisqa satrlarda ham majburan ishlatish (ekvivalentlik testi). */
export function setInlineIndexThreshold(chars: number): void {
  SMALL_INLINE = chars;
}

function findClosingNaive(src: string, from: number, token: string): number {
  let i = from;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src.startsWith(token, i) && i > from && !/\s/.test(src[i - 1] ?? "")) return i;
    i++;
  }
  return -1;
}

function findItalicCloseNaive(src: string, ch: string, start: number): number {
  for (let j = start; j < src.length; j++) {
    if (src[j] === "\\") {
      j++;
      continue;
    }
    if (src[j] === ch && src[j + 1] !== ch && src[j - 1] !== ch && !/\s/.test(src[j - 1] ?? "") && !(ch === "_" && /[A-Za-z0-9]/.test(src[j + 1] ?? " "))) return j;
  }
  return -1;
}

function findPairEndNaive(src: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Bir `parseInline` chaqiruvi uchun BIR MARTA, kerak bo'lganda quriladigan indekslar (har biri O(n)). Ular eski
 * "har ochuvchi uchun oxirigacha skanerlash" (O(n^2)) o'rnini bosadi va aynan shu natijani beradi:
 * `\` ketma-ketligidan keyingi belgi skanerlashda o'tkazib yuboriladi (juft-juft), shuning uchun "ko'rilgan" pozitsiyalar
 * chapdan o'ngga bitta o'tishda aniqlanadi (so'rov har doim `\`dan keyin boshlanmaydigan joydan boshlanadi).
 */
class InlineIndex {
  private vis: Uint8Array | null = null;
  private readonly closers = new Map<string, Int32Array>();
  private readonly italics = new Map<string, Int32Array>();
  private brackets: Int32Array | null = null;
  private parens: Int32Array | null = null;
  private tickRun: Int32Array | null = null;
  private tickMax: Int32Array | null = null;
  private autoLo = 0;
  private autoHi = -1;
  private urlLo = 0;
  private urlHi = -1;

  constructor(readonly src: string) {}

  private visited(): Uint8Array {
    if (this.vis) return this.vis;
    const n = this.src.length;
    const vis = new Uint8Array(n + 2);
    let p = 0;
    while (p < n) {
      vis[p] = 1;
      p += this.src.charCodeAt(p) === 92 ? 2 : 1;
    }
    this.vis = vis;
    return vis;
  }

  /** `p` dan boshlab birinchi yopuvchi `token` pozitsiyasi (oldingi belgi bo'shliq emas, "ko'rilgan"), yo'q bo'lsa -1. */
  nextClose(token: string, p: number): number {
    if (this.src.length <= SMALL_INLINE) return findClosingNaive(this.src, p - 1, token);
    let table = this.closers.get(token);
    const src = this.src;
    const n = src.length;
    if (!table) {
      const vis = this.visited();
      table = new Int32Array(n + 2).fill(-1);
      const first = token.charCodeAt(0);
      for (let i = n - 1; i >= 0; i--) {
        table[i] = table[i + 1] as number;
        if (src.charCodeAt(i) === first && vis[i] === 1 && i > 0 && src.startsWith(token, i) && !WS.test(src[i - 1] ?? "")) table[i] = i;
      }
      this.closers.set(token, table);
    }
    return p >= n ? -1 : (table[p] as number);
  }

  /** `*`/`_` uchun yopuvchi pozitsiya (eski for-sikl shartlari bilan bir xil). */
  nextItalic(ch: string, p: number): number {
    if (this.src.length <= SMALL_INLINE) return findItalicCloseNaive(this.src, ch, p);
    let table = this.italics.get(ch);
    const src = this.src;
    const n = src.length;
    if (!table) {
      const vis = this.visited();
      table = new Int32Array(n + 2).fill(-1);
      for (let j = n - 1; j >= 0; j--) {
        table[j] = table[j + 1] as number;
        if (
          vis[j] === 1 &&
          src[j] === ch &&
          src[j + 1] !== ch &&
          src[j - 1] !== ch &&
          !WS.test(src[j - 1] ?? "") &&
          !(ch === "_" && ALNUM.test(src[j + 1] ?? " "))
        ) {
          table[j] = j;
        }
      }
      this.italics.set(ch, table);
    }
    return p >= n ? -1 : (table[p] as number);
  }

  private pairTable(open: number, close: number): Int32Array {
    const src = this.src;
    const n = src.length;
    const vis = this.visited();
    const table = new Int32Array(n + 1).fill(-1);
    const stack: number[] = [];
    for (let p = 0; p < n; p++) {
      if (vis[p] !== 1) continue;
      const c = src.charCodeAt(p);
      if (c === open) stack.push(p);
      else if (c === close && stack.length > 0) table[stack.pop() as number] = p;
    }
    return table;
  }

  /** `open` (`[`) ga mos `]` pozitsiyasi yoki -1. */
  bracketEnd(open: number): number {
    if (this.src.length <= SMALL_INLINE) return findPairEndNaive(this.src, open, "[", "]");
    this.brackets ??= this.pairTable(91, 93);
    return this.brackets[open] ?? -1;
  }

  /** `open` (`(`) ga mos `)` pozitsiyasi yoki -1. */
  parenEnd(open: number): number {
    if (this.src.length <= SMALL_INLINE) return findPairEndNaive(this.src, open, "(", ")");
    this.parens ??= this.pairTable(40, 41);
    return this.parens[open] ?? -1;
  }

  private ticks(): { run: Int32Array; max: Int32Array } {
    if (!this.tickRun || !this.tickMax) {
      const src = this.src;
      const n = src.length;
      const run = new Int32Array(n + 1);
      const max = new Int32Array(n + 1);
      for (let p = n - 1; p >= 0; p--) {
        run[p] = src.charCodeAt(p) === 96 ? (run[p + 1] as number) + 1 : 0;
        max[p] = Math.max(run[p] as number, max[p + 1] as number);
      }
      this.tickRun = run;
      this.tickMax = max;
    }
    return { run: this.tickRun, max: this.tickMax };
  }

  /** `i` dagi teskari tirnoqlar soni (qator oxirigacha). */
  tickRunAt(i: number): number {
    if (this.src.length <= SMALL_INLINE) {
      let k = 0;
      while (this.src.charCodeAt(i + k) === 96) k++;
      return k;
    }
    return this.ticks().run[i] as number;
  }

  /** `k` ta ketma-ket tirnoq uchun `from` dan boshlab birinchi pozitsiya (`indexOf` bilan bir xil), yo'q bo'lsa -1 — O(1) rad etish bilan. */
  tickSearch(k: number, from: number): number {
    const n = this.src.length;
    if (from >= n) return -1;
    if (n <= SMALL_INLINE) return this.src.indexOf("`".repeat(k), from);
    if ((this.ticks().max[from] as number) < k) return -1;
    return this.src.indexOf("`".repeat(k), from);
  }

  /** `from` dan boshlab birinchi bo'shliq yoki `>` (avto-havola uchun); bir xil uzluksiz qism qayta skanerlanmaydi. */
  autoLinkEnd(from: number): number {
    if (from >= this.autoLo && from <= this.autoHi) return this.autoHi;
    const src = this.src;
    let e = from;
    while (e < src.length && src[e] !== ">" && !WS.test(src[e] as string)) e++;
    this.autoLo = from;
    this.autoHi = e;
    return e;
  }

  /** `from` dan boshlab birinchi bo'shliq, `<`, `>` yoki `"` (yalang'och URL uchun). */
  bareUrlEnd(from: number): number {
    if (from >= this.urlLo && from <= this.urlHi) return this.urlHi;
    const src = this.src;
    let e = from;
    while (e < src.length) {
      const c = src[e] as string;
      if (c === "<" || c === ">" || c === '"' || WS.test(c)) break;
      e++;
    }
    this.urlLo = from;
    this.urlHi = e;
    return e;
  }
}

function parseLinkTarget(src: string, openParen: number, idx: InlineIndex): { url: string; title: string | null; end: number } | null {
  if (src[openParen] !== "(") return null;
  const end = idx.parenEnd(openParen);
  if (end < 0) return null;
  const inner = src.slice(openParen + 1, end).trim();
  // Chaqiruvchilar faqat SAFE_URL'dan o'tgan manzilni qabul qiladi; boshi mos kelmasa butun qatorni regexga bermaymiz.
  if (!SAFE_URL.test(inner.startsWith("<") ? inner.slice(1, 12) : inner.slice(0, 11))) return null;
  const match = /^<?([^\s>]+)>?(?:\s+["']([^"']*)["'])?$/.exec(inner);
  if (!match) return null;
  return { url: match[1] ?? "", title: match[2] ?? null, end: end + 1 };
}

const SAFE_URL = /^(https?:\/\/|mailto:|\/|#)/i;
const URL_TRIM = new Set([".", ",", ";", ":", "!", "?", ")", "]"]);

function pushAll(out: JSONContent[], nodes: JSONContent[]): void {
  for (const node of nodes) out.push(node);
}

function parseInline(src: string, marks: Mark[], depth = 0): JSONContent[] {
  const out: JSONContent[] = [];
  if (depth > MARKDOWN_LIMITS.maxInlineDepth) {
    noteLimit("inline-nesting");
    pushText(out, src, marks);
    return out;
  }
  const idx = new InlineIndex(src);
  let plain = "";
  const flush = () => {
    pushText(out, plain, marks);
    plain = "";
  };
  let i = 0;
  scan: while (i < src.length) {
    const ch = src[i] ?? "";

    if (ch === "\\" && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!|>~]/.test(src[i + 1] ?? "")) {
      plain += src[i + 1];
      i += 2;
      continue;
    }

    if (ch === "`") {
      const k = idx.tickRunAt(i);
      const close = idx.tickSearch(k, i + k);
      if (close > i + k - 1) {
        flush();
        const code = src.slice(i + k, close).trim();
        // `code` belgisi boshqa belgilar bilan birga bo'lmaydi (schema: excludes "_").
        if (code) out.push({ type: "text", text: code, marks: [{ type: "code" }] });
        i = close + k;
        continue;
      }
    }

    if (ch === "!" && src[i + 1] === "[") {
      const end = idx.bracketEnd(i + 1);
      const target = end > 0 ? parseLinkTarget(src, end + 1, idx) : null;
      if (end > 0 && target && SAFE_URL.test(target.url)) {
        flush();
        const attrs: Record<string, unknown> = { src: target.url, alt: src.slice(i + 2, end).replace(/\\([\\[\]])/g, "$1") };
        if (target.title) attrs.title = target.title;
        out.push({ type: "image", attrs });
        i = target.end;
        continue;
      }
    }

    if (ch === "[") {
      const end = idx.bracketEnd(i);
      const target = end > 0 ? parseLinkTarget(src, end + 1, idx) : null;
      if (end > 0 && target && SAFE_URL.test(target.url)) {
        flush();
        const linkMarks: Mark[] = [...marks.filter((m) => m.type !== "link"), { type: "link", attrs: { href: target.url } }];
        pushAll(out, parseInline(src.slice(i + 1, end), linkMarks, depth + 1));
        i = target.end;
        continue;
      }
    }

    if (ch === "<") {
      const schemeLen = src.startsWith("<http://", i) ? 8 : src.startsWith("<https://", i) ? 9 : 0;
      if (schemeLen > 0) {
        const e = idx.autoLinkEnd(i + schemeLen);
        if (e > i + schemeLen && src[e] === ">") {
          const href = src.slice(i + 1, e);
          flush();
          out.push({ type: "text", text: href, marks: [...marks, { type: "link", attrs: { href } }] });
          i = e + 1;
          continue;
        }
      }
    }

    if (ch === "h" && (src.startsWith("http://", i) || src.startsWith("https://", i)) && !ALNUM.test(src[i - 1] ?? " ") && !marks.some((m) => m.type === "link")) {
      const schemeEnd = i + (src.startsWith("https://", i) ? 8 : 7);
      const runEnd = idx.bareUrlEnd(schemeEnd);
      if (runEnd > schemeEnd) {
        let tEnd = runEnd;
        while (tEnd > schemeEnd && URL_TRIM.has(src[tEnd - 1] as string)) tEnd--;
        if (tEnd - i > 8) {
          const trimmed = src.slice(i, tEnd);
          flush();
          out.push({ type: "text", text: trimmed, marks: [...marks, { type: "link", attrs: { href: trimmed } }] });
          i += trimmed.length;
          continue;
        }
      }
    }

    for (const [token, markType] of [
      ["**", "bold"],
      ["__", "bold"],
      ["~~", "strike"],
    ] as const) {
      if (src.startsWith(token, i) && !WS.test(src[i + token.length] ?? " ")) {
        const close = idx.nextClose(token, i + token.length + 1);
        if (close > 0) {
          flush();
          pushAll(out, parseInline(src.slice(i + token.length, close), [...marks, { type: markType }], depth + 1));
          i = close + token.length;
          continue scan;
        }
      }
    }
    if (i !== src.length && (ch === "*" || ch === "_") && src[i + 1] !== ch && !WS.test(src[i + 1] ?? " ")) {
      const intraword = ch === "_" && ALNUM.test(src[i - 1] ?? " ");
      if (!intraword) {
        const close = idx.nextItalic(ch, i + 1);
        if (close > 0) {
          flush();
          pushAll(out, parseInline(src.slice(i + 1, close), [...marks, { type: "italic" }], depth + 1));
          i = close + 1;
          continue;
        }
      }
    }

    plain += ch;
    i++;
  }
  flush();
  return out;
}

/** Inline tugunlardagi `image`larni ajratib, paragraf bloklariga bo'ladi (image — blok tugun). */
function paragraphsFromInline(inline: JSONContent[]): JSONContent[] {
  const blocks: JSONContent[] = [];
  let current: JSONContent[] = [];
  const flush = () => {
    if (current.length > 0) blocks.push({ type: "paragraph", content: current });
    current = [];
  };
  for (const node of inline) {
    if (node.type === "image") {
      flush();
      blocks.push(node);
    } else current.push(node);
  }
  flush();
  return blocks;
}

function inlineWithBreaks(lines: string[]): JSONContent[] {
  const out: JSONContent[] = [];
  lines.forEach((line, idx) => {
    // Qator oxiridagi 2+ bo'shliq yoki `\\` — qattiq uzilish (regex o'rniga qo'lda: uzun bo'shliq qatorlarida kvadratik emas).
    let trailingSpaces = 0;
    while (trailingSpaces < line.length && line.charCodeAt(line.length - 1 - trailingSpaces) === 32) trailingSpaces++;
    const endsWithBackslash = line.endsWith("\\");
    const hard = trailingSpaces >= 2 || endsWithBackslash;
    const clean = (endsWithBackslash ? line.slice(0, -1) : line).trim();
    const nodes = parseInline(clean, []);
    for (const n of nodes) {
      const last = out[out.length - 1];
      if (n.type === "text" && last?.type === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(n.marks ?? []) && idx === 0) last.text = (last.text ?? "") + (n.text ?? "");
      else out.push(n);
    }
    if (idx < lines.length - 1) {
      if (hard) out.push({ type: "hardBreak" });
      else pushText(out, " ", []);
    }
  });
  return out;
}

// ---------------------------------------------------------------- blocks

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;
const FENCE_INFO = /^\s*([^`\s]*)/;
const HEADING_HEAD = /^\s{0,3}(#{1,6})\s+/;
const HEADING_FULL = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Eski `FENCE` regexining chiziqli ekvivalenti: ``` yoki ~~~ ochuvchi qator (qolgan qismda teskari tirnoq bo'lmasligi shart). */
function execFence(line: string): [string, string, string] | null {
  const open = FENCE_OPEN.exec(line);
  if (!open) return null;
  if (line.indexOf("`", open[0].length) !== -1) return null;
  const info = FENCE_INFO.exec(line.slice(open[0].length));
  return [line, open[1] as string, info?.[1] ?? ""];
}

/** Eski `HEADING` regexining chiziqli ekvivalenti (oxiridagi `#` va bo'shliqlar kesiladi). */
function execHeading(line: string): [string, string, string] | null {
  const head = HEADING_HEAD.exec(line);
  if (!head) return null;
  // `.` satr ajratuvchilarni (U+2028/2029) qabul qilmaydi — bunday nodir qatorlarda eski regex aynan o'zi ishlaydi.
  if (line.includes("\u2028") || line.includes("\u2029")) {
    const m = HEADING_FULL.exec(line);
    return m ? [m[0], m[1] as string, m[2] ?? ""] : null;
  }
  let end = line.length;
  while (end > head[0].length && WS.test(line[end - 1] as string)) end--;
  while (end > head[0].length && line[end - 1] === "#") end--;
  while (end > head[0].length && WS.test(line[end - 1] as string)) end--;
  return [line, head[1] as string, line.slice(head[0].length, end)];
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (s[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function isTableStart(lines: string[], i: number): boolean {
  const head = lines[i] ?? "";
  const sep = lines[i + 1];
  return head.includes("|") && sep !== undefined && sep.includes("-") && TABLE_SEP.test(sep.trim()) && splitRow(head).length === splitRow(sep).length;
}

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i] ?? "";
  return execFence(line) !== null || execHeading(line) !== null || HR.test(line) || QUOTE.test(line) || (LIST_ITEM.test(line) && !HR.test(line)) || isTableStart(lines, i);
}

interface ParseCtx {
  /** `#` (H1) sarlavhalar uchun — true bo'lsa birinchisi sarlavhaga ajratiladi. */
  titleSlot: { value: string | null } | null;
}

function parseList(lines: string[], start: number, ctx: ParseCtx, depth: number): { node: JSONContent; next: number } {
  const first = LIST_ITEM.exec(lines[start] ?? "") as RegExpExecArray;
  const baseIndent = (first[1] ?? "").length;
  const ordered = /\d/.test(first[2] ?? "");
  const items: JSONContent[] = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i] ?? "");
    if (!m || HR.test(lines[i] ?? "")) break;
    const indent = (m[1] ?? "").length;
    if (indent < baseIndent) break;
    if (indent > baseIndent && depth >= MARKDOWN_LIMITS.maxBlockDepth) noteLimit("block-nesting");
    if (indent > baseIndent && depth < MARKDOWN_LIMITS.maxBlockDepth) {
      // ichki ro'yxat — oxirgi elementga qo'shiladi
      const nested = parseList(lines, i, ctx, depth + 1);
      const lastItem = items[items.length - 1];
      if (lastItem?.content) lastItem.content.push(nested.node);
      i = nested.next;
      continue;
    }
    if (/\d/.test(m[2] ?? "") !== ordered) break;
    const text = (m[3] ?? "").replace(/^\[[ xX]\]\s+/, "");
    const itemLines = [text];
    i++;
    while (i < lines.length && (lines[i] ?? "").trim() !== "" && !LIST_ITEM.test(lines[i] ?? "") && /^\s+\S/.test(lines[i] ?? "")) {
      itemLines.push((lines[i] ?? "").trim());
      i++;
    }
    const inline = inlineWithBreaks(itemLines);
    const para: JSONContent = inline.length > 0 ? { type: "paragraph", content: inline.filter((n) => n.type !== "image") } : { type: "paragraph" };
    items.push({ type: "listItem", content: [para] });
    // ro'yxat elementlari orasidagi bitta bo'sh qatorga ruxsat
    if (i < lines.length && (lines[i] ?? "").trim() === "" && LIST_ITEM.test(lines[i + 1] ?? "") && (LIST_ITEM.exec(lines[i + 1] ?? "")?.[1] ?? "").length >= baseIndent) i++;
  }
  const node: JSONContent = { type: ordered ? "orderedList" : "bulletList", content: items };
  if (ordered) {
    const startNum = Number.parseInt(first[2] ?? "1", 10);
    if (startNum !== 1) node.attrs = { start: startNum };
  }
  return { node, next: i };
}

function parseBlocks(lines: string[], ctx: ParseCtx, depth = 0): JSONContent[] {
  const blocks: JSONContent[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = execFence(line);
    if (fence) {
      const marker = (fence[1] ?? "```")[0] as string;
      const lang = normalizeCodeLanguage(fence[2]);
      const body: string[] = [];
      i++;
      const closer = new RegExp(`^\\s{0,3}${marker}{3,}\\s*$`);
      while (i < lines.length && !closer.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i++;
      }
      i++; // yopuvchi fence
      const node: JSONContent = { type: "codeBlock", attrs: { language: lang } };
      const code = body.join("\n");
      if (code) node.content = [{ type: "text", text: code }];
      blocks.push(node);
      continue;
    }

    const heading = execHeading(line);
    if (heading) {
      const hashes = (heading[1] ?? "#").length;
      const text = heading[2] ?? "";
      if (hashes === 1 && ctx.titleSlot && ctx.titleSlot.value === null && blocks.length === 0) {
        ctx.titleSlot.value = text.replace(/[*_`]/g, "").trim();
      } else {
        const level = hashes <= 2 ? 2 : 3;
        const inline = parseInline(text, []).filter((n) => n.type !== "image");
        blocks.push({ type: "heading", attrs: { level }, content: inline.length > 0 ? inline : undefined });
      }
      i++;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ type: "horizontalRule" });
      i++;
      continue;
    }

    if (isTableStart(lines, i) && splitRow(line).length > MARKDOWN_LIMITS.maxTableColumns) noteLimit("table-size");
    if (isTableStart(lines, i) && splitRow(line).length <= MARKDOWN_LIMITS.maxTableColumns) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim() !== "") {
        if ((rows.length + 2) * header.length > MARKDOWN_LIMITS.maxTableCells) {
          noteLimit("table-size");
          break;
        }
        rows.push(splitRow(lines[i] ?? ""));
        i++;
      }
      const cell = (type: "tableHeader" | "tableCell", text: string): JSONContent => {
        const inline = parseInline(text, []).filter((n) => n.type !== "image");
        return { type, content: [{ type: "paragraph", content: inline.length > 0 ? inline : undefined }] };
      };
      const cols = header.length;
      const tableRows: JSONContent[] = [
        { type: "tableRow", content: header.map((h) => cell("tableHeader", h)) },
        ...rows.map((r) => ({
          type: "tableRow",
          content: Array.from({ length: cols }, (_, c) => cell("tableCell", r[c] ?? "")),
        })),
      ];
      blocks.push({ type: "table", content: tableRows });
      continue;
    }

    if (QUOTE.test(line) && depth >= MARKDOWN_LIMITS.maxBlockDepth) noteLimit("block-nesting");
    if (QUOTE.test(line) && depth < MARKDOWN_LIMITS.maxBlockDepth) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? "")) {
        inner.push((QUOTE.exec(lines[i] ?? "") as RegExpExecArray)[1] ?? "");
        i++;
      }
      // GitHub ogohlantirishlari: `> [!NOTE]` → callout konventsiyasi (emoji bilan boshlangan blockquote)
      const alert = /^\[!(\w+)\]\s*$/.exec((inner[0] ?? "").trim());
      let emoji: string | null = null;
      if (alert && CALLOUT_ALERTS[(alert[1] ?? "").toUpperCase()]) {
        emoji = CALLOUT_ALERTS[(alert[1] ?? "").toUpperCase()] ?? null;
        inner.shift();
      }
      const children = parseBlocks(inner, { titleSlot: null }, depth + 1);
      if (emoji) {
        const firstChild = children[0];
        if (firstChild?.type === "paragraph") firstChild.content = [{ type: "text", text: `${emoji} ` }, ...(firstChild.content ?? [])];
        else children.unshift({ type: "paragraph", content: [{ type: "text", text: `${emoji} ` }] });
      }
      blocks.push({ type: "blockquote", content: children.length > 0 ? children : [{ type: "paragraph" }] });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const { node, next } = parseList(lines, i, ctx, 0);
      blocks.push(node);
      i = next;
      continue;
    }

    // paragraf
    const para: string[] = [line];
    i++;
    while (i < lines.length && (lines[i] ?? "").trim() !== "" && !startsBlock(lines, i)) {
      para.push(lines[i] ?? "");
      i++;
    }
    blocks.push(...paragraphsFromInline(inlineWithBreaks(para)));
  }
  return blocks;
}

export function markdownToDoc(markdown: string): MarkdownResult {
  const lines = markdown.replace(/\r\n?/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "").split("\n");
  const titleSlot: { value: string | null } = { value: null };
  const previousNotes = limitNotes;
  const notes = new Set<string>();
  limitNotes = notes;
  let blocks: JSONContent[];
  try {
    blocks = parseBlocks(lines, { titleSlot });
  } finally {
    limitNotes = previousNotes;
  }
  return {
    title: titleSlot.value,
    doc: { type: "doc", content: blocks.length > 0 ? blocks : [{ type: "paragraph" }] },
    ...(notes.size > 0 ? { limited: [...notes].sort() } : {}),
  };
}

/**
 * Matn Markdown'ga o'xshaydimi? Oddiy matnni yo'qotmaslik uchun ehtiyotkor:
 * blok belgilari (sarlavha, ro'yxat, iqtibos, kod, jadval) yoki aniq inline belgilar.
 */
export function looksLikeMarkdown(text: string): boolean {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let signals = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s{0,3}#{1,6}\s+\S/.test(line)) signals += 2;
    else if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) signals += 2;
    else if (isTableStart(lines, i)) signals += 2;
    else if (/^\s{0,3}>\s?\S/.test(line)) signals += 1;
    else if (/^\s*[-*+]\s+\S/.test(line) || /^\s*\d{1,9}[.)]\s+\S/.test(line)) signals += 1;
    else if (HR.test(line) && lines.length > 1) signals += 1;
    if (/\*\*[^*\s][^*]*\*\*/.test(line) || /\[[^\]]+\]\(https?:\/\/[^)\s]+\)/.test(line) || /(^|\s)`[^`\n]+`(\s|$|[.,;:])/.test(line)) signals += 1;
  }
  return signals >= 2 || /^\s{0,3}#{1,6}\s+\S/.test(text);
}

export function isImageUrl(text: string): boolean {
  return /^https?:\/\/[^\s?#]+\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#]\S*)?$/i.test(text.trim());
}

export function isBareUrl(text: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(text.trim());
}

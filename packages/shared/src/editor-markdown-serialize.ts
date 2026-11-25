import type { ContentNode } from "./content-stats.js";
import { markdownToDoc, normalizeCodeLanguage } from "./editor-markdown.js";

/**
 * Tiptap hujjati -> Markdown (`markdownToDoc`ning teskarisi) va "aylanib o'tish" (round trip) tahlili.
 *
 * Kafolat tushunchasi: hujjat `D` uchun `markdownToDoc(docToMarkdown(D))` natijasi `D`ga TENG bo'lsa (quyidagi
 * `normalizeDoc` bo'yicha), `D` Markdown orqali yo'qotishsiz tahrirlanadi. Buni FAKTIK tekshirish bilan aniqlaymiz
 * (`analyzeDocMarkdown`): har bir yuqori darajadagi blok alohida serializatsiya qilinadi, qayta o'qiladi va solishtiriladi —
 * tenglashmaydigan bloklar "lossy" deb ro'yxatga olinadi (indeks, tur, qisqa ko'rinish, sabab). Shu sababli kafolat
 * parser/serializer o'zgarsa ham o'z-o'zidan to'g'ri qoladi.
 *
 * Kanonik shakl (`normalizeDoc`): bu farqlar "sezilmaydigan" hisoblanadi va yo'qotish emas —
 *  - yuqori darajadagi (va iqtibos ichidagi) BO'SH paragraflar (ular faqat bo'sh joy);
 *  - paragraf/sarlavha/jadval katagi chetidagi bo'shliqlar, belgi (qalin/kursiv/...) chegarasidagi bo'shliqlar
 *    belgidan tashqariga chiqariladi ("**a **b" -> "**a** b");
 *  - hardBreak orqali kesilgan belgilar ikki alohida belgi sifatida;
 *  - standart atributlar (`link.target/rel/class` standart qiymatlari, `orderedList.start = 1`, `colspan/rowspan = 1`, null atributlar);
 *  - belgilar tartibi, qo'shni bir xil belgili matnlarning birlashishi;
 *  - kod tili alias'lari (`ts` -> `typescript`).
 */

type Mark = { type: string; attrs?: Record<string, unknown> };

const MARK_ORDER = ["link", "bold", "italic", "strike", "code"];
const DEFAULT_LINK_ATTRS: Record<string, unknown> = { target: "_blank", rel: "noopener noreferrer nofollow", class: null };

// ------------------------------------------------------------------ normalizatsiya

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined;
}

function cleanAttrs(attrs: Record<string, unknown> | undefined, defaults: Record<string, unknown> = {}): Record<string, unknown> | undefined {
  if (!attrs) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (isEmpty(value)) continue;
    if (key in defaults && defaults[key] === value) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeMark(mark: Mark): Mark {
  if (mark.type === "link") {
    const attrs = cleanAttrs(mark.attrs, DEFAULT_LINK_ATTRS);
    return attrs ? { type: "link", attrs } : { type: "link" };
  }
  const attrs = cleanAttrs(mark.attrs);
  return attrs ? { type: mark.type, attrs } : { type: mark.type };
}

const markKey = (mark: Mark) => `${mark.type}${mark.attrs ? JSON.stringify(sortKeys(mark.attrs)) : ""}`;

function markRank(mark: Mark): number {
  const index = MARK_ORDER.indexOf(mark.type);
  return index === -1 ? MARK_ORDER.length : index;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, inner]) => [key, sortKeys(inner)]),
    );
  }
  return value;
}

interface Seg {
  text: string;
  marks: Mark[];
}

interface RunNode {
  mark: Mark | null;
  children: Array<{ text: string } | RunNode>;
}

const isRun = (child: { text: string } | RunNode): child is RunNode => "children" in child;

function buildRuns(segs: Seg[]): RunNode {
  const root: RunNode = { mark: null, children: [] };
  const stack: RunNode[] = [root];
  for (const seg of segs) {
    let depth = 0;
    while (depth < seg.marks.length && depth + 1 < stack.length && markKey(stack[depth + 1]!.mark as Mark) === markKey(seg.marks[depth]!)) depth++;
    stack.length = depth + 1;
    for (let i = depth; i < seg.marks.length; i++) {
      const run: RunNode = { mark: seg.marks[i]!, children: [] };
      stack[stack.length - 1]!.children.push(run);
      stack.push(run);
    }
    stack[stack.length - 1]!.children.push({ text: seg.text });
  }
  return root;
}

/** Belgi (run) chetidagi bo'shliqlarni belgidan tashqariga chiqaradi; bo'shliqdan iborat run butunlay yo'qoladi. */
function hoist(run: RunNode): void {
  const next: RunNode["children"] = [];
  for (const child of run.children) {
    if (!isRun(child)) {
      if (child.text) next.push(child);
      continue;
    }
    hoist(child);
    const lead = child.children.length > 0 ? takeEdge(child, "lead") : "";
    const trail = child.children.length > 0 ? takeEdge(child, "trail") : "";
    if (lead) next.push({ text: lead });
    if (child.children.length > 0) next.push(child);
    if (trail) next.push({ text: trail });
  }
  run.children = next;
}

function takeEdge(run: RunNode, side: "lead" | "trail"): string {
  let taken = "";
  for (;;) {
    const index = side === "lead" ? 0 : run.children.length - 1;
    const child = run.children[index];
    if (!child) return taken;
    if (isRun(child)) {
      const inner = takeEdge(child, side);
      taken = side === "lead" ? taken + inner : inner + taken;
      if (child.children.length === 0) {
        run.children.splice(index, 1);
        continue;
      }
      return taken;
    }
    const match = side === "lead" ? /^\s+/.exec(child.text) : /\s+$/.exec(child.text);
    if (!match) return taken;
    taken = side === "lead" ? taken + match[0] : match[0] + taken;
    child.text = side === "lead" ? child.text.slice(match[0].length) : child.text.slice(0, child.text.length - match[0].length);
    if (child.text === "") {
      run.children.splice(index, 1);
      continue;
    }
    return taken;
  }
}

function flatten(run: RunNode, inherited: Mark[], out: Seg[]): void {
  const marks = run.mark ? [...inherited, run.mark] : inherited;
  for (const child of run.children) {
    if (isRun(child)) flatten(child, marks, out);
    else out.push({ text: child.text, marks });
  }
}

function mergeSegs(segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (const seg of segs) {
    if (!seg.text) continue;
    const last = out[out.length - 1];
    if (last && last.marks.map(markKey).join("|") === seg.marks.map(markKey).join("|")) last.text += seg.text;
    else out.push({ text: seg.text, marks: seg.marks });
  }
  return out;
}

function normalizeLine(segs: Seg[]): Seg[] {
  const root = buildRuns(segs);
  hoist(root);
  // chetdagi bo'shliqlar (belgidan tashqarida) qirqiladi
  takeEdge(root, "lead");
  takeEdge(root, "trail");
  const flat: Seg[] = [];
  flatten(root, [], flat);
  return mergeSegs(flat);
}

/** Textblock ichki tarkibi: matn + hardBreak (+ noma'lum inline tugunlar o'zgarishsiz). */
function normalizeInline(content: ContentNode[] | undefined): ContentNode[] | undefined {
  const lines: Array<Array<Seg | ContentNode>> = [[]];
  for (const node of content ?? []) {
    if (node.type === "text") {
      const marks = (node.marks ?? []).map(normalizeMark).sort((a, b) => markRank(a) - markRank(b) || (markKey(a) < markKey(b) ? -1 : 1));
      const unique = marks.filter((mark, i) => i === 0 || markKey(mark) !== markKey(marks[i - 1]!));
      lines[lines.length - 1]!.push({ text: node.text ?? "", marks: unique });
    } else if (node.type === "hardBreak") {
      lines.push([]);
    } else {
      lines[lines.length - 1]!.push(normalizeNode(node, false));
    }
  }
  const out: ContentNode[] = [];
  lines.forEach((line, index) => {
    if (index > 0) out.push({ type: "hardBreak" });
    // noma'lum inline tugunlar matn bo'laklarini ajratadi
    let pending: Seg[] = [];
    const flush = () => {
      for (const seg of normalizeLine(pending)) {
        const node: ContentNode = { type: "text", text: seg.text };
        if (seg.marks.length > 0) node.marks = seg.marks;
        out.push(node);
      }
      pending = [];
    };
    for (const item of line) {
      if ("marks" in item && "text" in item && typeof (item as Seg).text === "string" && !("type" in item)) pending.push(item as Seg);
      else {
        flush();
        out.push(item as ContentNode);
      }
    }
    flush();
  });
  return out.length > 0 ? out : undefined;
}

function isEmptyParagraph(node: ContentNode): boolean {
  return node.type === "paragraph" && (!node.content || node.content.length === 0);
}

function normalizeNode(node: ContentNode, dropEmptyParagraphs: boolean): ContentNode {
  const out: ContentNode = { type: node.type };
  switch (node.type) {
    case "text":
      return { type: "text", text: node.text ?? "", ...(node.marks ? { marks: node.marks.map(normalizeMark) } : {}) };
    case "paragraph":
    case "heading": {
      const attrs = cleanAttrs(node.attrs);
      if (attrs) out.attrs = attrs;
      const content = normalizeInline(node.content);
      if (content) out.content = content;
      return out;
    }
    case "codeBlock": {
      const language = normalizeCodeLanguage(typeof node.attrs?.language === "string" ? node.attrs.language : null);
      const attrs = cleanAttrs({ ...(node.attrs ?? {}), language });
      if (attrs) out.attrs = attrs;
      const text = (node.content ?? []).map((child) => child.text ?? "").join("");
      if (text) out.content = [{ type: "text", text }];
      return out;
    }
    case "image": {
      const attrs = cleanAttrs({ ...(node.attrs ?? {}), alt: node.attrs?.alt === "" ? null : node.attrs?.alt });
      if (attrs) out.attrs = attrs;
      return out;
    }
    case "orderedList": {
      const attrs = cleanAttrs(node.attrs, { start: 1 });
      if (attrs) out.attrs = attrs;
      break;
    }
    case "tableCell":
    case "tableHeader": {
      const attrs = cleanAttrs(node.attrs, { colspan: 1, rowspan: 1 });
      if (attrs) out.attrs = attrs;
      break;
    }
    default: {
      const attrs = cleanAttrs(node.attrs);
      if (attrs) out.attrs = attrs;
    }
  }
  if (node.content) {
    const inner = node.content.map((child) => normalizeNode(child, dropEmptyParagraphs || node.type === "blockquote"));
    const dropEmpty = dropEmptyParagraphs || node.type === "blockquote";
    const kept = dropEmpty ? inner.filter((child) => !isEmptyParagraph(child)) : inner;
    if (node.type === "blockquote" && kept.length === 0) out.content = [{ type: "paragraph" }];
    else out.content = kept;
  }
  return out;
}

/** Kanonik shakl (yuqoridagi izohga qarang). */
export function normalizeDoc(doc: ContentNode | null | undefined): ContentNode {
  const blocks = (doc?.content ?? []).map((child) => normalizeNode(child, true)).filter((child) => !isEmptyParagraph(child));
  return { type: "doc", content: blocks.length > 0 ? blocks : [{ type: "paragraph" }] };
}

const stable = (value: unknown) => JSON.stringify(sortKeys(value));

/** Ikki hujjat kanonik shaklda tengmi. */
export function docsEquivalent(a: ContentNode | null | undefined, b: ContentNode | null | undefined): boolean {
  return stable(normalizeDoc(a)) === stable(normalizeDoc(b));
}

// ------------------------------------------------------------------ serializatsiya

/** Qator boshida blok sintaksisiga o'xshab ketadigan belgilarni qochiradi. */
function escapeLineStart(line: string): string {
  if (/^\s*[-_*]([ \t]*[-_*]){2,}\s*$/.test(line)) return `\\${line}`;
  if (/^\s{0,3}([-+*]|\d{1,9}[.)])(\s|$)/.test(line)) {
    return line.replace(/^(\s*)([-+*]|(\d{1,9})([.)]))/, (_m, ws: string, marker: string, digits?: string, punct?: string) =>
      digits ? `${ws}${digits}\\${punct}` : `${ws}\\${marker}`,
    );
  }
  if (/^\s{0,3}(#{1,6}\s|#{1,6}$|>)/.test(line)) return line.replace(/^(\s*)([#>])/, "$1\\$2");
  return line;
}

function escapeText(text: string, inTable: boolean): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\" || ch === "*" || ch === "`" || ch === "[" || ch === "]" || ch === "~") out += `\\${ch}`;
    else if (ch === "_") {
      const intraword = /[\p{L}\p{N}]/u.test(text[i - 1] ?? " ") && /[\p{L}\p{N}]/u.test(text[i + 1] ?? " ");
      out += intraword && text[i + 1] !== "_" && text[i - 1] !== "_" ? ch : `\\${ch}`;
    } else if (ch === "|" && inTable) out += "\\|";
    else out += ch;
  }
  return out;
}

function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

const ITALIC_OPEN = "\uE000";
const ITALIC_CLOSE = "\uE001";
const isWordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/**
 * Kursiv `_x_` ko'rinishida yozilsa, qo'shni qalin (`**`) bilan aralashmaydi (`*x***y**` noaniq, `_x_**y**` aniq); lekin
 * `_` so'z ichida ishlamaydi (o'qish qoidasi: oldidan ham, keyinidan ham harf/raqam bo'lmasligi shart) — shunda `*` ishlatiladi.
 */
function resolveItalics(line: string): string {
  let out = "";
  let open = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === ITALIC_OPEN) {
      open = out.length;
      out += ch;
    } else if (ch === ITALIC_CLOSE) {
      const before = out[open - 1];
      let next = i + 1;
      while (line[next] === ITALIC_OPEN || line[next] === ITALIC_CLOSE) next++;
      const after = line[next];
      const mark = isWordChar(before) || isWordChar(after) ? "*" : "_";
      out = `${out.slice(0, open)}${mark}${out.slice(open + 1)}${mark}`;
      open = -1;
    } else out += ch;
  }
  return out;
}

function renderRun(run: RunNode, inTable: boolean): string {
  let inner = "";
  for (const child of run.children) inner += isRun(child) ? renderRun(child, inTable) : renderText(child.text, run, inTable);
  const mark = run.mark;
  if (!mark) return inner;
  switch (mark.type) {
    case "bold":
      return `**${inner}**`;
    case "italic":
      // Ajratgich keyin tanlanadi (`resolveItalics`): qo'shni belgilarga qarab `_` yoki `*`.
      return `${ITALIC_OPEN}${inner}${ITALIC_CLOSE}`;
    case "strike":
      return `~~${inner}~~`;
    case "link": {
      const href = typeof mark.attrs?.href === "string" ? mark.attrs.href : "";
      return `[${inner}](${href})`;
    }
    default:
      return inner; // noma'lum belgi: matn saqlanadi, belgi tashlanadi (tahlil buni "lossy" deb ko'rsatadi)
  }
}

function renderText(text: string, run: RunNode, inTable: boolean): string {
  if (run.mark?.type === "code") return codeSpan(inTable ? text.replace(/\|/g, "\\|") : text);
  return escapeText(text, inTable);
}

function renderInline(content: ContentNode[] | undefined, inTable = false): string {
  const lines: string[] = [];
  let segs: Seg[] = [];
  let current = "";
  const flush = () => {
    const root = buildRuns(segs);
    hoist(root);
    current += renderRun(root, inTable);
    segs = [];
  };
  for (const node of content ?? []) {
    if (node.type === "text") {
      segs.push({ text: node.text ?? "", marks: (node.marks ?? []).map(normalizeMark).sort((a, b) => markRank(a) - markRank(b)) });
    } else if (node.type === "hardBreak") {
      flush();
      lines.push(current);
      current = "";
    } else if (node.type === "image") {
      flush();
      current += renderImage(node);
    } else {
      flush();
      current += escapeText(plainTextOf(node), inTable);
    }
  }
  flush();
  lines.push(current);
  return lines.map((line) => escapeLineStart(resolveItalics(line))).join("\\\n");
}

function plainTextOf(node: ContentNode): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(plainTextOf).join("");
}

function renderImage(node: ContentNode): string {
  const attrs = node.attrs ?? {};
  const alt = typeof attrs.alt === "string" ? attrs.alt.replace(/([\\[\]])/g, "\\$1") : "";
  const src = typeof attrs.src === "string" ? attrs.src : "";
  const title = typeof attrs.title === "string" && attrs.title ? ` "${attrs.title}"` : "";
  return `![${alt}](${src}${title})`;
}

function indentLines(text: string, prefix: string, firstPrefix = prefix): string {
  return text
    .split("\n")
    .map((line, index) => (line === "" && index > 0 ? line : `${index === 0 ? firstPrefix : prefix}${line}`))
    .join("\n");
}

function renderList(node: ContentNode): string {
  const ordered = node.type === "orderedList";
  const start = typeof node.attrs?.start === "number" ? node.attrs.start : 1;
  const lines: string[] = [];
  (node.content ?? []).forEach((item, index) => {
    const marker = ordered ? `${start + index}. ` : "- ";
    const [first, ...rest] = item.content ?? [];
    const head = first && first.type === "paragraph" ? renderInline(first.content) : first ? renderBlock(first) : "";
    const parts = [indentLines(head, "  ", marker)];
    for (const child of rest) {
      if (child.type === "bulletList" || child.type === "orderedList") parts.push(indentLines(renderList(child), "  "));
      else parts.push(indentLines(renderBlock(child), "  "));
    }
    lines.push(parts.join("\n"));
  });
  return lines.join("\n");
}

function renderTable(node: ContentNode): string {
  const rows = (node.content ?? []).map((row) =>
    (row.content ?? []).map((cell) =>
      (cell.content ?? [])
        .map((child) => (child.type === "paragraph" ? renderInline(child.content, true).replace(/\\\n/g, " ") : renderBlock(child)))
        .join(" ")
        .replace(/\n/g, " "),
    ),
  );
  if (rows.length === 0) return "";
  const cols = Math.max(1, ...rows.map((row) => row.length));
  const line = (cells: string[]) => `| ${Array.from({ length: cols }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  const [head, ...body] = rows;
  return [line(head ?? []), `| ${Array.from({ length: cols }, () => "---").join(" | ")} |`, ...body.map(line)].join("\n");
}

function renderCode(node: ContentNode): string {
  const text = (node.content ?? []).map((child) => child.text ?? "").join("");
  const language = typeof node.attrs?.language === "string" ? node.attrs.language : "";
  const closes = (marker: string) => text.split("\n").some((line) => new RegExp(`^\\s{0,3}${marker}{3,}\\s*$`).test(line));
  const fence = closes("`") && !closes("~") ? "~~~" : "```";
  return `${fence}${language}\n${text}${text === "" ? "" : "\n"}${fence}`;
}

function renderBlock(node: ContentNode): string {
  switch (node.type) {
    case "paragraph":
      return renderInline(node.content);
    case "heading": {
      const level = typeof node.attrs?.level === "number" ? node.attrs.level : 2;
      return `${"#".repeat(Math.min(6, Math.max(1, level)))} ${renderInline(node.content).replace(/\\\n/g, " ")}`;
    }
    case "bulletList":
    case "orderedList":
      return renderList(node);
    case "blockquote": {
      const inner = (node.content ?? []).map(renderBlock).join("\n\n");
      return inner
        .split("\n")
        .map((line) => (line === "" ? ">" : `> ${line}`))
        .join("\n");
    }
    case "codeBlock":
      return renderCode(node);
    case "horizontalRule":
      return "***";
    case "image":
      return renderImage(node);
    case "table":
      return renderTable(node);
    default:
      return (node.content ?? []).map((child) => (child.type === "text" ? escapeText(child.text ?? "", false) : renderBlock(child))).join("\n\n");
  }
}

/** Hujjatni Markdown'ga aylantiradi (post sarlavhasi KIRMAYDI — u alohida maydon). Bloklar orasida bitta bo'sh qator. */
export function docToMarkdown(doc: ContentNode | null | undefined): string {
  const normalized = normalizeDoc(doc);
  const blocks = normalized.content ?? [];
  const only = blocks.length === 1 && isEmptyParagraph(blocks[0]!);
  return only ? "" : blocks.map(renderBlock).join("\n\n");
}

// ------------------------------------------------------------------ tahlil

export interface LossyBlock {
  /** 1 dan boshlanadigan yuqori darajadagi blok raqami (bo'sh paragraflar hisobga olinadi). */
  block: number;
  type: string;
  /** Blok matnining boshi (~40 belgi), odam bloknni topishi uchun. */
  preview: string;
  reason: string;
}

export interface DocMarkdownAnalysis {
  markdown: string;
  /** `true` — Markdown orqali to'liq yo'qotishsiz tahrirlash mumkin. */
  lossless: boolean;
  lossyBlocks: LossyBlock[];
}

const SUPPORTED_NODES = new Set([
  "doc", "paragraph", "heading", "text", "hardBreak", "bulletList", "orderedList", "listItem", "blockquote", "codeBlock",
  "horizontalRule", "image", "table", "tableRow", "tableCell", "tableHeader",
]);
const SUPPORTED_MARKS = new Set(["bold", "italic", "strike", "code", "link"]);
const SAFE_URL = /^(https?:\/\/|mailto:|\/|#)/i;

function describeLoss(block: ContentNode): string {
  const reasons = new Set<string>();
  const visit = (node: ContentNode, inListItem: boolean) => {
    if (!SUPPORTED_NODES.has(node.type ?? "")) reasons.add(`unsupported node '${node.type}'`);
    if (node.type === "heading") {
      const level = node.attrs?.level;
      if (level !== 2 && level !== 3) reasons.add(`heading level ${String(level)} (only 2 and 3 survive)`);
    }
    if (node.type === "image") {
      const attrs = node.attrs ?? {};
      if (typeof attrs.src !== "string" || !SAFE_URL.test(attrs.src) || /\s/.test(attrs.src)) reasons.add("image source is not a plain http(s) or site-relative URL");
      if (typeof attrs.title === "string" && /["']/.test(attrs.title)) reasons.add("image title contains quotes");
    }
    if (node.type === "listItem") {
      const kids = node.content ?? [];
      if (kids.length === 0 || kids[0]!.type !== "paragraph" || kids.slice(1).some((k) => k.type !== "bulletList" && k.type !== "orderedList")) {
        reasons.add("list item holds more than one paragraph or non-list blocks");
      }
    }
    if (node.type === "tableCell" || node.type === "tableHeader") {
      if ((node.content ?? []).length > 1 || (node.content ?? []).some((c) => (c.content ?? []).some((inline) => inline.type === "hardBreak"))) reasons.add("table cell holds several paragraphs or line breaks");
    }
    if (node.type === "text") {
      for (const mark of node.marks ?? []) {
        if (!SUPPORTED_MARKS.has(mark.type)) reasons.add(`'${mark.type}' formatting has no Markdown form`);
        if (mark.type === "link" && (typeof mark.attrs?.href !== "string" || !SAFE_URL.test(mark.attrs.href) || /\s/.test(mark.attrs.href))) reasons.add("link URL is not a plain http(s), mailto or site-relative URL");
      }
      if ((node.marks ?? []).some((m) => m.type === "code") && (node.marks ?? []).length > 1) reasons.add("inline code combined with other formatting");
      if (/https?:\/\//.test(node.text ?? "") && !(node.marks ?? []).some((m) => m.type === "link")) reasons.add("plain text contains a bare URL (Markdown would turn it into a link)");
    }
    (node.content ?? []).forEach((child) => visit(child, node.type === "listItem" || inListItem));
  };
  visit(block, false);
  return reasons.size > 0 ? [...reasons].join("; ") : "formatting that cannot be written in Markdown and read back identically";
}

function previewOf(block: ContentNode): string {
  const text = plainTextOf(block).replace(/\s+/g, " ").trim();
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/**
 * Hujjatni Markdown'ga aylantiradi va uni FAKTIK qayta o'qib tekshiradi. `lossless=false` bo'lsa, `lossyBlocks` aynan qaysi
 * bloklar Markdown orqali buzilishini aytadi. Hech narsa tashlab yuborilmaydi — bu faqat hisobot.
 */
export function analyzeDocMarkdown(doc: ContentNode | null | undefined): DocMarkdownAnalysis {
  const markdown = docToMarkdown(doc);
  const original = (doc?.content ?? []) as ContentNode[];
  const lossy: LossyBlock[] = [];

  original.forEach((block, index) => {
    if (isEmptyParagraph(normalizeNode(block, true))) return;
    const single = docToMarkdown({ type: "doc", content: [block] });
    const parsed = markdownToDoc(single).doc;
    const before = stable(normalizeDoc({ type: "doc", content: [block] }));
    const after = stable(normalizeDoc(parsed));
    if (before !== after) lossy.push({ block: index + 1, type: block.type ?? "unknown", preview: previewOf(block), reason: describeLoss(block) });
  });

  if (lossy.length === 0 && !docsEquivalent(doc, markdownToDoc(markdown).doc)) {
    // Bloklar alohida to'g'ri, lekin yonma-yon kelganda o'zgaradi (masalan ikkita ketma-ket bir xil ro'yxat birlashadi).
    const kept = normalizeDoc(doc).content ?? [];
    const again = normalizeDoc(markdownToDoc(markdown).doc).content ?? [];
    let at = 0;
    while (at < kept.length && at < again.length && stable(kept[at]) === stable(again[at])) at++;
    const source = original.filter((b) => !isEmptyParagraph(normalizeNode(b, true)));
    const culprit = source[Math.min(at, source.length - 1)] ?? source[0];
    lossy.push({
      block: Math.max(1, original.indexOf(culprit as ContentNode) + 1),
      type: culprit?.type ?? "unknown",
      preview: culprit ? previewOf(culprit) : "",
      reason: "merges with a neighbouring block when written as Markdown (e.g. two adjacent lists of the same kind)",
    });
  }

  return { markdown, lossless: lossy.length === 0, lossyBlocks: lossy };
}

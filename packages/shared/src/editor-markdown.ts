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

function findClosing(src: string, from: number, token: string): number {
  let i = from;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src.startsWith(token, i) && i > from && !/\s/.test(src[i - 1] ?? "")) {
      // `**` ichida `***` kabi uchrashuvlarda eng chap mos kelishni olamiz.
      return i;
    }
    i++;
  }
  return -1;
}

function findBracketEnd(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseLinkTarget(src: string, openParen: number): { url: string; title: string | null; end: number } | null {
  if (src[openParen] !== "(") return null;
  let depth = 0;
  let i = openParen;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (i >= src.length) return null;
  const inner = src.slice(openParen + 1, i).trim();
  const match = /^<?([^\s>]+)>?(?:\s+["']([^"']*)["'])?$/.exec(inner);
  if (!match) return null;
  return { url: match[1] ?? "", title: match[2] ?? null, end: i + 1 };
}

const SAFE_URL = /^(https?:\/\/|mailto:|\/|#)/i;

function parseInline(src: string, marks: Mark[]): JSONContent[] {
  const out: JSONContent[] = [];
  let plain = "";
  const flush = () => {
    pushText(out, plain, marks);
    plain = "";
  };
  let i = 0;
  scan: while (i < src.length) {
    const ch = src[i] ?? "";
    const rest = src.slice(i);

    if (ch === "\\" && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!|>~]/.test(src[i + 1] ?? "")) {
      plain += src[i + 1];
      i += 2;
      continue;
    }

    if (ch === "`") {
      const ticks = /^`+/.exec(rest)?.[0] ?? "`";
      const close = src.indexOf(ticks, i + ticks.length);
      if (close > i + ticks.length - 1) {
        flush();
        const code = src.slice(i + ticks.length, close).trim();
        // `code` belgisi boshqa belgilar bilan birga bo'lmaydi (schema: excludes "_").
        if (code) out.push({ type: "text", text: code, marks: [{ type: "code" }] });
        i = close + ticks.length;
        continue;
      }
    }

    if (ch === "!" && src[i + 1] === "[") {
      const end = findBracketEnd(src, i + 1);
      const target = end > 0 ? parseLinkTarget(src, end + 1) : null;
      if (end > 0 && target && SAFE_URL.test(target.url)) {
        flush();
        const attrs: Record<string, unknown> = { src: target.url, alt: src.slice(i + 2, end) };
        if (target.title) attrs.title = target.title;
        out.push({ type: "image", attrs });
        i = target.end;
        continue;
      }
    }

    if (ch === "[") {
      const end = findBracketEnd(src, i);
      const target = end > 0 ? parseLinkTarget(src, end + 1) : null;
      if (end > 0 && target && SAFE_URL.test(target.url)) {
        flush();
        const linkMarks: Mark[] = [...marks.filter((m) => m.type !== "link"), { type: "link", attrs: { href: target.url } }];
        out.push(...parseInline(src.slice(i + 1, end), linkMarks));
        i = target.end;
        continue;
      }
    }

    if (ch === "<") {
      const auto = /^<(https?:\/\/[^\s>]+)>/.exec(rest);
      if (auto?.[1]) {
        flush();
        out.push({ type: "text", text: auto[1], marks: [...marks, { type: "link", attrs: { href: auto[1] } }] });
        i += auto[0].length;
        continue;
      }
    }

    if (ch === "h" && /^https?:\/\//.test(rest) && !/[A-Za-z0-9]/.test(src[i - 1] ?? " ")) {
      const url = /^https?:\/\/[^\s<>"]+/.exec(rest)?.[0] ?? "";
      const trimmed = url.replace(/[.,;:!?)\]]+$/, "");
      if (trimmed.length > 8 && !marks.some((m) => m.type === "link")) {
        flush();
        out.push({ type: "text", text: trimmed, marks: [...marks, { type: "link", attrs: { href: trimmed } }] });
        i += trimmed.length;
        continue;
      }
    }

    for (const [token, markType] of [
      ["**", "bold"],
      ["__", "bold"],
      ["~~", "strike"],
    ] as const) {
      if (rest.startsWith(token) && !/\s/.test(src[i + token.length] ?? " ")) {
        const close = findClosing(src, i + token.length, token);
        if (close > 0) {
          flush();
          out.push(...parseInline(src.slice(i + token.length, close), [...marks, { type: markType }]));
          i = close + token.length;
          continue scan;
        }
      }
    }
    if (i !== src.length && (ch === "*" || ch === "_") && src[i + 1] !== ch && !/\s/.test(src[i + 1] ?? " ")) {
      const intraword = ch === "_" && /[A-Za-z0-9]/.test(src[i - 1] ?? " ");
      if (!intraword) {
        let close = -1;
        for (let j = i + 1; j < src.length; j++) {
          if (src[j] === "\\") {
            j++;
            continue;
          }
          if (src[j] === ch && src[j + 1] !== ch && src[j - 1] !== ch && !/\s/.test(src[j - 1] ?? "") && !(ch === "_" && /[A-Za-z0-9]/.test(src[j + 1] ?? " "))) {
            close = j;
            break;
          }
        }
        if (close > 0) {
          flush();
          out.push(...parseInline(src.slice(i + 1, close), [...marks, { type: "italic" }]));
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
    const hard = /( {2,}|\\)$/.test(line);
    const clean = line.replace(/( {2,}|\\)$/, "").trim();
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

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

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
  return head.includes("|") && sep !== undefined && sep.includes("-") && TABLE_SEP.test(sep) && splitRow(head).length === splitRow(sep).length;
}

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i] ?? "";
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || (LIST_ITEM.test(line) && !HR.test(line)) || isTableStart(lines, i);
}

interface ParseCtx {
  /** `#` (H1) sarlavhalar uchun — true bo'lsa birinchisi sarlavhaga ajratiladi. */
  titleSlot: { value: string | null } | null;
}

function parseList(lines: string[], start: number, ctx: ParseCtx): { node: JSONContent; next: number } {
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
    if (indent > baseIndent) {
      // ichki ro'yxat — oxirgi elementga qo'shiladi
      const nested = parseList(lines, i, ctx);
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

function parseBlocks(lines: string[], ctx: ParseCtx): JSONContent[] {
  const blocks: JSONContent[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = (fence[1] ?? "```")[0] as string;
      const lang = normalizeCodeLanguage(fence[2]);
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${marker}{3,}\\s*$`).test(lines[i] ?? "")) {
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

    const heading = HEADING.exec(line);
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

    if (isTableStart(lines, i)) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim() !== "") {
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

    if (QUOTE.test(line)) {
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
      const children = parseBlocks(inner, { titleSlot: null });
      if (emoji) {
        const firstChild = children[0];
        if (firstChild?.type === "paragraph") firstChild.content = [{ type: "text", text: `${emoji} ` }, ...(firstChild.content ?? [])];
        else children.unshift({ type: "paragraph", content: [{ type: "text", text: `${emoji} ` }] });
      }
      blocks.push({ type: "blockquote", content: children.length > 0 ? children : [{ type: "paragraph" }] });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const { node, next } = parseList(lines, i, ctx);
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
  const blocks = parseBlocks(lines, { titleSlot });
  return {
    title: titleSlot.value,
    doc: { type: "doc", content: blocks.length > 0 ? blocks : [{ type: "paragraph" }] },
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

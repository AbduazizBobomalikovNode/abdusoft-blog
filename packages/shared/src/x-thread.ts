import { findUrls, graphemes, xWeightedLength } from "./distribution.js";

/**
 * X "zanjir" (thread): bitta matnni ketma-ket javob tvitlariga bo'ladi. Sof funksiya — web ko'rinishi va API yuborishi
 * AYNAN bir xil bo'laklarni oladi (yuborishda matn rejalashtirish paytida muzlatiladi, bo'laklar undan qayta hisoblanadi).
 *
 * Qoidalar:
 *  1. Ajratgich: faqat `---` dan iborat satr (atrofida bo'shliq bo'lishi mumkin). Ajratgichlar orasidagi bo'sh bo'laklar tashlanadi.
 *  2. Bo'lak hamon `limit` (280 vazn) dan uzun bo'lsa — avtomatik bo'linadi: avval abzats, so'ng gap oxiri, so'ng so'z chegarasida.
 *     URL hech qachon bo'linmaydi; so'z (URL'siz) o'zi sig'masa — grafema chegarasida (surrogat/emoji bo'linmaydi) kesiladi.
 *  3. Raqamlash (ixtiyoriy): bir nechta bo'lak bo'lsa har biriga " i/n" qo'shiladi va uning vazni hisobga olinadi.
 *     Bitta bo'lak bo'lsa raqam qo'shilmaydi.
 */

export const X_THREAD_MAX_PARTS = 15;
export const X_THREAD_SEPARATOR = "---";
export const X_TWEET_LIMIT = 280;

const SEPARATOR_LINE_RE = /^[ \t]*---[ \t]*$/;
const SENTENCE_END_RE = /[.!?…]["'»”’)\]]*$/u;
/** Kesish joyi bo'lak uzunligining shu ulushidan oldin bo'lsa, abzats/gap chegarasi o'rniga so'z chegarasi ishlatiladi (juda qisqa bo'laklardan qochish). */
const MIN_BREAK_RATIO = 0.35;

export interface XThreadPart {
  text: string;
  weight: number;
  over: boolean;
}

export interface XThreadSplit {
  parts: XThreadPart[];
  count: number;
  numbered: boolean;
  maxParts: number;
  /** Bo'laklar soni `maxParts` dan oshdi. */
  tooMany: boolean;
  /** Kamida bitta bo'lak hamon limitdan uzun (bo'linmas holat). */
  anyOver: boolean;
}

export interface XThreadOptions {
  numbering?: boolean;
  maxParts?: number;
  limit?: number;
}

/** Matnni ajratgich satrlari bo'yicha bo'laklaydi (trim qilingan, bo'shlari tashlangan). */
export function splitThreadSegments(text: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  const flush = () => {
    const seg = cur.join("\n").trim();
    if (seg) out.push(seg);
    cur = [];
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (SEPARATOR_LINE_RE.test(line)) flush();
    else cur.push(line);
  }
  flush();
  return out;
}

/** Matnda ajratgich satri bormi (zanjir o'chiq bo'lsa ogohlantirish uchun). */
export function hasThreadSeparator(text: string): boolean {
  return text.replace(/\r\n?/g, "\n").split("\n").some((l) => SEPARATOR_LINE_RE.test(l));
}

/** Bitta so'zni (URL'siz sig'maydigan) grafema chegarasida bo'ladi; URL ichida kesilmaydi. */
function hardSplit(word: string, budget: number): { head: string; rest: string } {
  const urls = findUrls(word);
  const gs = graphemes(word);
  let offset = 0;
  let head = "";
  let headEnd = 0;
  for (const g of gs) {
    const end = offset + g.length;
    const insideUrl = urls.some((u) => offset > u.start && offset < u.end);
    if (!insideUrl && offset > 0 && xWeightedLength(head + g) > budget) break;
    head += g;
    headEnd = end;
    offset = end;
  }
  // Kesish URL ichiga tushgan bo'lsa (bitta URL budget'dan katta bo'lishi mumkin emas, lekin himoya): URL boshlanishigacha qaytamiz.
  const u = urls.find((x) => headEnd > x.start && headEnd < x.end);
  if (u && u.start > 0) headEnd = u.start;
  if (headEnd <= 0) headEnd = gs[0]?.length ?? word.length;
  return { head: word.slice(0, headEnd), rest: word.slice(headEnd) };
}

function takeChunk(rest: string, budget: number): { chunk: string; remainder: string } {
  if (xWeightedLength(rest) <= budget) return { chunk: rest, remainder: "" };
  interface Cand {
    end: number;
    sentence: boolean;
    paragraph: boolean;
  }
  const cands: Cand[] = [];
  for (const m of rest.matchAll(/\S+/gu)) {
    const end = m.index + m[0].length;
    if (xWeightedLength(rest.slice(0, end)) > budget) break;
    const after = /^\s*/u.exec(rest.slice(end))?.[0] ?? "";
    cands.push({ end, sentence: SENTENCE_END_RE.test(m[0]), paragraph: (after.match(/\n/g)?.length ?? 0) >= 2 });
  }
  const last = cands[cands.length - 1];
  if (!last) {
    const firstWord = /^\S+/u.exec(rest)?.[0] ?? rest;
    const { head, rest: tail } = hardSplit(firstWord, budget);
    return { chunk: head, remainder: (tail + rest.slice(firstWord.length)).trimStart() };
  }
  const minEnd = last.end * MIN_BREAK_RATIO;
  const pick = [...cands].reverse().find((c) => c.paragraph && c.end >= minEnd) ?? [...cands].reverse().find((c) => c.sentence && c.end >= minEnd) ?? last;
  return { chunk: rest.slice(0, pick.end).trim(), remainder: rest.slice(pick.end).trimStart() };
}

function splitSegment(segment: string, budget: number): string[] {
  const out: string[] = [];
  let rest = segment.trim();
  // Ortiqcha uzun matn cheksiz aylanmasligi uchun qattiq chegara.
  for (let guard = 0; rest && guard < 2000; guard++) {
    const { chunk, remainder } = takeChunk(rest, budget);
    if (!chunk) break;
    out.push(chunk);
    rest = remainder;
  }
  return out;
}

const digits = (n: number) => String(n).length;

function build(texts: string[], limit: number, numbering: boolean, maxParts: number): XThreadSplit {
  const n = texts.length;
  const numbered = numbering && n > 1;
  const parts: XThreadPart[] = texts.map((t, i) => {
    const text = numbered ? `${t} ${i + 1}/${n}` : t;
    const weight = xWeightedLength(text);
    return { text, weight, over: weight > limit };
  });
  return { parts, count: n, numbered, maxParts, tooMany: n > maxParts, anyOver: parts.some((p) => p.over) };
}

export function splitXThread(text: string, opts: XThreadOptions = {}): XThreadSplit {
  const limit = opts.limit ?? X_TWEET_LIMIT;
  const maxParts = opts.maxParts ?? X_THREAD_MAX_PARTS;
  const numbering = opts.numbering === true;
  const segments = splitThreadSegments(text);
  if (segments.length === 0) return build([], limit, false, maxParts);

  const plain = segments.flatMap((s) => splitSegment(s, limit));
  if (!numbering || plain.length === 1) return build(plain, limit, false, maxParts);

  // Raqamlash: " i/n" vazni bo'lak sonidan bog'liq, bo'lak soni esa byudjetdan — barqarorlashguncha takrorlanadi (eng yomon holat: i va n bir xil xona).
  let guess = Math.max(segments.length, 2);
  for (let i = 0; i < 6; i++) {
    const budget = limit - (2 + 2 * digits(guess));
    const texts = segments.flatMap((s) => splitSegment(s, budget));
    if (digits(texts.length) <= digits(guess) && texts.length > 1) return build(texts, limit, true, maxParts);
    if (texts.length <= 1) return build(texts, limit, false, maxParts);
    guess = texts.length;
  }
  return build(segments.flatMap((s) => splitSegment(s, limit - (2 + 2 * digits(guess)))), limit, true, maxParts);
}

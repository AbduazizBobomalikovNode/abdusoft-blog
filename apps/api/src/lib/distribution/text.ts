/**
 * Matn yordamchilari: uzunlikni platforma hisoblagandek sanash, o'zbek apostroflari,
 * hashtag'lar va "sig'dirish" (fit) algoritmi. Hech qanday AI yo'q — deterministik shablonlar.
 */

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** Inson ko'radigan belgilar soni (grapheme). */
export function graphemeLength(text: string): number {
  return graphemes(text).length;
}

/** Unicode code point'lar soni (UTF-16 surrogate juftlari bitta). */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

export function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

/** URL aniqlash (http/https). Oxirgi tinish belgilari URLga kirmaydi. */
const URL_RE = /https?:\/\/[^\s<>"]+/giu;
const URL_TRAILING_RE = /[.,;:!?)\]}'»”’]+$/u;

export function findUrls(text: string): { start: number; end: number; url: string }[] {
  const out: { start: number; end: number; url: string }[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const trimmed = m[0].replace(URL_TRAILING_RE, "");
    if (trimmed.length < 8) continue;
    out.push({ start: m.index, end: m.index + trimmed.length, url: trimmed });
  }
  return out;
}

/**
 * X ("weighted") hisobi — twitter-text `parseTweet` konfiguratsiyasi (v3):
 * range 0..4351, 8192..8205, 8208..8223, 8242..8247 -> vazn 1; boshqa hamma narsa -> 2;
 * URL (t.co) -> 23; emoji (ZWJ ketma-ketliklar, teri ranglari ham) -> 2.
 * Hujjat: https://docs.x.com/fundamentals/counting-characters (sana ko'rsatilmagan; 2026-11-25 da o'qildi).
 * Hujjat faqat "Latin/tinish = 1, URL = 23, emoji = 2, CJK = 2" deydi; aniq diapazonlar
 * twitter-text kutubxonasidan (UNVERIFIED — hujjat sahifasida diapazonlar keltirilmagan).
 * Natija X "vazn birliklari"da (280 gacha). `ʻ` (U+02BB) va `ʼ` (U+02BC) 0..4351 ichida — vazn 1.
 */
export const X_TCO_URL_WEIGHT = 23;

function xCharWeight(cp: number): number {
  if (cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247)) return 1;
  return 2;
}

export function xWeightedLength(raw: string): number {
  const text = raw.normalize("NFC"); // twitter-text ham NFC ga keltiradi
  const urls = findUrls(text);
  let total = 0;
  let cursor = 0;
  const countPlain = (chunk: string) => {
    for (const g of graphemes(chunk)) {
      if (EMOJI_RE.test(g) && !/^[0-9#*]$/.test(g)) {
        total += 2;
      } else {
        for (const ch of g) total += xCharWeight(ch.codePointAt(0)!);
      }
    }
  };
  for (const u of urls) {
    countPlain(text.slice(cursor, u.start));
    total += X_TCO_URL_WEIGHT;
    cursor = u.end;
  }
  countPlain(text.slice(cursor));
  return total;
}

// --- O'zbek apostroflari ---

const APOSTROPHES = "'`´‘’ʻʼ′‵";
const UZ_APOS = new RegExp(`(\\p{L})[${APOSTROPHES}](?=\\p{L})`, "gu");

/**
 * O'zbek lotin yozuvi: `o'`/`g'` -> `oʻ`/`gʻ` (U+02BB), harflar orasidagi boshqa apostrof (ma'no) -> `ʼ` (U+02BC).
 * Faqat harf-harf orasidagi apostrofga tegadi (tirnoqlar va so'z oxiridagi belgilar o'zgarmaydi).
 * Qo'lda yozilgan (caller bergan) matnga TEGILMAYDI — faqat default shablon ishlatadi.
 */
export function normalizeUzbekApostrophes(text: string): string {
  return text.replace(UZ_APOS, (_m, prev: string) => (/[oOgG]/.test(prev) ? `${prev}ʻ` : `${prev}ʼ`));
}

// --- Hashtag'lar ---

/** Teg -> hashtag: harf/raqamlarni qoldiradi ("node-js" -> "#NodeJs", "o'zbek" -> "#ozbek"). Bo'sh bo'lsa null. */
export function toHashtag(tag: string): string | null {
  const parts = tag
    .normalize("NFC")
    .replace(new RegExp(`(?<=\\p{L})[${APOSTROPHES}](?=\\p{L})`, "gu"), "")
    .split(/[^\p{L}\p{N}]+/u)
    .map((p) => p.replace(/[ʻʼ]/g, ""))
    .filter(Boolean);
  if (parts.length === 0) return null;
  const word = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  if (/^\p{N}+$/u.test(word)) return null; // faqat raqamli hashtag platformalarda ishlamaydi
  return `#${word}`;
}

export function toHashtags(tags: readonly string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const h = toHashtag(t);
    if (!h || seen.has(h.toLowerCase())) continue;
    seen.add(h.toLowerCase());
    out.push(h);
    if (out.length >= max) break;
  }
  return out;
}

// --- Sig'dirish ---

/**
 * Matnni `counter(...) <= limit` bo'lguncha oxiridan "…" bilan qisqartiradi (grapheme chegarasida). URL-aware:
 * kesish URL ichiga tushsa, URL boshlanishidan oldin kesiladi (URL hech qachon bo'laklanmaydi).
 */
export function truncateTo(text: string, limit: number, counter: (s: string) => number): string {
  if (counter(text) <= limit) return text;
  const gs = graphemes(text);
  const build = (n: number) => {
    let prefix = gs.slice(0, n).join("");
    for (const u of findUrls(text)) {
      if (u.start < prefix.length && prefix.length < u.end) {
        prefix = text.slice(0, u.start);
        break;
      }
    }
    return `${prefix.trimEnd()}…`;
  };
  let lo = 0;
  let hi = gs.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (counter(build(mid)) <= limit) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? "" : build(lo);
}

export interface TextParts {
  /** Majburiy qism (sarlavha) — kerak bo'lsa qisqartiriladi. */
  title: string;
  /** Ixtiyoriy qismlar, tartib bo'yicha: oxirgisi birinchi tashlanadi. */
  optional: { key: string; text: string }[];
  /** Har doim saqlanadigan qism (masalan URL) — sarlavhadan keyin. */
  required?: string;
}

/**
 * Qismlarni bo'sh qator bilan birlashtiradi. Sig'masa: avval ixtiyoriy qismlar oxiridan boshlab tashlanadi,
 * so'ng sarlavha qisqartiriladi. `required` (URL) hech qachon kesilmaydi.
 */
export function fitParts(parts: TextParts, limit: number, counter: (s: string) => number, sep = "\n\n"): string {
  const compose = (title: string, optional: string[]) => [title, ...optional, parts.required ?? ""].filter(Boolean).join(sep);
  const opts = parts.optional.map((o) => o.text).filter(Boolean);
  while (true) {
    const candidate = compose(parts.title, opts);
    if (counter(candidate) <= limit) return candidate;
    if (opts.length === 0) break;
    opts.pop();
  }
  const requiredCost = parts.required ? counter(`${sep}${parts.required}`) : 0;
  const room = Math.max(0, limit - requiredCost);
  return compose(truncateTo(parts.title, room, counter), []);
}

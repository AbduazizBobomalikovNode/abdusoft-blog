import { measureSocialText, type DistributionProviderId } from "@blog/shared";

export type SegmentKind = "text" | "url" | "hashtag" | "mention";

export interface TextSegment {
  kind: SegmentKind;
  value: string;
  /** Bu bo'lak platforma chegarasidan keyin turadi (kesiladi). */
  over: boolean;
}

export interface TokenizeOptions {
  /** `false` — URL oddiy matn (Instagram: caption'da havola bosilmaydi). */
  urls: boolean;
}

const TOKEN_RE = /(https?:\/\/[^\s<>]+)|((?<![\p{L}\p{N}_&/])#[\p{L}\p{N}_]*\p{L}[\p{L}\p{N}_]*)|((?<![\p{L}\p{N}_@.])@[A-Za-z0-9_][A-Za-z0-9_.]{0,29})/gu;
const URL_TRAIL_RE = /[.,;:!?)\]}'"»]+$/;

/** Matnni oddiy / URL / #hashtag / @mention bo'laklariga ajratadi (qator uzilishlari saqlanadi). */
export function tokenizeSocialText(text: string, opts: TokenizeOptions = { urls: true }): { kind: SegmentKind; value: string }[] {
  const out: { kind: SegmentKind; value: string }[] = [];
  let cursor = 0;
  const pushText = (value: string) => {
    if (!value) return;
    const last = out[out.length - 1];
    if (last && last.kind === "text") last.value += value;
    else out.push({ kind: "text", value });
  };
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index;
    let value = m[0];
    let kind: SegmentKind = m[1] ? "url" : m[2] ? "hashtag" : "mention";
    if (kind === "url") {
      const trimmed = value.replace(URL_TRAIL_RE, "");
      if (trimmed.length < 8) kind = "text";
      else value = trimmed;
    } else if (kind === "mention") {
      value = value.replace(/\.+$/, "");
    }
    pushText(text.slice(cursor, start));
    if (kind === "url" && !opts.urls) pushText(value);
    else if (kind === "text") pushText(value);
    else out.push({ kind, value });
    cursor = start + value.length;
  }
  pushText(text.slice(cursor));
  return out;
}

export interface CollapseRule {
  maxChars: number;
  maxLines: number;
}

export const LINKEDIN_COLLAPSE: CollapseRule = { maxChars: 210, maxLines: 3 };
export const INSTAGRAM_COLLAPSE: CollapseRule = { maxChars: 125, maxLines: 2 };

/** "...ko'proq" qayerdan boshlanadi: UTF-16 indeks yoki `null` (qisqartirish kerak emas). */
export function collapseCut(text: string, rule: CollapseRule): number | null {
  let cut = text.length;

  // Qator chegarasi: `maxLines`-qatordan keyingi yangi qator.
  let idx = -1;
  for (let i = 0; i < rule.maxLines; i++) {
    idx = text.indexOf("\n", idx + 1);
    if (idx === -1) break;
  }
  if (idx !== -1) cut = Math.min(cut, idx);

  // Belgi chegarasi (code point bo'yicha), so'z chegarasiga yaqinlashtiriladi.
  let count = 0;
  let charCut = -1;
  for (let i = 0; i < text.length; ) {
    if (count === rule.maxChars) {
      charCut = i;
      break;
    }
    i += (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
    count++;
  }
  if (charCut !== -1) {
    const space = text.lastIndexOf(" ", charCut);
    cut = Math.min(cut, space > charCut - 20 && space > 0 ? space : charCut);
  }

  const visible = text.slice(0, cut).trimEnd();
  if (visible.length >= text.trimEnd().length) return null;
  return visible.length;
}

/** Chegaradan oshgan qism qayerdan boshlanadi (UTF-16 indeks) yoki `null`. `measureSocialText` bilan hisoblanadi. */
export function overflowIndex(provider: DistributionProviderId, text: string, limit: number | null): number | null {
  if (limit === null || measureSocialText(provider, text) <= limit) return null;
  const points = Array.from(text);
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measureSocialText(provider, points.slice(0, mid).join("")) <= limit) lo = mid;
    else hi = mid - 1;
  }
  return points.slice(0, lo).join("").length;
}

/** Bo'laklarni kesish va chegaradan oshganini belgilash: `visibleEnd` dan keyin tashlanadi, `overAt` dan keyin `over=true`. */
export function buildSegments(text: string, opts: TokenizeOptions & { visibleEnd?: number | null; overAt?: number | null }): TextSegment[] {
  const visible = opts.visibleEnd == null ? text : text.slice(0, opts.visibleEnd);
  const overAt = opts.overAt ?? null;
  const out: TextSegment[] = [];
  let pos = 0;
  for (const seg of tokenizeSocialText(visible, opts)) {
    const start = pos;
    const end = pos + seg.value.length;
    pos = end;
    if (overAt === null || end <= overAt) out.push({ ...seg, over: false });
    else if (start >= overAt) out.push({ ...seg, over: true });
    else {
      out.push({ kind: seg.kind, value: seg.value.slice(0, overAt - start), over: false });
      out.push({ kind: seg.kind, value: seg.value.slice(overAt - start), over: true });
    }
  }
  return out;
}

export function initialsOf(name: string): string {
  const words = name.replace(/^@/, "").split(/[\s_.-]+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  const letters = words
    .slice(0, 2)
    .map((w) => Array.from(w.replace(/[^\p{L}\p{N}]/gu, ""))[0] ?? "")
    .join("");
  return (letters || "B").toUpperCase();
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export interface ReadmeLine {
  kind: "link" | "text";
  title: string;
  url: string;
  rest: string;
}

/** README bloki: `- [Sarlavha](url) — sana` qatorlarini ajratadi. Boshqa qatorlar oddiy matn bo'lib qoladi. */
export function parseReadmeBlock(block: string): ReadmeLine[] {
  return block
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((line) => {
      const m = /^\s*[-*]\s+\[(.+?)\]\(([^)\s]+)\)(.*)$/.exec(line);
      if (!m) return { kind: "text" as const, title: line.trim(), url: "", rest: "" };
      return { kind: "link" as const, title: m[1]!.replace(/\\(.)/g, "$1"), url: m[2]!, rest: m[3]!.trim() };
    });
}

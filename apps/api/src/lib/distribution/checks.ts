import type { ChannelCheck } from "@blog/shared";
import { DistributionError } from "./errors.js";

/** `ChannelCheck` yaratuvchi yordamchi (Telegram preflight'dagi `add` bilan bir xil standartlar). */
export function check(
  c: Pick<ChannelCheck, "id" | "group" | "status" | "title" | "message"> & Partial<Pick<ChannelCheck, "value" | "limit" | "imageUrl">>,
): ChannelCheck {
  return { value: null, limit: null, imageUrl: null, ...c };
}

export function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2).replace(/\.?0+$/, "")} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function isPrivateIpv4(h: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0)
  );
}

/**
 * Ommaviy HTTPS URL'ni qat'iy tekshiradi va tahlil qilingan `URL`ni qaytaradi (yoki `null`).
 * Rad etiladi: bo'shliq/boshqaruv belgilari (yangi qator ham — `new URL` ularni jimgina olib tashlaydi), http, userinfo,
 * port, localhost/.local/.internal, nuqtasiz host, IPv6 literal, shaxsiy/loopback/link-local IPv4 (169.254.169.254 ham).
 */
export function parsePublicHttpsUrl(raw: string | undefined): URL | null {
  if (!raw || /\s/.test(raw) || Array.from(raw).some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost") || !h.includes(".") || h.startsWith("[")) return null;
  if (/^[\d.]+$/.test(h) && (isPrivateIpv4(h) || !/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.test(h))) return null;
  return u;
}

export function isPublicHttpsUrl(raw: string | undefined): boolean {
  return parsePublicHttpsUrl(raw) !== null;
}

/** `publish` ichida: noto'g'ri/xavfli URL — `validation_rejected`. `href` tahlil qilingan (normallashgan) shakl. */
export function assertPublicHttpsUrl(raw: string | undefined, label: string): string {
  const u = parsePublicHttpsUrl(raw);
  if (!u) {
    throw new DistributionError({ kind: "validation_rejected", message: `${label} ommaviy https URL bo'lishi shart (localhost, ichki tarmoq, http, userinfo va bo'shliq/yangi qator mumkin emas)` });
  }
  return u.href;
}

/** Umumiy matn tekshiruvi: bo'sh / limitdan oshgan / limitga yaqin. */
export function textCheck(opts: { text: string; used: number; limit: number; unitLabel: string }): ChannelCheck {
  const { text, used, limit, unitLabel } = opts;
  const value = `${used} ${unitLabel}`;
  const lim = `${limit} ${unitLabel}`;
  if (!text.trim()) return check({ id: "text.empty", group: "text", status: "error", title: "Matn", message: "Matn bo'sh", value, limit: lim });
  if (used > limit) {
    return check({ id: "text.length", group: "text", status: "error", title: "Matn uzunligi", message: `${used - limit} ${unitLabel}ga oshib ketgan — qisqartiring`, value, limit: lim });
  }
  if (used > limit * 0.95) {
    return check({ id: "text.length", group: "text", status: "warn", title: "Matn uzunligi", message: "Chegaraga juda yaqin", value, limit: lim });
  }
  return check({ id: "text.length", group: "text", status: "ok", title: "Matn uzunligi", message: "Sig'adi", value, limit: lim });
}

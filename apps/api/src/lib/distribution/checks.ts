import type { ChannelCheck } from "@blog/shared";

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

export function isPublicHttpsUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password) return false;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".")) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
      const [a, b] = h.split(".").map(Number) as [number, number];
      if (a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)) return false;
    }
    return !h.startsWith("[");
  } catch {
    return false;
  }
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

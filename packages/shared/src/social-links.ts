import { z } from "zod";

// `@blog/shared` DOM/Node tiplarisiz quriladi — global `URL` (Node, brauzer, Next) uchun minimal e'lon.
interface ParsedUrl {
  protocol: string;
  hostname: string;
  username: string;
  password: string;
  pathname: string;
}
declare const URL: new (input: string) => ParsedUrl;

/**
 * Ijtimoiy havolalar qoidasi. Qiymat URL sifatida TAHLIL QILINADI (prefiks bo'yicha emas): `javascript:`, `data:`, `//host`,
 * boshqaruv belgilari va bo'shliqlar rad etiladi.
 *  - `isSafeSocialHref` / `safeSocialHref` — SAHIFADA chiqarish uchun: faqat `http:`, `https:`, `mailto:` (eski saqlangan qiymatlar ham).
 *  - `validateSocialLink` — YANGI kiritish uchun (MCP vositasi va admin forma): faqat `https:` yoki `mailto:` (+ `email` maydonida oddiy manzil).
 */
/** Boshqaruv belgilari (C0/C1), bo'shliq va teskari qiya chiziq — URL tahlilchisi ularni jimgina olib tashlaydi/o'zgartiradi. */
const FORBIDDEN_CHARS = {
  test(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c <= 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x5c) return true;
    }
    return false;
  },
};
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

function parse(value: string): ParsedUrl | null {
  if (value.length === 0 || value.length > 2000 || FORBIDDEN_CHARS.test(value)) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function mailtoAddress(url: ParsedUrl): string | null {
  try {
    const address = decodeURIComponent(url.pathname);
    return EMAIL.test(address) ? address : null;
  } catch {
    return null;
  }
}

/** Sahifada `href` sifatida chiqarish xavfsizmi (`http(s)` host bilan, yoki `mailto:` manzil bilan). */
export function safeSocialHref(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const url = parse(trimmed);
  if (!url) return null;
  if ((url.protocol === "https:" || url.protocol === "http:") && url.hostname !== "" && url.username === "" && url.password === "") return trimmed;
  if (url.protocol === "mailto:" && mailtoAddress(url)) return trimmed;
  return null;
}

/** `null` — to'g'ri; aks holda sabab. `key === "email"` bo'lsa oddiy `a@b.c` manzil ham to'g'ri. */
export function validateSocialLink(value: string | null | undefined, key?: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (key === "email" && !FORBIDDEN_CHARS.test(value) && EMAIL.test(value)) return null;
  const url = parse(value);
  if (!url) return "must be an https:// URL or a mailto: address";
  if (url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === "") return null;
  if (url.protocol === "mailto:" && mailtoAddress(url)) return null;
  return "must be an https:// URL or a mailto: address";
}

const strictLink = (key: string) =>
  z
    .string()
    .nullable()
    .refine((v) => validateSocialLink(v, key) === null, { message: "must be an https:// URL or a mailto: address (or null to clear)" })
    .default(null);

/** MCP vositasi uchun QATTIQ sxema (saqlangan eski qiymatlarni o'qiydigan `SocialLinksSchema` o'zgarmagan). */
export const StrictSocialLinksSchema = z.object({
  telegram: strictLink("telegram"),
  github: strictLink("github"),
  x: strictLink("x"),
  email: strictLink("email"),
});

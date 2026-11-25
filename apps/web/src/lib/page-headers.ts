import { FORGOT_PAGE_PATH, RESET_PAGE_PATH } from "./password-reset";

/**
 * Qo'shimcha javob header'lari (`src/proxy.ts` qo'llaydi). `next.config.ts`dagi `headers()` (faqat /login va /consent)
 * ataylab o'zgartirilmagan — boshqa marshrutlarning header'lariga tegilmaydi.
 *
 * - Admin panel (`/admin` va undagi hamma narsa) va yangi parol sahifalari iframe ichida ochilmasin (clickjacking).
 * - Tiklash sahifasi manzilida token bor: `Referrer-Policy: no-referrer` (token boshqa saytga Referer bilan chiqmasin)
 *   va `Cache-Control: no-store`.
 */
export const FRAME_DENY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
};

const TOKEN_PAGE_HEADERS: Record<string, string> = {
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

/** `proxy.ts` `config.matcher` bilan bir xil bo'lishi shart (test tekshiradi). */
export const PROXY_MATCHER = ["/admin/:path*", FORGOT_PAGE_PATH, RESET_PAGE_PATH];

function normalize(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

export function extraHeadersFor(pathname: string): Record<string, string> {
  const path = normalize(pathname);
  if (path === "/admin" || path.startsWith("/admin/")) return { ...FRAME_DENY_HEADERS };
  if (path === FORGOT_PAGE_PATH) return { ...FRAME_DENY_HEADERS };
  if (path === RESET_PAGE_PATH) return { ...FRAME_DENY_HEADERS, ...TOKEN_PAGE_HEADERS };
  return {};
}

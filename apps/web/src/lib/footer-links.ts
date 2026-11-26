import { safeSocialHref } from "@blog/shared";

export interface FooterLink {
  label: string;
  /** `null` — qiymat xavfsiz havola emas (masalan `javascript:`): matn sifatida chiqariladi, `href`siz. */
  href: string | null;
  text: string;
}

/**
 * Pastki qism havolalari. Saqlangan qiymat faqat `http(s)`/`mailto` bo'lsa havola bo'ladi; aks holda oddiy matn
 * (eski saqlangan qiymatlar rad etilmaydi, lekin hech qachon `href`ga tushmaydi).
 */
export function buildFooterLinks(social: { telegram?: string | null; github?: string | null } | null | undefined, fallback: { telegramUrl: string; githubUrl: string }): FooterLink[] {
  const entries: [string, string | null | undefined][] = [
    ["Telegram", social?.telegram || fallback.telegramUrl],
    ["GitHub", social?.github || fallback.githubUrl],
  ];
  const out: FooterLink[] = [];
  for (const [label, value] of entries) {
    if (!value) continue;
    out.push({ label, href: safeSocialHref(value), text: label });
  }
  return out;
}

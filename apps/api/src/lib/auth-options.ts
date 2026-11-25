import type { BetterAuthOptions } from "better-auth";
import { config } from "../config.js";


/** `lib/auth-handler.ts` mijoz IP'sini Better Auth'ga shu header orqali beradi. */
export const AUTH_CLIENT_IP_HEADER = "x-blog-client-ip";

/**
 * Brute-force'dan himoya qilinadigan Better Auth endpoint'lari. Har biri o'z
 * hisobiga ega (kalit — `IP|path`). `/sign-in/social` (GitHub OAuth boshlash)
 * ataylab kiritilmagan — u Better Auth'ning standart qoidasi bilan qoladi.
 */
export const AUTH_RATE_LIMITED_PATHS = [
  "/sign-in/email",
  "/sign-up/email",
  "/change-password",
  "/change-email",
  "/set-password",
  "/request-password-reset",
  "/forget-password",
  "/reset-password",
] as const;

/**
 * Better Auth'ning o'zining `rateLimit` mexanizmi (xotirada, bitta instansiya
 * uchun yetarli — mavjud limiter bilan bir xil cheklov). Standart qoida
 * (10 soniyada 3 ta) o'rniga 10 daqiqada 10 ta — qisqa muddatli portlashga
 * yo'l qo'yadi, lekin uzoq davom etuvchi taxminlashni to'xtatadi. Eslatma:
 * Better Auth muvaffaqiyatli so'rovlarni ham sanaydi (faqat xatolarni emas).
 */
export function buildAuthRateLimit(): NonNullable<BetterAuthOptions["rateLimit"]> {
  const rule = { window: config.AUTH_RATE_LIMIT_WINDOW_SECONDS, max: config.AUTH_RATE_LIMIT_MAX };
  return {
    // undefined — Better Auth'ning standarti (faqat production'da yoqiladi).
    enabled: config.AUTH_RATE_LIMIT_ENABLED,
    storage: "memory",
    customRules: Object.fromEntries(AUTH_RATE_LIMITED_PATHS.map((path) => [path, { ...rule }])),
  };
}

/**
 * Better Auth `advanced` bo'limi: IP header + (production'da) subdomenlararo cookie'lar. `lib/auth.ts` va
 * moslik testi (`production: true` varianti) bir xil funksiyadan foydalanadi.
 */
export function buildAuthAdvanced(production: boolean): NonNullable<BetterAuthOptions["advanced"]> {
  return {
    ipAddress: { ipAddressHeaders: [AUTH_CLIENT_IP_HEADER] },
    ...(production
      ? {
          crossSubDomainCookies: {
            enabled: true,
            domain: config.COOKIE_DOMAIN || ".abdusoft.uz",
          },
          defaultCookieAttributes: {
            secure: true,
            sameSite: "lax" as const,
          },
        }
      : {}),
  };
}

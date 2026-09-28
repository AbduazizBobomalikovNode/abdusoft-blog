import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  API_ORIGIN: z.url().default("http://localhost:4000"),
  WEB_ORIGIN: z.url().default("http://localhost:3000"),
  COOKIE_DOMAIN: z.string().optional().default(""),
  DATABASE_URL: z.string().optional().default(""),
  BETTER_AUTH_SECRET: z.string().min(1, "BETTER_AUTH_SECRET is required"),
  DEVICE_SECRET: z.string().optional().default(""),
  ADMIN_EMAIL: z.email().default("admin@example.com"),
  ADMIN_PASSWORD: z.string().min(8).default("admin12345"),
  GITHUB_CLIENT_ID: z.string().optional().default(""),
  GITHUB_CLIENT_SECRET: z.string().optional().default(""),
  R2_ACCOUNT_ID: z.string().optional().default(""),
  R2_ACCESS_KEY_ID: z.string().optional().default(""),
  R2_SECRET_ACCESS_KEY: z.string().optional().default(""),
  R2_BUCKET: z.string().optional().default(""),
  R2_PUBLIC_URL: z.string().optional().default(""),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional().default(""),
  TELEGRAM_ADMIN_CHAT_ID: z.string().optional().default(""),
  TELEGRAM_ADMIN_USER_IDS: z.string().optional().default(""),
  TELEGRAM_CHANNEL_ID: z.string().optional().default(""),
  TELEGRAM_API_ROOT: z.string().optional().default("https://api.telegram.org"),
  TELEGRAPH_ACCESS_TOKEN: z.string().optional().default(""),
  TELEGRAPH_API_ROOT: z.string().optional().default("https://api.telegra.ph"),
  // Telegraph ko'zgulash faqat shu bayroq true bo'lganda ishlaydi (prod'da yoqiladi).
  // Dev'da default false — mahalliy sinovlarda tashqi Telegraph API'ga urinilmaydi.
  TELEGRAPH_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  TURNSTILE_SECRET_KEY: z.string().optional().default(""),
  // true bo'lsa, prod'da TURNSTILE_SECRET_KEY bo'sh bo'lganda izoh yuborish rad etiladi
  // (fail-closed). false (default) bo'lsa, bo'sh kalit bilan tekshiruv o'tkazib yuboriladi
  // (fail-open) — lekin boot vaqtida ogohlantirish log qilinadi.
  REQUIRE_TURNSTILE: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  REVALIDATE_SECRET: z.string().optional().default(""),
  // apps/web dagi NEXT_PUBLIC_SITE_NAME'ga mos API-tomon muhit o'zgaruvchisi — sozlansa admin
  // panelidagi "Umumiy" bo'limidan ustun turadi (env > DB > default).
  SITE_NAME: z.string().optional().default(""),
  UMAMI_WEBSITE_ID: z.string().optional().default(""),
  UMAMI_SCRIPT_URL: z.string().optional().default(""),
  // Admin /admin/stats/umami proxy uchun (Umami Cloud yoki self-hosted API).
  UMAMI_API_URL: z.string().optional().default(""),
  UMAMI_API_KEY: z.string().optional().default(""),
  UMAMI_USERNAME: z.string().optional().default(""),
  UMAMI_PASSWORD: z.string().optional().default(""),
  // true bo'lsa, `x-forwarded-for`/`x-real-ip` header'lariga ishoniladi (Coolify/Traefik
  // orqasida VDS'da true qilinadi). false (default, dev) — faqat socket manzili ishlatiladi,
  // chunki header'ni mijoz o'zi soxtalashtirishi mumkin (rate-limit/IP-ban/Turnstile remoteip bypass).
  TRUST_PROXY: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  NODE_ENV: z
    .union([z.literal("development"), z.literal("production"), z.literal("test")])
    .default("development"),
});

// Eslatma: "bot token bo'lsa webhook secret ham SHART (kamida 16 belgi)"
// qoidasi ilgari shu yerda boot vaqtida superRefine bilan tekshirilib,
// buzilsa server ishga tushmasdan throw qilardi. Endi bot token/webhook secret
// DB (admin panel) orqali ham berilishi mumkin bo'lgani uchun bu qoida
// `lib/settings.ts`da RUNTIME'da (env+DB birlashtirilgandan keyin) tekshiriladi
// — buzilsa server qulab tushmaydi, faqat bot "o'chiq" holatda qoladi va sabab
// admin panelda (`GET /admin/settings` / `GET /admin/telegram/status`) ko'rinadi.
const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", z.treeifyError(parsed.error));
  throw new Error("Invalid environment variables");
}

export const config = parsed.data;

export const isProduction = config.NODE_ENV === "production";

/** Bot token bo'lmasa Telegram integratsiyasi butunlay o'chirilgan hisoblanadi — hamma joyda shu bayroqqa tayaniladi. */
export const TELEGRAM_ENABLED = config.TELEGRAM_BOT_TOKEN.length > 0;

/** `TELEGRAM_ADMIN_USER_IDS` — vergul bilan ajratilgan Telegram user id'lar ro'yxati (faqat shu foydalanuvchilar bot buyruqlarini yubora oladi). */
export const TELEGRAM_ADMIN_USER_IDS: number[] = config.TELEGRAM_ADMIN_USER_IDS.split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number)
  .filter((n) => Number.isFinite(n));

/** Telegraph mirroring shu bayroq true bo'lganda ishlaydi — dev'da default o'chiq. */
export const TELEGRAPH_ENABLED = config.TELEGRAPH_ENABLED;

if (isProduction && !config.TURNSTILE_SECRET_KEY) {
  console.warn(
    config.REQUIRE_TURNSTILE
      ? "OGOHLANTIRISH: TURNSTILE_SECRET_KEY bo'sh, REQUIRE_TURNSTILE=true — izoh yuborish rad etiladi (fail-closed)."
      : "OGOHLANTIRISH: TURNSTILE_SECRET_KEY bo'sh — prod muhitda Turnstile tekshiruvi o'tkazib yuborilmoqda (fail-open). REQUIRE_TURNSTILE=true qilib fail-closed rejimga o'tish mumkin.",
  );
}

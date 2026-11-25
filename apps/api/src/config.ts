import "dotenv/config";
import { z } from "zod";

/** Bo'sh yoki yo'q qiymat — `fallback`; aks holda butun son (`min`dan kam bo'lmagan). `FOO=` kabi bo'sh qator 0 deb o'qilmasin. */
const intEnv = (fallback: number, min: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().int().min(min).default(fallback),
  );

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
  // --- Autentifikatsiya (Better Auth) va admin yozuv marshrutlari uchun rate limit ---
  // AUTH_RATE_LIMIT_ENABLED: bo'sh (default) — Better Auth o'zi hal qiladi (faqat NODE_ENV=production'da
  // yoqiladi); "true"/"1" — doim yoqilgan; "false"/"0" — butunlay o'chirilgan.
  AUTH_RATE_LIMIT_ENABLED: z
    .string()
    .optional()
    .default("")
    .transform((v): boolean | undefined => {
      const s = v.trim().toLowerCase();
      if (s === "true" || s === "1") return true;
      if (s === "false" || s === "0") return false;
      return undefined;
    }),
  // Sign-in / sign-up / parol endpoint'lari: har bir endpoint uchun IP bo'yicha shu oynada ko'pi bilan MAX so'rov.
  // Default: 10 so'rov / 600 soniya (10 daqiqa).
  AUTH_RATE_LIMIT_MAX: intEnv(10, 1),
  AUTH_RATE_LIMIT_WINDOW_SECONDS: intEnv(600, 1),
  // /admin/* yozuv so'rovlari (POST/PUT/PATCH/DELETE): IP bo'yicha oynada ko'pi bilan MAX. 0 — o'chirilgan.
  // Default: 300 so'rov / 60 soniya (avtosaqlash va ommaviy amallarga yetarli).
  ADMIN_WRITE_RATE_LIMIT_MAX: intEnv(300, 0),
  ADMIN_WRITE_RATE_LIMIT_WINDOW_SECONDS: intEnv(60, 1),
  // Post tarixi (revision): oddiy tahrirlar (avtosaqlash) shu oraliqdan (daqiqa) tez-tez suratga olinmaydi —
  // faqat oraliq o'tganda yoki aktyor/kanal almashganda. 0 — har bir tahrirdan oldin surat.
  POST_REVISION_INTERVAL_MINUTES: intEnv(10, 0),
  // Bitta postda saqlanadigan revision'lar soni (eng eskilari o'chiriladi, eng yangisi hech qachon).
  POST_REVISION_MAX_PER_POST: intEnv(100, 1),
  // --- Claude konnektori (MCP) — default o'chiq; o'chiq bo'lsa API avvalgidek ishlaydi (hech qanday yangi marshrut/plagin yo'q) ---
  MCP_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  // Access token (JWT) umri, soniya. Qisqa — chunki JWT holatsiz; bekor qilish /mcp'da DB tekshiruvi bilan ham darhol ishlaydi.
  MCP_ACCESS_TOKEN_TTL_SECONDS: intEnv(900, 60),
  // Refresh token umri, kun (har yangilashda rotatsiya qilinadi).
  MCP_REFRESH_TOKEN_TTL_DAYS: intEnv(30, 1),
  // Claude'ning rasmiy callback'i va loopback'dan tashqari, ruxsat etiladigan qo'shimcha redirect URI'lar (vergul bilan, aniq `https://...`).
  MCP_ALLOWED_REDIRECT_URIS: z.string().optional().default(""),
  // `POST /api/auth/oauth2/register` (autentifikatsiyasiz): bitta IP uchun oynada ko'pi bilan MAX; bundan tashqari barcha IP'lar uchun umumiy GLOBAL_MAX.
  MCP_REGISTRATION_RATE_LIMIT_MAX: intEnv(20, 1),
  MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX: intEnv(1000, 1),
  // Rozilik olmagan klientlar soni shu chegaradan oshsa, eng eskilari o'chiriladi (yangi ro'yxatdan o'tish RAD ETILMAYDI — egasi bloklanmasin).
  MCP_MAX_UNCONSENTED_CLIENTS: intEnv(2000, 10),
  // `/mcp`ga brauzer `Origin` bilan kelganda ruxsat etiladigan qo'shimcha originlar (vergul bilan); `WEB_ORIGIN` doim ruxsat. `Origin`siz so'rovlar (Claude serveri, Claude Code) o'tadi.
  MCP_ALLOWED_ORIGINS: z.string().optional().default(""),
  MCP_REGISTRATION_RATE_LIMIT_WINDOW_SECONDS: intEnv(3600, 1),
  // `/mcp` so'rovlari: IP bo'yicha oynada ko'pi bilan MAX (0 — o'chirilgan).
  MCP_RATE_LIMIT_MAX: intEnv(300, 0),
  MCP_RATE_LIMIT_WINDOW_SECONDS: intEnv(60, 1),
  // Klient `offline_access`ni so'ramasa ham refresh token berilishi uchun /oauth2/authorize'ga uni qo'shadi (default true).
  MCP_FORCE_OFFLINE_ACCESS: z
    .string()
    .optional()
    .default("true")
    .transform((v) => !(v === "false" || v === "0")),
  // Hech qachon rozilik berilmagan ro'yxatdan o'tgan klientlar shu soatdan keyin tozalanadi.
  MCP_UNUSED_CLIENT_TTL_HOURS: intEnv(24, 1),
  // Bitta vosita javobining maksimal uzunligi (belgi). Claude ~150 000 belgigacha qabul qiladi.
  MCP_RESULT_MAX_CHARS: intEnv(100_000, 2_000),
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

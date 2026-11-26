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
  // --- Parolni tiklash (Telegram orqali, faqat admin) ---
  // Tiklash havolasi shuncha daqiqa amal qiladi (10..30; default 20) va faqat bir marta ishlaydi.
  PASSWORD_RESET_TTL_MINUTES: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().int().min(10).max(30).default(20),
  ),
  // Bitta admin hisobi uchun soatiga ko'pi bilan shuncha Telegram xabari yuboriladi (1..10; default 3).
  PASSWORD_RESET_MAX_PER_HOUR: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().int().min(1).max(10).default(3),
  ),
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
  // `client_id` https URL bo'lgan (Client ID Metadata Document) authorize so'rovlari uchun IP bo'yicha ALOHIDA byudjet (ro'yxatdan o'tish byudjetidan mustaqil).
  // Bo'sh qoldirilsa mos `MCP_REGISTRATION_RATE_LIMIT_*` qiymati olinadi (lekin hisob ALOHIDA yuritiladi).
  MCP_CIMD_RATE_LIMIT_MAX: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.coerce.number().int().min(1).optional()),
  MCP_CIMD_RATE_LIMIT_WINDOW_SECONDS: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.coerce.number().int().min(1).optional()),
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
  // --- Claude konnektori: YOZUV vositalari (default o'chiq). `MCP_ENABLED`dan tashqari, yozuv ruxsatlari va vositalari faqat shu yoqilganda mavjud. ---
  MCP_WRITE_TOOLS_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  // Chiqindi qutisidagi postni BUTUNLAY o'chirish vositasi uchun alohida kalit (qaytarib bo'lmaydi). `MCP_WRITE_TOOLS_ENABLED` ham yoqilgan bo'lishi shart.
  MCP_PURGE_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  // Rasm yuklash vositasi: dekodlangan rasmning eng katta hajmi (bayt). Base64 tufayli so'rov ~4/3 marta kattaroq bo'ladi.
  MCP_MEDIA_MAX_BYTES: intEnv(3 * 1024 * 1024, 1024),
  // Har bir ulanish (klient) uchun yozuv chegaralari. 0 — chegarasiz. Hisob jurnaldan olinadi (qayta ishga tushganda yo'qolmaydi).
  MCP_WRITE_LIMIT_CREATES_PER_HOUR: intEnv(20, 0),
  MCP_WRITE_LIMIT_EDITS_PER_HOUR: intEnv(200, 0),
  MCP_WRITE_LIMIT_UPLOADS_PER_HOUR: intEnv(30, 0),
  MCP_WRITE_LIMIT_PUBLISHES_PER_DAY: intEnv(10, 0),
  MCP_WRITE_LIMIT_CHANNEL_SENDS_PER_DAY: intEnv(10, 0),
  MCP_WRITE_LIMIT_SOCIAL_SENDS_PER_DAY: intEnv(5, 0),
  MCP_WRITE_LIMIT_MODERATION_PER_HOUR: intEnv(100, 0),
  MCP_WRITE_LIMIT_DESTRUCTIVE_PER_DAY: intEnv(30, 0),
  // --- Ijtimoiy tarqatish (LinkedIn, X, Threads, Instagram, GitHub README) — default o'chiq: o'chiq bo'lsa yangi marshrut, scheduler ishi va UI yo'q ---
  DISTRIBUTION_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  // --- Video (animatsiyali tushuntirish): render xizmati — default O'CHIQ. O'chiq bo'lsa yangi marshrut, vosita, scheduler ishi va UI yo'q;
  // render kodi API jarayoniga HECH QACHON yuklanmaydi (alohida jarayon, `docs/video.md`). ---
  VIDEO_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  // Ishchi jarayon ma'lumotlari: har bir ish uchun vaqtinchalik papka, bundle keshi, natija fayllari (saqlashga yuklanguncha). Bo'sh — `apps/api/.data/video`.
  VIDEO_DATA_DIR: z.string().optional().default(""),
  // `@blog/motion` paketi papkasi (render ishchisi shu yerdan ishga tushadi). Bo'sh — monorepo ichidagi `packages/motion`.
  VIDEO_MOTION_DIR: z.string().optional().default(""),
  // Bo'sh — Remotion o'rnatgan Chrome Headless Shell (`scripts/setup-motion-browser.sh`); aks holda brauzer fayliga to'liq yo'l.
  VIDEO_BROWSER_PATH: z.string().optional().default(""),
  // Bir vaqtda bajarilayotgan ishlar soni (1..4). `github` backendda har biri alohida GitHub runner; `local`da ko'pi bilan 2 (kichik serverda 1).
  VIDEO_MAX_RUNNING: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.coerce.number().int().min(1).max(4).default(1)),
  // Bitta ishchida parallel kadrlar (Remotion concurrency). Har biri taxminan 0.4-0.6 GB xotira qo'shadi.
  VIDEO_CONCURRENCY: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.coerce.number().int().min(1).max(8).default(1)),
  // Ishchi jarayon daraxti (Node + Chrome) uchun xotira shifti, MB (RSS yig'indisi). Oshsa butun guruh o'ldiriladi.
  VIDEO_WORKER_MEMORY_MB: intEnv(1536, 256),
  // Ishchi Node jarayonining V8 heap chegarasi, MB.
  VIDEO_WORKER_HEAP_MB: intEnv(512, 128),
  // Ishchi jarayonning CPU ustuvorligi (nice, 0..19; katta = kamroq CPU). Blog saytiga xalaqit bermasligi uchun.
  VIDEO_WORKER_NICE: intEnv(15, 0),
  // Devor soati chegaralari, soniya: render/GIF va ko'rik (preview).
  VIDEO_RENDER_TIMEOUT_SECONDS: intEnv(900, 30),
  VIDEO_PREVIEW_TIMEOUT_SECONDS: intEnv(120, 10),
  // Kvotalar. 0 — chegarasiz (tavsiya etilmaydi).
  VIDEO_MAX_RENDERS_PER_DAY: intEnv(10, 0),
  VIDEO_MAX_PREVIEWS_PER_DAY: intEnv(60, 0),
  VIDEO_MAX_QUEUE: intEnv(5, 1),
  // Disk va xotira yetishmasa yangi ish rad etiladi (MB).
  VIDEO_MIN_FREE_DISK_MB: intEnv(2048, 0),
  VIDEO_MIN_FREE_MEMORY_MB: intEnv(1400, 0),
  // Natija fayllari: hajm chegaralari (bayt) va saqlash qoidasi.
  VIDEO_MAX_MP4_BYTES: intEnv(80 * 1024 * 1024, 1024),
  VIDEO_MAX_GIF_BYTES: intEnv(25 * 1024 * 1024, 1024),
  VIDEO_MAX_STILL_BYTES: intEnv(600 * 1024, 1024),
  VIDEO_KEEP_RENDERS_PER_POST: intEnv(3, 1),
  VIDEO_PREVIEW_TTL_HOURS: intEnv(6, 1),
  // Muvaffaqiyatsiz/bekor qilingan ishlar yozuvi shuncha kundan keyin o'chiriladi.
  VIDEO_FAILED_TTL_DAYS: intEnv(7, 1),
  // Render qayerda bajariladi: `github` (tavsiya etiladi: GitHub Actions runner) yoki `local` (server ichida alohida jarayon; glibc >= 2.35 va >= 2 GB bo'sh xotira kerak).
  VIDEO_RUNNER: z.enum(["github", "local"]).optional().default("github"),
  // GitHub backend: ishchi (runner) va API o'rtasidagi umumiy sir (>= 32 belgi). Har bir ish uchun HMAC bilan alohida token chiqariladi. Faqat env.
  VIDEO_RUNNER_SECRET: z.string().optional().default(""),
  // GitHub backend: workflow'ni ishga tushiruvchi fine-grained token ("Actions: Read and write") va repozitoriy `egasi/nomi`. Env > admin panel (shifrlangan).
  VIDEO_GITHUB_TOKEN: z.string().optional().default(""),
  VIDEO_GITHUB_REPO: z.string().optional().default(""),
  // Dispatch nishoni: workflow fayl nomi va shox. Env > admin panel. Tokenni ALOHIDA kichik repozitoriyga cheklash uchun (docs/video.md).
  VIDEO_GITHUB_WORKFLOW: z.string().optional().default(""),
  VIDEO_GITHUB_REF: z.string().optional().default(""),
  // `true` bo'lsa dispatch blogning O'Z repozitoriysiga ham ruxsat etiladi (tavsiya etilmaydi: token deploy.yml'ni ham ishga tushira oladi).
  VIDEO_ALLOW_SAME_REPO: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  // GitHub runner'da parallel kadrlar (hosted runner: 4 yadro). Runner o'z yadrolari soni bilan yana cheklaydi.
  VIDEO_RUNNER_CONCURRENCY: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.coerce.number().int().min(1).max(8).default(4)),
  // Dispatch'dan keyin ishchi shuncha soniyada `claim` qilmasa ish `runner_not_started` bilan to'xtaydi.
  VIDEO_RUNNER_START_TIMEOUT_SECONDS: intEnv(600, 30),
  // `preview_storyboard` ko'rik tayyor bo'lishini ko'pi bilan shuncha soniya kutadi (proksi 60 soniyada uzadi; 5..50).
  VIDEO_PREVIEW_WAIT_SECONDS: intEnv(40, 5),
  // Platforma ilovalari (client id / secret) — env > admin panel (shifrlangan). Bo'sh bo'lsa panelda kiritiladi.
  DISTRIBUTION_LINKEDIN_CLIENT_ID: z.string().optional().default(""),
  DISTRIBUTION_LINKEDIN_CLIENT_SECRET: z.string().optional().default(""),
  DISTRIBUTION_X_CLIENT_ID: z.string().optional().default(""),
  DISTRIBUTION_X_CLIENT_SECRET: z.string().optional().default(""),
  DISTRIBUTION_THREADS_CLIENT_ID: z.string().optional().default(""),
  DISTRIBUTION_THREADS_CLIENT_SECRET: z.string().optional().default(""),
  DISTRIBUTION_INSTAGRAM_CLIENT_ID: z.string().optional().default(""),
  DISTRIBUTION_INSTAGRAM_CLIENT_SECRET: z.string().optional().default(""),
  // Instagram (Unified Login): Meta ilovasining App ID/Secret'i yuqoridagi CLIENT_ID/CLIENT_SECRET'ga yoziladi; Config ID maxfiy emas.
  DISTRIBUTION_INSTAGRAM_CONFIG_ID: z.string().optional().default(""),
  // Noto'g'ri/bo'sh qiymat provider ichida `v27.0` ga qaytadi (yuklashni to'xtatmaydi).
  DISTRIBUTION_INSTAGRAM_GRAPH_VERSION: z.string().optional().default("v27.0"),
  // GitHub profil README bloki: nechta so'nggi maqola yoziladi.
  DISTRIBUTION_GITHUB_README_POSTS: intEnv(5, 1),
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

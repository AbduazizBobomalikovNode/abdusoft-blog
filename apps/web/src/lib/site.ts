/**
 * `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_SITE_URL` HAR DOIM env'dan (build-time,
 * o'zgarmas infra qiymatlari). Qolgan maydonlar (`turnstileSiteKey`,
 * `githubLoginEnabled`, `umamiScriptUrl`, `umamiWebsiteId`, `name`) endi admin
 * panelda ham sozlanadi (`apps/api`dagi `lib/settings.ts`) — bu yerdagi
 * env qiymatlari faqat FALLBACK: API ishlamay qolsa yoki `(site)` layout
 * hali ishlamagan joyda (masalan root metadata) ishlatiladi. Haqiqiy
 * runtime qiymat `GET /site`ning `config` maydonidan keladi —
 * `lib/site-config.tsx`dagi `useSiteConfig()` orqali o'qiladi.
 */
export const site = {
  name: process.env.NEXT_PUBLIC_SITE_NAME ?? "abdusoft",
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000",
  telegramUrl: process.env.NEXT_PUBLIC_TELEGRAM_URL ?? "",
  githubUrl: process.env.NEXT_PUBLIC_GITHUB_URL ?? "",
  turnstileSiteKey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "",
  githubLoginEnabled: process.env.NEXT_PUBLIC_GITHUB_LOGIN === "1",
  umamiScriptUrl: process.env.NEXT_PUBLIC_UMAMI_SCRIPT_URL ?? "",
  umamiWebsiteId: process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID ?? "",
};

# @blog/web

abdusoft blog'ning ochiq sayti va admin paneli — Next.js 16 (App Router), React 19, Tailwind 4. Vercel'da joylashtiriladi (Root Directory: `apps/web`).

Ma'lumotlar (postlar, izohlar, sessiya) shu ilovada saqlanmaydi: hammasi `apps/api` (Hono + Postgres) dan olinadi. API manzili `NEXT_PUBLIC_API_URL` orqali beriladi (lokalda `http://localhost:4000`, prod'da `https://api.abdusoft.uz`).

Umumiy tavsif, arxitektura va deploy: [root README](../../README.md).

## Buyruqlar

Monorepo'da `pnpm` ishlating (npm/yarn lockfile'ni buzadi). Repo ildizidan:

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local
pnpm dev                           # shared build + api :4000 va web :3000
pnpm --filter @blog/shared build   # web'ni alohida build qilishdan oldin kerak
pnpm --filter @blog/web build      # production build
pnpm --filter @blog/web start      # production serverni ishga tushirish
pnpm --filter @blog/web typecheck  # next typegen + tsc --noEmit
pnpm --filter @blog/web lint
pnpm --filter @blog/web test       # vitest
```

## Muhit o'zgaruvchilari

Namuna: `.env.example` (dev) va `.env.production.example` (Vercel).

| O'zgaruvchi | Nima uchun |
|---|---|
| `NEXT_PUBLIC_API_URL` | `apps/api` manzili |
| `NEXT_PUBLIC_SITE_URL` | Saytning o'z manzili (sitemap, RSS, OG rasm, JSON-LD) |
| `NEXT_PUBLIC_SITE_NAME` | Sayt nomi |
| `REVALIDATE_SECRET` | `/api/revalidate` himoyasi; `apps/api`dagi bilan bir xil bo'lishi shart |
| `NEXT_PUBLIC_TELEGRAM_URL`, `NEXT_PUBLIC_GITHUB_URL` | Ixtiyoriy — footer/RSS havolalari |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Ixtiyoriy — izoh formasidagi Cloudflare Turnstile |
| `NEXT_PUBLIC_GITHUB_LOGIN` | Ixtiyoriy — `1` bo'lsa "GitHub bilan kirish" tugmasi |
| `NEXT_PUBLIC_UMAMI_SCRIPT_URL`, `NEXT_PUBLIC_UMAMI_WEBSITE_ID` | Ixtiyoriy — Umami analytics |

## Tuzilma

- `src/app/(site)` — ochiq sahifalar (bosh sahifa, post, teglar, qidiruv)
- `src/app/admin` — admin panel (muharrir, media, izohlar, statistika, sozlamalar)
- `src/app/api/revalidate` — API post o'zgarganda keshni yangilash uchun chaqiradi
- `src/app/sitemap.ts`, `robots.ts`, `rss.xml` — SEO va lenta
- `src/lib` — API klienti, sayt sozlamalari, yordamchi funksiyalar

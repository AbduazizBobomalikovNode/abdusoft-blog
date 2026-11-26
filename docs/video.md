# Video: animatsiyali tushuntirish render xizmati

Egasining yordamchisi (Claude konnektori) post uchun qisqa, **ovozsiz** (≤ 60 s) tushuntirish videosini storyboard asosida tayyorlay oladi. **Serverda AI modeli yo'q:** storyboard'ni yordamchi yozadi, server faqat tekshiradi va renderlaydi (`packages/motion`, Remotion). Bu hujjat — server operatori uchun. Konnektor tomoni: [claude-connector.md](claude-connector.md) (18-bo'lim).

Xizmat **default o'chiq** (`VIDEO_ENABLED=false`): o'chiq bo'lsa yangi marshrut, vosita, scheduler ishi va panel tugmasi yo'q, render kodi API jarayoniga umuman yuklanmaydi.

## Qanday ishlaydi (xavfsizlik va resurs nazorati)

- Render **hech qachon API jarayonida** bajarilmaydi. Scheduler (har 5 s) navbatdan **bitta** ishni atomik "claim" qiladi (`queued -> running`) va **alohida ishchi jarayon** (`packages/motion/src/worker/main.ts`) ishga tushiradi.
- Ishchi: o'z **jarayon guruhi** (timeout/bekor qilish/API to'xtashi butun guruhni — Node, Chrome, ffmpeg — o'ldiradi), `nice` (CPU ustuvorligi past), Node heap chegarasi, Remotion `concurrency=1`, devor soati taymeri, **xotira shifti** (har soniyada guruh RSS yig'indisi o'lchanadi, oshsa guruh o'ldiriladi), o'z vaqtinchalik va kesh papkalari (`VIDEO_DATA_DIR`), **sirlarsiz muhit** (faqat PATH, HOME/TMPDIR ish papkasi ichida, kesh yo'llari). API qulasa (SIGKILL), ishchi o'zi ham to'xtaydi (ota jarayon kuzatiladi); keyingi ishga tushishda `running` qolgan ishlar `failed` ("interrupted") bo'ladi, qolib ketgan guruh o'ldiriladi va ish papkalari tozalanadi.
- Brauzer **hech qachon avtomatik yuklanmaydi**: yo'q bo'lsa ish `browser_missing` bilan yiqiladi (o'rnatish yo'li xabarda). Yagona joy — `scripts/setup-motion-browser.sh`.
- Storyboard — ishonchsiz kiritma: saqlashdan oldin, ishchi ishga tushishidan oldin va ishchi ichida qayta tekshiriladi (bayt hajmi, matn uzunligi, sahna id'lari noyobligi, xatolar soni cheklangan).
- Natijalar (MP4, GIF, ko'rik JPEG) mavjud media saqlash qatlami orqali (R2 yoki mahalliy `uploads`) `video/` prefiksi ostida, alohida hajm chegaralari bilan saqlanadi; URL rasmlardagi kabi.

## Yoqish

1. Monorepo bog'liqliklari serverda o'rnatilgan bo'lishi kerak (`pnpm install --frozen-lockfile` — `packages/motion` ham o'rnatiladi). Ishchi `packages/motion/src/worker/main.ts` ni Node 24 (turlarni o'zi olib tashlaydi) bilan ishga tushiradi, shuning uchun serverdagi daraxtda `packages/motion` manbasi bo'lishi shart.
2. Brauzerni **bir marta** o'rnating (idempotent):
   ```bash
   sudo bash scripts/setup-motion-browser.sh --install-deps   # Ubuntu/Debian: kutubxonalar (apt)
   bash scripts/setup-motion-browser.sh                       # brauzerni yuklaydi (~100 MB), holatni ko'rsatadi
   bash scripts/setup-motion-browser.sh --check               # faqat tekshiradi
   ```
   Brauzer `packages/motion/node_modules/.remotion` ga tushadi (git'da yo'q). Kerak bo'lsa tizim Chromium'i: `VIDEO_BROWSER_PATH=/usr/bin/chromium`.
3. `apps/api/.env` da `VIDEO_ENABLED=true` (konnektor tomoni uchun `MCP_ENABLED=true` va `MCP_WRITE_TOOLS_ENABLED=true`), API'ni qayta ishga tushiring. Migratsiya `0017_motion_jobs` (qo'shimcha jadvallar) deploy bilan o'zi qo'llanadi.
4. Tekshirish: admin panel → Sozlamalar → "Umumiy": "Video xizmati: yoqilgan. Brauzer o'rnatilgan." qatori; yoki konnektorda `get_video_status`.
5. Konnektorni qayta ulang va rozilik sahifasida **"Video yaratish"** ruxsatini belgilang (yangi ruxsat — eski ulanishga o'zi qo'shilmaydi).

### Ubuntu 20.04 uchun tizim kutubxonalari (headless Chromium)

`ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2`

(`--install-deps` aynan shularni `apt-get install --no-install-recommends` bilan o'rnatadi.) GPU, X server va swap kerak emas.

## Sozlamalar (`apps/api/.env`)

| O'zgaruvchi | Default | Tavsiya: 4 yadro, ~2 GB bo'sh RAM | Ma'nosi |
|---|---|---|---|
| `VIDEO_ENABLED` | `false` | `true` | Asosiy kalit |
| `VIDEO_MAX_RUNNING` | `1` | `1` | Mashinada bir vaqtda ishlaydigan render (1..2) |
| `VIDEO_CONCURRENCY` | `1` | `1` | Parallel kadrlar; har biri ~0.4-0.6 GB |
| `VIDEO_WORKER_MEMORY_MB` | `1536` | `1400` | Ishchi daraxti RSS shifti (o'lchangan cho'qqi ~0.8 GB) |
| `VIDEO_WORKER_HEAP_MB` | `512` | `512` | Ishchi Node V8 heap |
| `VIDEO_WORKER_NICE` | `15` | `15`-`19` | CPU ustuvorligi |
| `VIDEO_RENDER_TIMEOUT_SECONDS` | `900` | `900` | Render/GIF devor soati |
| `VIDEO_PREVIEW_TIMEOUT_SECONDS` | `120` | `120` | Ko'rik (≤ 180) — vosita 240 s chegarasidan past |
| `VIDEO_MAX_RENDERS_PER_DAY` / `_PREVIEWS_PER_DAY` | `10` / `60` | `10` / `60` | Aylanma 24 soatdagi chegaralar |
| `VIDEO_MAX_QUEUE` | `5` | `3` | Navbat uzunligi |
| `VIDEO_MIN_FREE_MEMORY_MB` / `_DISK_MB` | `1400` / `2048` | `1400` / `3072` | Kamroq bo'lsa yangi ish rad etiladi, navbatdagisi kutadi |
| `VIDEO_MAX_MP4_BYTES` / `_GIF_BYTES` / `_STILL_BYTES` | 80 MB / 25 MB / 600 KB | shunday | Natija hajmi chegarasi |
| `VIDEO_KEEP_RENDERS_PER_POST` | `3` | `2` | Postda oxirgi N render (havola qilingani hech qachon o'chmaydi) |
| `VIDEO_PREVIEW_TTL_HOURS` / `VIDEO_FAILED_TTL_DAYS` | `6` / `7` | shunday | Ko'rik va xatolik yozuvlari muddati |
| `VIDEO_DATA_DIR`, `VIDEO_MOTION_DIR`, `VIDEO_BROWSER_PATH` | bo'sh | bo'sh | Ma'lumot papkasi (`apps/api/.data/video`), `packages/motion`, brauzer yo'li |

Ma'lumot papkasi (`VIDEO_DATA_DIR`): `jobs/<id>/` (ish tugagach o'chadi), `cache/` (webpack bundle keshi, manba o'zgarganda eskisi tozalanadi — qayta yaratiladigan), `xdg/` (shrift keshi). Natija fayllari esa `uploads/video/...` (yoki R2 `video/...`).

## O'lchovlar (haqiqiy render, ishchi orqali, concurrency 1, xotira shifti 1536 MB)

Mashina: **Apple M1 (8 yadro), 8 GB RAM, macOS** — boshqa ishlar bilan band bo'lgan noutbuk (load average ~15-25). Server (4 yadro, `nice 15`) sekinroq bo'ladi: vaqtlarni ~2x deb oling. Fixture: `packages/motion/fixtures/showcase.json` (56.6 s, 9 sahna).

| Ish | Devor vaqti | Jarayon daraxti cho'qqi RSS | Chiqish |
|---|---|---|---|
| Ko'rik, 9 kadr (480 px), bundle sovuq (birinchi marta) | 8.8 s | 516 MB | 9 JPEG, 7-14 KB (jami 93 KB) |
| Ko'rik, 9 kadr, bundle keshda | 4.7 s | 198 MB | xuddi shu |
| Ko'rik, 4 kadr | 2.4 s | 179 MB | 4 JPEG, jami 36 KB |
| MP4, 1698 kadr (56.6 s) | 107.7 s (~1.9 s / video soniya) | 822 MB | 6.5 MiB |

Xulosa: render paytida ~0.8 GB (cho'qqi bundle qurilayotgan paytda ~0.5 GB), shuning uchun 1400-1536 MB shift va 1400 MB minimal bo'sh xotira xavfsiz zaxira beradi. `VIDEO_CONCURRENCY=2` xotirani ~0.5 GB oshiradi — kichik serverda tavsiya etilmaydi. O'zingizning serveringizda o'lchash: o'sha testni ishga tushiring:
```bash
VIDEO_REAL_TESTS=1 VIDEO_CONCURRENCY=1 VIDEO_WORKER_MEMORY_MB=1536 \
  pnpm --filter @blog/api exec vitest run src/lib/video/real.test.ts
```
U `VIDEO-MEASUREMENTS` bloki bilan devor vaqti, cho'qqi xotira (ishchi daraxti) va fayl hajmlarini chiqaradi. Panelda har bir ish uchun `timings.wallMs` / `peakRssMb` saqlanadi (admin API `GET /admin/video/jobs/:id`), taxminlar (`dry_run`) tugagan ishlar tezligidan o'zi aniqlashadi.

## O'chirish

- `VIDEO_ENABLED=false` va API'ni qayta ishga tushirish: marshrutlar, vositalar, scheduler ishi va panel tugmasi yo'qoladi; jadvallar va yuklangan fayllar joyida qoladi. Navbatdagi/ishlayotgan ishlar to'xtaydi (ishchi guruhlari o'ldiriladi).
- Fayllarni ham olib tashlash uchun avval yoqilgan holda ishlarni panelda/`delete_video_job` bilan o'chiring.
- Faqat konnektorni cheklash: `MCP_WRITE_TOOLS_ENABLED=false` — render vositalari yo'qoladi (o'qish vositalari qoladi).

## Nosozliklarni topish

| Belgi | Sabab / yechim |
|---|---|
| Ish `failed`, `browser_missing` | `bash scripts/setup-motion-browser.sh` ni ishga tushiring; `--check` bilan tekshiring. Kutubxona yetishmasa skript ro'yxatini ko'rsatadi |
| `failed`, `timeout` | Ish `VIDEO_RENDER_TIMEOUT_SECONDS` dan oshdi: server band yoki storyboard og'ir; qisqartiring yoki chegarani oshiring |
| `failed`, `memory` | Ishchi daraxti `VIDEO_WORKER_MEMORY_MB` dan oshdi: `VIDEO_CONCURRENCY=1` ekanini va boshqa jarayonlar xotirasini tekshiring |
| `failed`, `interrupted` | API render paytida qayta ishga tushgan; ishni qaytadan boshlang |
| `failed`, `too_large` | MP4/GIF hajm chegarasidan oshdi; storyboard'ni qisqartiring yoki chegarani oshiring |
| Refusal `low_memory` / `low_disk` | Server band; navbatdagi ishlar kutadi (60 daqiqadan keyin `low_resources` bilan yiqiladi) |
| Refusal `queue_full`, `daily_renders`, `post_busy` | Mos ravishda `VIDEO_MAX_QUEUE`, `VIDEO_MAX_RENDERS_PER_DAY` yoki postdagi faol ishni kuting/bekor qiling |
| Ishlar ko'rinadi, lekin hech qachon boshlanmaydi | `VIDEO_ENABLED=true` va API logida "Video xizmatini ishga tushirib bo'lmadi" yo'qligini; `ps` da qolib ketgan `worker/main.ts` yo'qligini tekshiring |
| MP4 brauzer tabida bo'sh | `/uploads` CSP (`sandbox`) to'g'ridan-to'g'ri ochishni cheklaydi; "Yuklab olish" yoki `<video>` ichida ishlatish ishlaydi |

Log: API stdout (`Video ...` qatorlari, ishchi stderr oxiri xatoda qisqa ko'rinadi). Qo'lda sinash (API'siz): `pnpm --filter @blog/motion exec blog-motion stills packages/motion/fixtures/showcase.json --out /tmp/x --browser ...`.

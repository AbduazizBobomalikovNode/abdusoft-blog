# Changelog

## v1.0.0 — 2026-10-01

[O'zbekcha](#ozbekcha) · [English](#english)

### O'zbekcha

Birinchi barqaror versiya. Shaxsiy texnologik blog platformasi: ochiq sayt, admin panel va Telegram kanal bilan to'liq ishlash.

**O'quvchi uchun**
- Tez, ixcham o'qish sahifasi: mundarija, o'qish jarayoni chizig'i, o'qish vaqti, light/dark rejim
- Kod bloklari (Shiki, nusxalash, fayl nomi), callout'lar, rasm lightbox
- To'liq matnli qidiruv, teglar, RSS, sitemap, har post uchun OG rasm

**Fikrlar va reaksiyalar**
- Daraxtsimon izohlar, layk/dizlayk, anonim yoki GitHub orqali yozish
- Spam himoyasi: Cloudflare Turnstile, rate limit, honeypot, qurilma bloklash
- Moderatsiya: tasdiqlash, yashirish, o'chirish, javob berish, bloklash; manba, post va vaqt bo'yicha filtrlar

**Yozish va admin panel**
- Tiptap muharriri: doimiy formatlash paneli (telefonda klaviatura ustida), "/" buyruqlar menyusi, "+" blok qo'shish
- Noldan boshlash uchun shablonlar va Markdown import
- Markdown, Google Docs, Word va veb-sahifadan toza qo'yish; rasmni qo'yish yoki sudrab tashlash
- Rasm, havola, jadval va kod bloki uchun boshqaruv; mundarija, so'z soni, diqqat rejimi, yorliqlar ro'yxati
- Avtosaqlash, brauzerda zaxira nusxa, oldindan ko'rish, rejalashtirish, chop etishdan oldin tekshiruv ro'yxati
- Media kutubxonasi (Cloudflare R2 yoki lokal disk, WebP), teglar, har post uchun sozlamalar
- Statistika: ko'rishlar, layk/dizlayk, izohlar, har post bo'yicha; Umami bilan tashrifchilar

**Telegram kanal**
- Kanalga yuborish oynasi: Versiya → Tahrirlash → Tekshiruv, Telegram ko'rinishidagi jonli preview bilan
- Rasmli rejim (muqova va rasmlar albom bo'lib, matn rasm ostida, 1024 belgigacha) va Rasmsiz rejim (4096 belgigacha)
- Avtomatik uzunlik variantlari va qo'lda tahrirlangan maxsus versiyalar; bittasini ⭐ asosiy qilib belgilash
- Telegram'ning rasmiy cheklovlari bo'yicha oldindan tekshiruv; xato bo'lsa yuborish bloklanadi
- Rejalashtirilgan post kanalga belgilangan versiya va kechikish bilan o'zi yuboriladi
- Telegraph nusxasi: muqova, brend nomi, o'qiladigan jadvallar bilan
- Muhokama guruhidagi izohlar admin panelga tushadi; paneldan yozilgan javob guruhga yuboriladi
- Admin chatda izoh bildirishnomalari va moderatsiya tugmalari, bot buyruqlari, kunlik hisobot

**Xodimlar**
- Bir martalik taklif havolasi, GitHub orqali kirish
- Xodim qoralama yozadi va ko'rib chiqishga yuboradi; egasi panelda yoki Telegram'da tasdiqlaydi yoki qaytaradi
- Xodim kanal versiyasini tayyorlab, taklif sifatida belgilashi mumkin; yuborish huquqi faqat egada

**Sozlamalar va xavfsizlik**
- Integratsiyalar admin paneldan boshqariladi; env qiymati ustun; sirlar bazada AES-256-GCM bilan shifrlangan
- Rollar API darajasida tekshiriladi; webhook secret majburiy; proxy ortidagi IP, rate limit, SVG tozalash

**Deploy**
- VDS'da Docker'siz: systemd, nginx, certbot; `scripts/deploy-vds.sh` va kunlik backup skripti
- Muqobil: Docker Compose; prod env generatori `scripts/init-prod-env.sh`

**Texnik**
- Next.js 16, React 19, Hono 4, Drizzle ORM, PostgreSQL 17, Better Auth, grammY, Tiptap 3
- 10 ta migratsiya (0000–0009), 337 ta avtomatik test

**Ma'lum cheklovlar**
- Bot guruhda faqat o'z nomidan yozadi, kanal nomidan emas (Bot API cheklovi)
- Yuborilgan albom rasmlarini keyin o'zgartirib bo'lmaydi, faqat matn yangilanadi
- Bot 48 soatdan eski kanal xabarini o'chira olmaydi
- Telegram'ning o'zida o'chirilgan izoh panelda qoladi
- R2 sozlanmagan bo'lsa, lokal yuklangan rasmlar build papkasi ichida saqlanadi va backup'ga kirmaydi
- Telefon klaviaturasi ustidagi panel faqat simulyatsiyada sinalgan
- README'ning deploy bo'limi qisman eskirgan (Vercel va Docker yo'lini tasvirlaydi)

---

### English

First stable release. A personal tech blog platform: public site, admin panel and full Telegram channel workflow.

**Readers**
- Fast, compact reading page: table of contents, reading progress, reading time, light/dark mode
- Code blocks (Shiki, copy, filename), callouts, image lightbox
- Full-text search, tags, RSS, sitemap, per-post OG image

**Comments and reactions**
- Threaded comments, like/dislike, anonymous or GitHub sign-in
- Spam protection: Cloudflare Turnstile, rate limits, honeypot, device bans
- Moderation: approve, hide, delete, reply, ban; filters by source, post and date

**Writing and admin panel**
- Tiptap editor: persistent formatting toolbar (above the keyboard on mobile), "/" command menu, "+" block inserter
- Templates and Markdown import for starting from scratch
- Clean paste from Markdown, Google Docs, Word and web pages; image paste and drag-and-drop
- Image, link, table and code block tools; outline, word count, focus mode, shortcuts sheet
- Autosave, local draft backup, preview, scheduling, pre-publish checklist
- Media library (Cloudflare R2 or local disk, WebP), tags, per-post settings
- Statistics: views, likes/dislikes, comments, per post; visitors via Umami

**Telegram channel**
- Send dialog: Version → Edit → Check, with a Telegram-style live preview
- Photo mode (cover and images as an album, text in the caption, up to 1024 characters) and text mode (up to 4096)
- Automatic length variants and hand-edited custom versions; one can be marked ⭐ as the default
- Preflight against the official Telegram limits; sending is blocked while errors remain
- Scheduled posts go to the channel with the marked version and a chosen delay
- Telegraph mirror with cover, brand author name and readable tables
- Discussion group comments sync into the admin panel; replies from the panel are posted to the group
- Comment notifications with moderation buttons in the admin chat, bot commands, daily digest

**Staff**
- One-time invite link, GitHub sign-in
- Staff write drafts and submit for review; the owner approves or returns them in the panel or in Telegram
- Staff can prepare and suggest a channel version; only the owner can send

**Settings and security**
- Integrations managed from the admin panel; env values take precedence; secrets encrypted at rest with AES-256-GCM
- Roles enforced in the API; mandatory webhook secret; proxy-aware client IP, rate limits, SVG sanitising

**Deployment**
- Native on a VDS: systemd, nginx, certbot; `scripts/deploy-vds.sh` and a daily backup script
- Alternative: Docker Compose; production env generator `scripts/init-prod-env.sh`

**Technical**
- Next.js 16, React 19, Hono 4, Drizzle ORM, PostgreSQL 17, Better Auth, grammY, Tiptap 3
- 10 migrations (0000–0009), 337 automated tests

**Known limitations**
- The bot posts in the group under its own name, not as the channel (Bot API limitation)
- Album media cannot be changed after sending; only the text is updated
- The bot cannot delete channel messages older than 48 hours
- Comments deleted inside Telegram remain in the panel
- Without R2, locally uploaded images live inside the build folder and are not included in backups
- The above-keyboard toolbar on mobile was tested only in simulation
- The README deploy section is partly outdated (it describes the Vercel and Docker path)

# Changelog

## Unreleased

[O'zbekcha](#ozbekcha) · [English](#english)

### O'zbekcha

**Hujjat: tarqatish holati**
- LinkedIn, Threads, Instagram va GitHub README haqiqiy hisobda tekshirilgan (2026-11); X, X zanjiri va «saytga chiqqach» rejasi hali haqiqiy akkauntda sinalmagan

**Tarqatish: X zanjiri (thread)**
- X kanalida ixtiyoriy «Zanjir (thread)»: matn `---` satrlari bo'yicha va 280 dan oshsa gap/so'z chegarasida (URL va grafema bo'linmaydi) javob tvitlariga bo'linadi; ixtiyoriy « 1/n» raqamlash (vazni hisobga olinadi); ko'pi bilan 15 tvit. Standart — bitta tvit (xatti-harakat o'zgarmagan)
- Yuborish: 1-tvit (rasm shunda), keyingilari oldingisiga javob; har tvitdan keyin id saqlanadi — xatodan keyin qayta urinish qolgan qismdan davom etadi va oldingilarini qayta yubormaydi; noaniq natija — «tekshirish kerak». «Platformadan olib tashlash» barcha tvitlarni teskari tartibda o'chiradi
- Veb: zanjir va raqamlash tugmalari, jonli ko'rinishda bog'lovchi chiziqli tvitlar zanjiri va «3 ta tvit · 2-si 291/280» hisoblagichi. Claude: `x_thread` / `x_thread_numbering` (preview, save, send, schedule, set plan), javobda `threadParts`
- Additiv migratsiya `0023`: `distributions.x_thread`, `x_thread_numbering`, `thread_ids`. Haqiqiy X akkauntida hali sinalmagan (testlar mock)

**Tarqatish: Telegram yorlig'i endi foydali**
- Dialogdagi Telegram yorlig'ida: tanlangan versiya (belgi, uzunlik, cheklov), kanal rejasi («saytga chiqqach 15 daq»), yuborilgan bo'lsa holat va havola, belgilangan versiyaning Telegram ko'rinishi va «Telegram oynasini ochish» tugmasi (Tarqatish yopiladi, Telegram oynasi ochiladi). Faqat veb: API, yuborish va Claude vositalari o'zgarmagan

**Tarqatish: "saytga chiqqach N daqiqadan keyin" rejasi (Telegram rejasi kabi)**
- Har bir tarmoq uchun post hali qoralama/ko'rib chiqishda/rejalashtirilgan bo'lganda ham reja qo'yiladi: «Saytga chiqqach» (0/15 daq/1 soat/3 soat/1 kun yoki o'zingiz, 0–10080 daqiqa) yoki avvalgi «Aniq vaqt» (faqat chop etilgan postda, o'zgarmagan). Tabda kutayotgan reja nuqtasi, post tahrirlagichining «Nashr» kartasida barcha tarmoq rejalari ro'yxati («LinkedIn · chiqqach 15 daq · kutmoqda») va «Tarqatishni ochish» tugmasi
- Post chop etilganda (qo'lda, tasdiqlash, scheduler, Telegram buyrug'i, konnektor) har bir reja «chop etilgan vaqt + N daqiqa»ga rejalashtiriladi, matn shu paytdagi tanlangan versiyadan olinadi va `schedule` bilan bir xil tekshiruvdan o'tadi; o'tmasa qator «Xato» (sababi ko'rinadi). Takroriy chop etishda ikki marta yuborilmaydi; chop etishdan chiqarilsa hali ketmaganlari qoralamaga qaytadi va reja saqlanadi
- Claude konnektori: `set_distribution_plan`, `clear_distribution_plan` (`social:post`); ro'yxat/holat javoblarida `planDelayMinutes`
- Telegram rejasi o'zgarmagan. Additiv migratsiya `0022`: `distributions.plan_delay_minutes`, `distributions.plan_materialized_at` (nullable)

**Tarqatish: nomli versiyalar (har bir tarmoq uchun, "asosiy" belgisi bilan)**
- LinkedIn, X, Threads, Instagram: har bir post+kanal uchun 10 tagacha nomli matn versiyasi, bittasi «Asosiy»; dialog asosiy versiyada ochiladi. Matn ustida versiyalar qatori («Standart» + versiyalar + «Yangi versiya»), nomini o'zgartirish, «Asosiy qilish», o'chirish; tahrir 800 ms dan keyin o'zi saqlanadi; oldindan ko'rish tahrirlagichni kuzatadi
- Claude konnektori: `list_distribution_versions`, `create_distribution_version`, `update_distribution_version`, `delete_distribution_version`, `set_distribution_primary` (`social:post`); `send_distribution`/`schedule_distribution` ixtiyoriy `version_id` qabul qiladi
- Yuborish yo'li o'zgarmagan (matn va tekshiruvlar avvalgidek); yangi `distribution_versions` jadvali va nullable `distributions.version_id` (additiv migratsiya `0021`, mavjud faol qo'lda matnlar «1-versiya» (asosiy) qilib ko'chiriladi)

**Tarqatish: har bir tarmoq uchun real vaqtli oldindan ko'rish**
- Dialogda LinkedIn, X, Threads, Instagram va GitHub README ko'rinishi (tahrirlagich yonida); matn har bir tugma bosilishida yangilanadi, URL/#hashtag/@mention bo'yaladi, "ko'proq" qisqartirish, chegaradan oshgan qism qizil bilan belgilanadi, Instagram'da rasm yo'qligi ogohlantiriladi
- Faqat veb: API, ma'lumotlar bazasi va yuborish xatti-harakati o'zgarmagan

**Claude konnektori — 1a bosqich (faqat o'qish), `MCP_ENABLED` orqasida**
- Masofaviy MCP server (`/mcp`) va OAuth 2.1 avtorizatsiya serveri (PKCE, dinamik ro'yxatdan o'tish, Client ID Metadata Document, refresh rotatsiyasi); server tomonda AI modeli yo'q
- 12 ta o'qish vositasi: postlar, post kontenti, teglar, izohlar, statistika, tarix, chiqindi qutisi, amallar jurnali, media, `whoami`
- Ruxsatlar (o'qish / yozish / chop etish / xavfli) va veb rozilik sahifasi (faqat admin); Admin → Ulangan ilovalar (to'liq bekor qilish)
- `better-auth` 1.7.7 → 1.7.28; yangi `jwks` va `oauth_*` jadvallari (additiv migratsiya `0015`)
- Qo'llanma: `docs/claude-connector.md`

**Postning asosiy videosi**
- Tayyor render ishini post sahifasida muqova o'rnida ko'rsatish: panelda "Asosiy video qilish", konnektorda `update_post` `main_video_job_id` (`posts:write`, `VIDEO_ENABLED`dan mustaqil); `VideoObject` JSON-LD
- Yangi nullable ustun `posts.main_video` (additiv migratsiya `0020`); asosiy video qilingan ish o'chirilmaydi

### English

**Docs: distribution status**
- LinkedIn, Threads, Instagram and GitHub README are verified on real accounts (2026-11); X, X threads and the "after the site goes live" plan are not yet exercised against a real account

**Distribution: X threads**
- Optional "Thread" for the X channel: the text is split on `---` lines and, if over 280, at sentence/word boundaries (never inside a URL or grapheme) into reply tweets; optional " 1/n" numbering (counted in the weight); at most 15 tweets. Default is one tweet (behaviour unchanged)
- Sending: tweet 1 (with the image), the rest as replies to the previous one; each posted id is saved, so after a failure a retry resumes from the remaining part and never re-posts earlier tweets; an ambiguous result becomes "needs checking". "Remove from platform" deletes every tweet in reverse order
- Web: thread and numbering toggles, a live chain of stacked tweets with a connector line and a "3 ta tvit · 2-si 291/280" counter. Claude: `x_thread` / `x_thread_numbering` (preview, save, send, schedule, set plan), `threadParts` in the output
- Additive migration `0023`: `distributions.x_thread`, `x_thread_numbering`, `thread_ids`. Not yet tried on a real X account (tests mock the network)

**Distribution: the Telegram tab is now useful**
- The dialog's Telegram tab shows the chosen version (mark, length, limits), the channel plan ("after the site goes live 15 min"), sent status and link, the Telegram preview of the chosen version, and an "open Telegram window" button (closes Tarqatish, opens the Telegram dialog). Web only: API, sending and Claude tools unchanged

**Distribution: "N minutes after the site goes live" plan (like the Telegram plan)**
- Per network, a plan can be set while the post is still a draft / in review / scheduled: "Saytga chiqqach" (0/15 min/1 h/3 h/1 day or custom, 0-10080 minutes) or the existing "Aniq vaqt" (published posts only, unchanged). A waiting-plan dot on the tab; the post editor's "Nashr" card lists every network plan ("LinkedIn · after 15 min · waiting") with an "open Tarqatish" button
- When the post is published (manual, approve, scheduler, Telegram command, connector) each plan is scheduled at "publish time + N minutes", the text comes from the selected version at that moment and goes through the same checks as `schedule`; if they fail the row becomes "Xato" with the reason. Republishing never sends twice; unpublishing returns not-yet-sent items to draft and keeps the plan
- Claude connector: `set_distribution_plan`, `clear_distribution_plan` (`social:post`); list/status output includes `planDelayMinutes`
- The Telegram plan is unchanged. Additive migration `0022`: `distributions.plan_delay_minutes`, `distributions.plan_materialized_at` (nullable)

**Distribution: named versions per network, with a "primary" mark**
- LinkedIn, X, Threads, Instagram: up to 10 named text versions per post + channel, one of them "Asosiy" (primary); the dialog opens on the primary one. A strip above the text ("Standart" + versions + "Yangi versiya"), rename, "Asosiy qilish", delete; edits autosave after 800 ms; the live preview keeps following the editor
- Claude connector: `list_distribution_versions`, `create_distribution_version`, `update_distribution_version`, `delete_distribution_version`, `set_distribution_primary` (`social:post`); `send_distribution`/`schedule_distribution` accept an optional `version_id`
- The send path is unchanged (text and checks as before); new `distribution_versions` table and nullable `distributions.version_id` (additive migration `0021`; existing active hand-edited texts are copied into a primary "1-versiya")

**Distribution: real-time per-network preview**
- The dialog shows LinkedIn, X, Threads, Instagram and GitHub README layouts next to the editor; text updates on every keystroke, URLs/#hashtags/@mentions are styled, "see more" collapse, text past the limit is highlighted in red, Instagram warns when no image is chosen
- Web only: API, database and sending behaviour unchanged

**Claude connector — stage 1a (read-only), behind `MCP_ENABLED`**
- Remote MCP server (`/mcp`) and OAuth 2.1 authorization server (PKCE, dynamic registration, Client ID Metadata Documents, refresh rotation); no AI model on the server
- 12 read tools: posts, post content, tags, comments, stats, history, trash, audit log, media, `whoami`
- Permissions (read / write / publish / dangerous) and a web consent page (admin only); Admin → Connected apps (full revocation)
- `better-auth` 1.7.7 → 1.7.28; new `jwks` and `oauth_*` tables (additive migration `0015`)
- Guide: `docs/claude-connector.md`

**Post main video**
- A finished render job can be shown instead of the cover on the post page: "Asosiy video qilish" in the panel, `update_post` `main_video_job_id` in the connector (`posts:write`, independent of `VIDEO_ENABLED`); `VideoObject` JSON-LD
- New nullable column `posts.main_video` (additive migration `0020`); a job used as the main video cannot be deleted

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

# Ijtimoiy tarqatish (distribution) — platforma provider'lari

[O'zbekcha](#ozbekcha) · [English](#english)

---

## O'zbekcha

### 1. Bu nima va nima EMAS

Bu hujjat `apps/api/src/lib/distribution/` ichidagi **tayyor qurilish bloklari**ni tasvirlaydi: har bir maqolani LinkedIn (shaxsiy profil — ustuvor), X, Threads, Instagram va GitHub profil README'ga ("so'nggi maqolalar" bloki) yuborish uchun provider modullari.

**Hozirgi PR hech narsani ishga tushirmaydi:** marshrut yo'q, migratsiya yo'q, UI yo'q, env o'zgaruvchi talab qilinmaydi, mavjud fayllarning xatti-harakati o'zgarmaydi. Modul hech kim import qilmaguncha ish vaqtida mavjud emas. Keyingi PR: ma'lumotlar bazasi jadvallari, akkauntni ulash ekranlari, rejalashtirish, admin UI va yordamchi (assistant) vositalari.

Qoidalar: AI model yo'q (matn deterministik shablon yoki chaqiruvchi bergan matn); har bir tashqi so'rov faqat qattiq yozilgan platforma hostiga, HTTPS orqali, inyeksiya qilinadigan `fetch` bilan; redirect kuzatilmaydi; token va ular bor javob tanalari hech qachon log qilinmaydi; testlar tarmoqqa chiqmaydi (barchasi mock).

### 2. Provider shartnomasi (qisqacha)

`types.ts` — `DistributionProvider`:

| Qism | Nima |
|---|---|
| `id`, `capabilities`, `limits` | kim, nima qila oladi (text/link/image/edit/delete; `nativeScheduling` doim `false` — rejalashtirish chaqiruvchida) |
| `auth` | `oauth_code` / `oauth_pkce` / `pasted_token`; `buildAuthorizationUrl`, `exchangeCode`, `refresh`, `connectWithToken` — sof funksiyalar, `fetch` inyeksiya qilinadi, `ConnectedAccount` qaytaradi (saqlash chaqiruvchida, `encryptSecret` bilan shifrlash tavsiya) |
| `tokenStatus(account, now)` | `ok` / `expiring` / `expired`, `canRefresh`, `refreshDue`, `remindAt`, `daysLeft` |
| `renderDefaultText`, `measureText` | deterministik shablon; uzunlik platforma sanagandek (X: URL=23, emoji=2; Threads: emoji=UTF-8 bayt) |
| `preflight` | `ChannelCheck[]` — Telegram preflight bilan AYNAN bir xil shakl (`ok`/`warn`/`error`, `value`, `limit`) |
| `publish` / `remove` | `{externalId, url}` qaytaradi |

Xatolar (`DistributionError.kind`): `auth_expired`, `permission_missing`, `rate_limited` (`retryAt`), `validation_rejected` (`platformMessage`), `duplicate_content`, `payment_required`, `transient`, **`outcome_unknown`**.

> **`outcome_unknown` qoidasi:** yaratish (create/publish) so'rovi timeout yoki uzilgan ulanish bilan tugasa, post platformada yaratilgan bo'lishi MUMKIN. Chaqiruvchi yaratishni ko'r-ko'rona **qayta urinmasligi** kerak (dublikat xavfi). Yaratish so'rovidagi 5xx ham shunday qabul qilinadi. Faqat `transient` va `rate_limited` (`retryAt`dan keyin) xavfsiz qayta uriniladi (`error.retryable`).

Telegram'ni ham shu shartnomada ifodalash mumkin: `preflight` — mavjud `ChannelCheck`, `text` — `captionHtml`, `externalId` — message id, `remove` — `deleteMessage`.

### 3. Har bir kanal nima qiladi

| Kanal | Nima yuboradi | O'chirish | Ulanish | Token |
|---|---|---|---|---|
| LinkedIn | Article post (sarlavha, tavsif, yuklangan muqova) yoki "matn + havola" | ha | OAuth (kod) | 60 kun, refresh YO'Q |
| X | Matn + havola, ixtiyoriy 1 rasm | ha | OAuth PKCE | ~2 soat + refresh (rotatsiya) |
| Threads | Matn + `link_attachment`; ixtiyoriy rasm | ha | OAuth (kod) | 60 kun, 24 soatdan keyin yangilanadi |
| Instagram | 1 ta rasm + caption (havola bosilmaydi) | yo'q (API qo'llamaydi) | OAuth (kod) | 60 kun, 24 soatdan keyin yangilanadi |
| GitHub | Profil README'dagi ikki marker orasini yangilaydi | — | yopishtirilgan token | siz tanlagan muddat |

GitHub: faqat `<!-- BLOG-POSTS:START -->` va `<!-- BLOG-POSTS:END -->` orasi almashtiriladi (Buffer darajasida — qolgan baytlar o'zgarmaydi). Markerlar yo'q bo'lsa, faqat so'ralsa (`createMarkersAt`) yaratiladi. `sha` ziddiyatida (409/422) fayl bir marta qayta o'qiladi.

### 4. Egasi nimani tayyorlaydi (qadamma-qadam)

Redirect URL uchun **vaqtinchalik yo'l**: `https://<API_ORIGIN>/distribution/callback/<provider>` (`linkedin`, `x`, `threads`, `instagram`). Aniq yo'lni keyingi (integratsiya) PR tasdiqlaydi — platformalarda URL ro'yxatdan o'tkazishni shundan keyin qiling.

**LinkedIn (shaxsiy profil — ustuvor)**
1. https://www.linkedin.com/developers/apps da ilova yarating (LinkedIn sahifasi talab qilinadi).
2. Products: "Share on LinkedIn" va "Sign In with LinkedIn using OpenID Connect" qo'shing (self-serve).
3. Auth: redirect URL qo'shing (HTTPS, mutlaq, `#`siz).
4. Client ID / Client Secret'ni oling.
5. Keyingi PR'dagi "Ulash" tugmasi orqali ruxsat bering (`openid profile w_member_social`).
6. **Har 60 kunda qayta ulash kerak**: dasturiy refresh faqat cheklangan hamkorlarga beriladi. Tizim tugashdan 10 kun oldin eslatadi (`remindAt`), 7 kun qolganda `expiring`.

**X**
1. Developer Console'da ilova yarating, to'lov kartasini ulang (pay-per-use).
2. User authentication: OAuth 2.0, scope'lar `tweet.read tweet.write users.read media.write offline.access`; callback URL qo'shing.
3. Client ID (konfidensial bo'lsa Client Secret) ni oling.
4. Narx: oddiy post $0.015, **URL'li post $0.200** (narx sahifasi, sana yo'q — Console'da tekshiring).

**Threads**
1. https://developers.facebook.com da ilova yarating, "Threads API" use case.
2. Ruxsatlar: `threads_basic`, `threads_content_publish`, `threads_delete`.
3. O'zingizni Threads tester sifatida qo'shing (Advanced Access'siz faqat tester'lar).
4. Redirect URL, Threads App ID/Secret.

**Instagram**
1. Akkaunt **Professional** (Business yoki Creator) bo'lishi shart.
2. Meta ilovada "Instagram API with Instagram Login"; ruxsatlar `instagram_business_basic`, `instagram_business_content_publish`.
3. O'zingizni ilova roliga/tester'ga qo'shing (Standard Access o'z akkauntingiz uchun yetarli; Advanced Access — App Review + Business Verification — boshqalar uchun).
4. Rasm: **ommaviy HTTPS JPEG URL**; nisbat 4:5 – 1.91:1; ≤ 8 MB. Captionda havola bosilmaydi.

**GitHub**
1. `github.com/<login>/<login>` (public) repo'sida README.md bo'lsin.
2. README'ga ikki marker qo'shing (yuqoridagi).
3. Settings → Developer settings → Fine-grained token: faqat shu repo, **Contents: Read and write**; muddatni tanlang va kalendarga yozing.

### 5. Token muddatlari

| Platforma | Access | Yangilash |
|---|---|---|
| LinkedIn | 60 kun | yo'q — qayta ulash |
| X | ~2 soat | refresh token bilan; har yangilashda YANGI refresh token saqlanishi shart |
| Threads / Instagram | 60 kun | 24 soatdan keyin, token amal qilayotgan bo'lsa; muddati o'tgan token qayta ulanadi |
| GitHub | 1–366 kun yoki cheksiz | qo'lda |

### 6. Narx va limitlar

X pullik (yuqorida). Qolganlari uchun hujjatlarda to'lov ko'rsatilmagan. Limitlar: LinkedIn a'zo uchun 150 so'rov/kun (UTC; `/rest/posts` uchun UNVERIFIED); Threads 250 post/24 soat; Instagram 100 post/24 soat (hujjat o'zi ziddiyatli: karusel 50); matn: LinkedIn 3000 (UNVERIFIED), X 280 vazn birligi, Threads 500, Instagram 2200 va ≤ 30 hashtag; GitHub README ≤ 1 MB, secondary limit (80 yaratuvchi so'rov/daq).

### 7. Shartlar (ToS) eslatmasi

LinkedIn API Terms of Use §3.1 (oxirgi tahrir 2022-12-13) taqiqlar ro'yxatida: *"Use the Content or the APIs to automate posting on the LinkedIn Services."* (https://www.linkedin.com/legal/l/api-terms-of-use). Bu bandning o'z profilingizga, o'z roziligingiz bilan post qilishga taalluqliligi hujjatda aniq yozilmagan — talqin UNVERIFIED, mas'uliyat egasida. **Integratsiya faqat egasi yoki uning yordamchisi aniq ishga tushirganda post qiladi; maqola chop etilganda avtomatik emas.** X Automation Rules to'liq matni tekshirilmadi (UNVERIFIED).

### 8. Hujjat manbalari (2026-11-25 da o'qilgan)

- LinkedIn: Posts API (ms.date 2026-05-07, updated 2026-05-13, versiya `li-lms-2026-11` → `Linkedin-Version: 202611`); Images API (2026-06-19 / 2026-06-24); Assets API "Upload the Image" (2023-08-01 / 2026-01-28); little text format (2025-02-25 / 2025-10-16); 3-legged OAuth (2025-11-10 / 2026-05-15); OIDC userinfo (2022-12-14 / 2024-08-08); Share on LinkedIn (2021-02-05 / 2023-12-14) — `learn.microsoft.com/en-us/linkedin/...`
- X: `docs.x.com` — oauth-2-0/user-access-token, posts/creation-of-a-post, posts/delete-post, users/get-my-user, media/upload-media, fundamentals/counting-characters, getting-started/pricing, fundamentals/response-codes-and-errors (sahifalarda sana ko'rsatilmagan).
- Threads: `developers.facebook.com/docs/threads/*` (posts, get-started/long-lived-tokens, troubleshooting, delete-posts) — sana yo'q; **joriy hostlar `threads.com` / `graph.threads.com`**, API prefiksi `/v1.0/`.
- Instagram: `developers.facebook.com/docs/instagram-platform/*` (business-login, content-publishing, ig-user/media v27.0, overview) — sana yo'q.
- GitHub: `docs.github.com/en/rest/repos/contents` va boshqalar, REST versiyasi `2026-03-10` (sana yo'q).

### 9. UNVERIFIED jadvali

| # | Platforma | Nima | Kodda |
|---|---|---|---|
| 1 | LinkedIn | `commentary` chegarasi 3000 va sanash birligi (hujjatda raqam yo'q) | `LINKEDIN_COMMENTARY_MAX` |
| 2 | LinkedIn | Article `title`/`description` chegaralari (400/4086 — konservativ) | `LINKEDIN_ARTICLE_*` |
| 3 | LinkedIn | Rasm fayl hajmi chegarasi (faqat < 36 152 320 piksel ma'lum); 8 MB dan oshsa `warn` | `LINKEDIN_IMAGE_WARN_BYTES` |
| 4 | LinkedIn | `w_member_social` token bilan `GET /rest/images` mumkin emas — yuklash holatini so'rab bo'lmaydi | `publish` |
| 5 | LinkedIn | `urn:li:share:` uchun `feed/update/{urn}/` havola shakli (hujjatda `ugcPost` misoli) | `linkedInPostUrl` |
| 6 | LinkedIn | 150 so'rov/kun `/rest/posts` uchun ham amal qiladimi | `LINKEDIN_DAILY_MEMBER_LIMIT` |
| 7 | LinkedIn | ToS §3.1 talqini; self-serve mahsulot narxi | `LINKEDIN_TERMS_CLAUSE` |
| 8 | X | `expires_in` token javobida (yo'q bo'lsa 7200 deb olinadi) | `X_DEFAULT_ACCESS_TTL_S` |
| 9 | X | Refresh token rotatsiyasi va muddati ("until you revoke") | `refresh` |
| 10 | X | 403 dublikat matni, 402 CreditsDepleted shakli (hujjatda yo'q) | `refine` |
| 11 | X | twitter-text vazn diapazonlari (hujjat faqat qoidani aytadi) | `xWeightedLength` |
| 12 | X | Rasm yuklashda `processing_info` uchraydimi; PKCE `S256` tavsiyasi | `publish` |
| 13 | X | Narx sahifasi sanasiz; Automation Rules to'liq matni | `X_PRICE_*` |
| 14 | Threads | Havola belgilari 500 limitga kiradimi | `threadsLength` |
| 15 | Threads | Xato kodlari 32, 613, 100 (hujjatda yo'q); `reply_control` | `graph.ts` |
| 16 | Threads | `permalink` maydoni; eski hostlar (`threads.net`) holati | `publish` |
| 17 | Instagram | `GET /me?fields=user_id,username` maydonlari | `exchangeCode` |
| 18 | Instagram | `permalink` maydoni; havolalar bosilmasligining rasmiy tasdig'i | `publish` |
| 19 | Instagram | 100 vs 50 post/kun ziddiyati; caption sanash birligi; xato kodlari | `INSTAGRAM_POSTS_PER_DAY` |
| 20 | GitHub | `github-authentication-token-expiration` sarlavhasi; xato tanasi `{message}` shakli | `parseExpiry` |
| 21 | GitHub | sha ziddiyatida 409 yoki 422 (ikkalasi ham qayta o'qishni boshlaydi); base64 `\n` | `publish` |
| 22 | GitHub | `GET /user` fine-grained token uchun; Workflows ruxsati kerak emasligi | `connectWithToken` |

---

## English

### 1. What this is (and is not)

Self-contained building blocks under `apps/api/src/lib/distribution/` to push each article to LinkedIn (personal profile, the priority), X, Threads, Instagram and the GitHub profile README ("latest articles" block). **Merging this PR changes nothing at runtime**: no routes, migrations, UI or required env vars, and no existing file's behaviour is touched. A follow-up PR adds the database tables, account-connection screens, scheduling, admin UI and assistant tools.

Hard rules: no AI model; every request goes only to a hard-coded platform host over HTTPS through an injectable `fetch`; redirects are never followed; tokens and token-bearing response bodies are never logged; tests mock all HTTP.

### 2. The contract in brief

`DistributionProvider` exposes `capabilities`, `limits`, `auth` (authorization URL builder with PKCE where applicable, `exchangeCode`, `refresh`, `connectWithToken` for GitHub, all returning a normalised `ConnectedAccount`; storage is the caller's job), `tokenStatus` (`ok`/`expiring`/`expired`, `canRefresh`, `refreshDue`, `remindAt`), `renderDefaultText`/`measureText` (counted the platform's way), `preflight` (returns the same `ChannelCheck` shape as the Telegram preflight), `publish` and `remove`. Native scheduling is `false` everywhere: scheduling is the caller's job.

Errors are a small taxonomy: `auth_expired`, `permission_missing`, `rate_limited` (with `retryAt`), `validation_rejected`, `duplicate_content`, `payment_required`, `transient` and `outcome_unknown`. **A timeout, dropped connection or 5xx during a create call yields `outcome_unknown`: the post may exist, so the caller must never blindly retry a create.**

### 3. Per channel

LinkedIn: article post with an uploaded thumbnail (Images API) or text + link; delete; 60-day token, no programmatic refresh, reconnect every 60 days (reminder 10 days before, `expiring` at 7). X: text + link, optional single image (`POST /2/media/upload`), delete, refresh-token rotation (always store the new refresh token), URL posts cost far more. Threads: container then publish with `link_attachment`, optional image, delete, 60-day token refreshable after 24 h. Instagram: single public HTTPS JPEG plus caption, container status polling with a bounded wait, links are not clickable, no delete via API. GitHub: replace only the block between two HTML-comment markers (byte-exact elsewhere), re-read once on a sha conflict, markers created only when asked.

### 4. Owner checklist

See the Uzbek section 4 for the step-by-step list per platform (developer app, products/permissions, redirect URL placeholder `https://<API_ORIGIN>/distribution/callback/<provider>` to be confirmed by the integration PR, review/payment needs, Instagram professional account, GitHub fine-grained token with Contents: write on the profile repo only).

### 5. Terms of service

LinkedIn API Terms of Use §3.1 (last revised 2022-12-13) lists: "Use the Content or the APIs to automate posting on the LinkedIn Services." Whether posting to your own profile on your explicit instruction falls under it is not spelled out (UNVERIFIED). The integration will only post when the owner or their assistant explicitly triggers it, never automatically on publish.

### 6. UNVERIFIED items

See the table in the Uzbek section 9; each item is also tagged `UNVERIFIED` next to the relevant constant in code.

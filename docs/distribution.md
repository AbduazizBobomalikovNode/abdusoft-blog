# Ijtimoiy tarqatish (distribution) — platforma provider'lari

[O'zbekcha](#ozbekcha) · [English](#english)

---

## O'zbekcha

### 1. Bu nima va nima EMAS

Bu hujjat `apps/api/src/lib/distribution/` ichidagi **tayyor qurilish bloklari**ni tasvirlaydi: har bir maqolani LinkedIn (shaxsiy profil — ustuvor), X, Threads, Instagram va GitHub profil README'ga ("so'nggi maqolalar" bloki) yuborish uchun provider modullari.

**(Tarixiy eslatma: provider PR'i hech narsani ishga tushirmagan; integratsiya — 10-bo'lim, `DISTRIBUTION_ENABLED` orqasida.)** Provider PR'i: marshrut yo'q, migratsiya yo'q, UI yo'q, env o'zgaruvchi talab qilinmaydi, mavjud fayllarning xatti-harakati o'zgarmaydi. Modul hech kim import qilmaguncha ish vaqtida mavjud emas. Keyingi PR: ma'lumotlar bazasi jadvallari, akkauntni ulash ekranlari, rejalashtirish, admin UI va yordamchi (assistant) vositalari.

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

Xatolar (`DistributionError.kind`): `auth_expired`, `permission_missing`, `rate_limited` (`retryAt`), `validation_rejected` (`platformMessage`), `duplicate_content`, `payment_required`, `transient`, **`outcome_unknown`**, `refresh_ambiguous`, `not_supported`. Ko'p bosqichli publish xatolarida ixtiyoriy `step` (`init`/`upload`/`media`/`container`/`poll`/`publish`) va `partial` (`imageUrn`, `mediaId`, `containerId` — faqat TAYYOR narsalar) bo'ladi.

> **`outcome_unknown` qoidasi:** yaratish (create/publish) so'rovi timeout, uzilgan ulanish, **javob tanasini o'qishdagi timeout**, 408 yoki istalgan 5xx bilan tugasa, post platformada yaratilgan bo'lishi MUMKIN. Bu qoida har qanday platforma xato xaritasidan USTUN (masalan Meta `{error:{code:2}}` HTTP 500 bilan kelsa ham `transient` emas, `outcome_unknown`). Chaqiruvchi yaratishni ko'r-ko'rona **qayta urinmasligi** kerak (dublikat xavfi). Faqat `transient` va `rate_limited` (`retryAt`dan keyin) xavfsiz qayta uriniladi (`error.retryable`). Yaratilmagan (konteyner, rasm yuklash) bosqichlardagi 5xx — `transient`.

> **Davom ettirish (`PublishInput.resume`):** xato `partial` bilan kelsa (LinkedIn `imageUrn`, X `mediaId`, Threads/Instagram `containerId`), uni `resume` ga berib qayta chaqirsangiz, provider ikkinchi rasm/konteyner yaratmaydi. `outcome_unknown` dan keyin davom ettirishdan oldin platformani qo'lda tekshiring; konteyner allaqachon `PUBLISHED` bo'lsa provider yana `outcome_unknown` qaytaradi va qayta chop etmaydi.

> **Token yangilash (X):** `auth.refresh` `{account, refreshTokenRotated}` qaytaradi. Chaqiruvchi qaytgan `account`ni YANGI access token'dan foydalanishdan OLDIN saqlashi shart (eski refresh token bekor bo'ladi). `refreshTokenRotated=false` — javobda yangi refresh token kelmadi, eskisi saqlandi (X hujjati rotatsiyani aniq aytmaydi — UNVERIFIED). Yangilash paytidagi timeout/uzilish/5xx — `refresh_ambiguous`: token almashtirilgan bo'lishi mumkin; keyingi yangilash ham xato bersa, akkauntni qayta ulang. Threads/Instagram yangilashi rotatsiyasiz (`refreshTokenRotated=false`).

> **URL xavfsizligi:** `publish` ichida `post.url` (har bir provider), `imageUrl` (Threads/Instagram) va GitHub README havolalari qat'iy tekshiriladi (https, userinfo/port yo'q, localhost/ichki/link-local IP yo'q, bo'shliq va yangi qator yo'q) va tahlil qilingan `href` dan foydalaniladi; aks holda `validation_rejected` (so'rov yuborilmaydi). Preflight'ga bog'liq emas.

> **OAuth state:** `oauth-state.ts` — `createOAuthState` (muddat bilan, ixtiyoriy PKCE verifier) va `verifyOAuthState` (doimiy vaqtli solishtirish, muddat, provider). Saqlash va bir martalik ishlatish (muvaffaqiyatli tekshiruvdan keyin yozuvni o'chirish) chaqiruvchining vazifasi.

`remove` har doim mavjud; platforma o'chira olmasa (`capabilities.delete=false`, sabab `capabilities.notes.delete`da) `not_supported` tashlaydi (Instagram, GitHub).

Telegram'ni ham shu shartnomada ifodalash mumkin: `preflight` — mavjud `ChannelCheck`, `text` — `captionHtml`, `externalId` — message id, `remove` — `deleteMessage`.

**LinkedIn matni:** hashtag'lar oddiy `#Teg` shaklida yuboriladi (Posts API sahifasi: `"commentary": "Follow best practices #coding"`; `{hashtag|\#|coding}` shabloni faqat GET javobida ko'rinadi), qolgan matndagi ajratilgan belgilar (`\ | { } @ [ ] ( ) < > # * _ ~`) backslash bilan escape qilinadi. Oddiy matndagi URL ham escape qilinadi (`_`, `~`, `(` oldidan `\`) — hujjat "barcha ajratilgan belgilar escape qilinsin" deydi; escape qilingan URL bosiladigan holda qolishi UNVERIFIED (birinchi jonli sinovda tekshiring; article varianti URL'ni `content.article.source`da escape'siz yuboradi).

### 3. Har bir kanal nima qiladi

| Kanal | Nima yuboradi | O'chirish | Ulanish | Token |
|---|---|---|---|---|
| LinkedIn | Article post (sarlavha, tavsif, yuklangan muqova) yoki "matn + havola" | ha | OAuth (kod) | 60 kun, refresh YO'Q |
| X | Matn + havola, ixtiyoriy 1 rasm | ha | OAuth PKCE | ~2 soat + refresh (rotatsiya) |
| Threads | Matn + `link_attachment`; ixtiyoriy rasm | ha | OAuth (kod) | 60 kun, 24 soatdan keyin yangilanadi |
| Instagram | 1 ta rasm + caption (havola bosilmaydi) | yo'q (API qo'llamaydi) | Facebook Login for Business (Unified Login, `config_id`) | tizim foydalanuvchisi tokeni: standart konfiguratsiyada muddatsiz; yangilanmaydi |
| GitHub | Profil README'dagi ikki marker orasini yangilaydi | — | yopishtirilgan token | siz tanlagan muddat |

GitHub: faqat `<!-- BLOG-POSTS:START -->` va `<!-- BLOG-POSTS:END -->` orasi almashtiriladi. Ish Buffer darajasida: **markerlardan tashqaridagi baytlar o'zgarmaydi**; markerlar ichidagi blok faylning o'z qator oxiri (LF yoki CRLF) bilan yoziladi; ro'yxat o'zgarmagan bo'lsa PUT yuborilmaydi. Markerlar yo'q bo'lsa, faqat so'ralsa (`createMarkersAt`) yaratiladi — bunda markerli blok qo'shiladi (mavjud baytlar o'zgarmaydi, lekin fayl uzayadi). `latestPosts` majburiy (bo'sh bo'lmagan ro'yxat), havolalar tahlil qilingan `href`dan quriladi. `sha` ziddiyatida (409/422) fayl bir marta qayta o'qiladi.

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

**Instagram** (Instagram API with Unified Login — eski "Instagram Login" oqimi yangi ilovalarga berilmaydi)
1. Akkaunt **Professional** (Creator yoki Business) bo'lishi shart; test foydalanuvchilar qo'llanmaydi.
2. developers.facebook.com'da ilova yarating: u **biznes portfeliga (business portfolio)** tegishli bo'lsin; use case: **"Manage messaging & content on Instagram"**.
3. Use case ichida **"API setup with Unified login"** → **Configure your app** → konfiguratsiya (configuration) yarating. Ruxsatlar: majburiy `instagram_basic` va `instagram_manage_messages`; post yuborish uchun `instagram_content_publish` (standart konfiguratsiyada bor). Konfiguratsiya **Config ID** beradi (maxfiy emas). Konfiguratsiyada "Instagram Login Compatible" yorlig'i bo'lishi kerak.
4. Konfiguratsiyaga **Redirect URL**'ni kiriting: `https://api.abdusoft.uz/admin/distribution/callback/instagram` (panelda nusxalash tugmasi bor) va saqlang.
5. **App roles** → akkauntingizni **Instagram Tester** sifatida taklif qiling va taklifni Instagram veb-saytida qabul qiling. Ilova Development rejimida qoladi (Standard Access app roli bor odamlar uchun yetarli; App Review kerak emas).
6. Settings → Basic'dan **Meta App ID** va **Meta App Secret**'ni oling (Instagram'ga xos id/secret endi YO'Q). Panelda Instagram kartasiga uchalasini kiriting: Meta App ID, Meta App Secret, Config ID → "Kalitlarni saqlash" → "Ulash" (yoki env: `DISTRIBUTION_INSTAGRAM_CLIENT_ID` = App ID, `DISTRIBUTION_INSTAGRAM_CLIENT_SECRET` = App Secret, `DISTRIBUTION_INSTAGRAM_CONFIG_ID`).
6a. Config ID faqat **raqamlardan** iborat (1–32 ta raqam); boshqacha qiymat saqlanmaydi ("Config ID faqat raqamlardan iborat bo'lishi kerak").
7. Loginda **aynan bitta** Instagram akkauntni tanlang: konfiguratsiya bir nechta akkauntga ruxsat bersa, ulanish rad etiladi (`multiple_instagram_accounts`; foydalanuvchi nomlari faqat jurnaldagi xavfsiz xabarda, URL'da emas). Birinchi muvaffaqiyatli ulanishdan keyin kartada akkaunt nomi va "Token muddatsiz" ko'rinadi.
8. Rasm: **ommaviy HTTPS JPEG URL**; nisbat 4:5 – 1.91:1; ≤ 8 MB. Captionda havola bosilmaydi.
9. **Webhook**: Meta hujjati webhook endpoint'ni "kerak" deb ro'yxatlaydi, lekin faqat xabar/izoh kabi hodisalarni QABUL QILISH uchun; ulanish va post yuborish uchun hujjatda webhook sharti yo'q. Bu integratsiya webhook qo'shmaydi (xabarlar — ko'lamdan tashqari).

**GitHub**
1. `github.com/<login>/<login>` (public) repo'sida README.md bo'lsin.
2. README'ga ikki marker qo'shing (yuqoridagi).
3. Settings → Developer settings → Fine-grained token: faqat shu repo, **Contents: Read and write**; muddatni tanlang va kalendarga yozing.

**Instagram ulanish xato kodlari** (URL'dagi `reason`; matn mijozdagi qat'iy jadvaldan):

| `reason` | Qachon | Matn (qisqacha) |
|---|---|---|
| `denied` | login bekor qilindi (`access_denied`/`user_denied`) | Platformada ruxsat berilmadi yoki bekor qilindi |
| `login_failed` | Meta login oynasi boshqa xato bilan tugadi | Meta App ID, Config ID va Redirect URL'ni tekshiring |
| `config_invalid` | Config ID noto'g'ri/o'chirilgan (Meta xabarida "config") | Konfiguratsiyani tekshiring |
| `exchange_failed` | kod -> token almashtirish xatosi | Client ID/Secret va redirect URL'ni tekshiring |
| `account_lookup_failed` | akkauntlarni o'qib bo'lmadi yoki id noto'g'ri shaklda | `instagram_basic` ruxsatini tekshiring |
| `no_instagram_account` | akkauntlar ro'yxati bo'sh | Akkauntni tanlang va Instagram Tester qiling |
| `multiple_instagram_accounts` | ro'yxatda 1 tadan ko'p akkaunt | Aynan bittasini tanlang va qaytadan ulang |

### 5. Token muddatlari

| Platforma | Access | Yangilash |
|---|---|---|
| LinkedIn | 60 kun | yo'q — qayta ulash |
| X | ~2 soat | refresh token bilan; har yangilashda YANGI refresh token saqlanishi shart |
| Threads | 60 kun | 24 soatdan keyin, token amal qilayotgan bo'lsa; muddati o'tgan token qayta ulanadi |
| Instagram (Unified Login) | Business Integration System User tokeni. Muddat konfiguratsiyaga bog'liq: standart konfiguratsiyada "Never" (javobda `expires_in` yo'q → saqlanmaydi, kartada "Token muddatsiz", eslatma yo'q); `expires_in` kelsa (masalan 60 kunlik konfiguratsiya) muddat saqlanadi | dasturiy yangilash YO'Q (token boshqaruvi API'si `business_management` + `client_business_id` talab qiladi — qo'llanmaydi): muddatdan 10 kun oldin eslatma, tugagach qayta ulash. Mijoz ilovani portfeldan olib tashlasa yoki akkauntni boshqa portfelga ko'chirsa token ishlamay qoladi → qayta ulang |
| GitHub | 1–366 kun yoki cheksiz | qo'lda |

### 6. Narx va limitlar

X pullik (yuqorida). Qolganlari uchun hujjatlarda to'lov ko'rsatilmagan. Limitlar: LinkedIn a'zo uchun 150 so'rov/kun (UTC; `/rest/posts` uchun UNVERIFIED); Threads 250 post/24 soat; Instagram 100 post/24 soat (hujjat o'zi ziddiyatli: karusel 50); matn: LinkedIn 3000 (UNVERIFIED), X 280 vazn birligi, Threads 500, Instagram 2200 va ≤ 30 hashtag; GitHub README ≤ 1 MB, secondary limit (80 yaratuvchi so'rov/daq).

### 7. Shartlar (ToS) eslatmasi

LinkedIn API Terms of Use §3.1 (oxirgi tahrir 2022-12-13) taqiqlar ro'yxatida: *"Use the Content or the APIs to automate posting on the LinkedIn Services."* (https://www.linkedin.com/legal/l/api-terms-of-use). Bu bandning o'z profilingizga, o'z roziligingiz bilan post qilishga taalluqliligi hujjatda aniq yozilmagan — talqin UNVERIFIED, mas'uliyat egasida. **Integratsiya faqat egasi yoki uning yordamchisi aniq ishga tushirganda post qiladi; maqola chop etilganda avtomatik emas.** X Automation Rules to'liq matni tekshirilmadi (UNVERIFIED).

### 8. Hujjat manbalari (2026-11-25 da o'qilgan)

- LinkedIn: Posts API (ms.date 2026-05-07, updated 2026-05-13, versiya `li-lms-2026-11` → `Linkedin-Version: 202611`); Images API (2026-06-19 / 2026-06-24); Assets API "Upload the Image" (2023-08-01 / 2026-01-28); little text format (2025-02-25 / 2025-10-16); 3-legged OAuth (2025-11-10 / 2026-05-15); OIDC userinfo (2022-12-14 / 2024-08-08); Share on LinkedIn (2021-02-05 / 2023-12-14) — `learn.microsoft.com/en-us/linkedin/...`
- X: `docs.x.com` — oauth-2-0/user-access-token, posts/creation-of-a-post, posts/delete-post, users/get-my-user, media/upload-media, fundamentals/counting-characters, getting-started/pricing, fundamentals/response-codes-and-errors (sahifalarda sana ko'rsatilmagan).
- Threads: `developers.facebook.com/docs/threads/*` (posts, get-started/long-lived-tokens, troubleshooting, delete-posts) — sana yo'q; **joriy hostlar `threads.com` / `graph.threads.com`**, API prefiksi `/v1.0/`.
- Instagram (Unified Login, 2026-11-26 da o'qilgan, sanasiz): `developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/{get-started, authentication, migration, permissions}`, `.../content-publishing`, `.../facebook-login/facebook-login-for-business`, `developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow`. O'qib bo'lmaganlar (skriptli sahifa, bo'sh qaytdi): `ig-user/media`, `ig-user/content_publishing_limit`, `ig-media` reference sahifalari.
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
| 17 | Instagram | `assigned_instagram_accounts` javobining `data[]` shakli (hujjat faqat so'rovni ko'rsatadi); bir nechta akkaunt bo'lsa ulanish RAD ETILADI (`multiple_instagram_accounts`, hech narsa saqlanmaydi); `client_business_id` javob maydoni | `exchangeCode` |
| 18 | Instagram | `permalink` maydoni; havolalar bosilmasligining rasmiy tasdig'i | `publish` |
| 19 | Instagram | 100 vs 50 post/kun ziddiyati; caption sanash birligi; xato kodlari | `INSTAGRAM_POSTS_PER_DAY` |
| 22 | Instagram | Dialog `state`'ni `config_id` bilan ham qaytaradimi (umumiy Facebook Login hujjati: ha; Unified Login sahifasi aytmaydi) | `buildAuthorizationUrl` |
| 23 | Instagram | Kod almashtirishda `redirect_uri`: Unified Login sahifasi ro'yxatda ko'rsatmaydi, qo'lda login hujjati "majburiy" deydi — standart YUBORILADI (`exchangeRedirectUri`) | `exchangeCode` |
| 27 | Instagram | Meta id'lari (akkaunt, konteyner, post) faqat raqam deb olingan (≤ 32) va URL yo'liga qo'yilishidan oldin tekshiriladi; Meta uzun/harfli id qaytarsa ulanish yoki yuborish to'xtaydi (post id'si `media_publish`dan keyin yaroqsiz bo'lsa `outcome_unknown` — qayta urinilmaydi) | `isGraphId` |
| 24 | Instagram | Bekor qilish: `error=access_denied`, `error_reason=user_denied` (qo'lda login hujjati); noto'g'ri `config_id` da Meta xatosi qanday qaytishi (matnda "config" bo'lsa `config_invalid`) | `completeConnect`, `withConfigReason` |
| 25 | Instagram | Token boshqaruvi API'si (yangilash/uzaytirish) ishlatilmaydi; 60 kunlik konfiguratsiyada token tugagach qayta ulash | `INSTAGRAM_TOKEN_POLICY` |
| 26 | Instagram | Caption limiti (2200/30/20), rasm hajmi/nisbati, `permalink`, o'chirishning yo'qligi — yangi hujjatda aytilmagan (eski reference'dan); `content_publishing_limit` endpoint'i mavjud, lekin ishlatilmaydi | `INSTAGRAM_CAPTION_MAX`, `publish` |
| 20 | GitHub | `github-authentication-token-expiration` sarlavhasi; xato tanasi `{message}` shakli | `parseExpiry` |
| 21 | GitHub | sha ziddiyatida 409 yoki 422 (ikkalasi ham qayta o'qishni boshlaydi); base64 `\n` | `publish` |
| 22 | GitHub | `GET /user` fine-grained token uchun; Workflows ruxsati kerak emasligi | `connectWithToken` |
| 23 | LinkedIn | Hashtag'lar oddiy `#Teg` sifatida havolaga aylanishi; escape qilingan URL bosiladigan qolishi | `escapeCommentary` |
| 24 | LinkedIn | Yuklash URL'i `https://www.linkedin.com/dms-uploads/...` (hujjat misoli); haqiqiy URL boshqa bo'lsa PUT rad etiladi | `LINKEDIN_UPLOAD_*` |
| 25 | X | Yangilash javobida refresh token bo'lmasa eskisini saqlash to'g'rimi (hujjat aytmaydi) | `refresh` |
| 26 | Barchasi | Javob hajmi chegarasi 4 MiB (GitHub README ≤ 1 MB base64 bilan sig'adi) | `DEFAULT_MAX_RESPONSE_BYTES` |

---

### 10. Integratsiya (admin panel, scheduler, vositalar) — `DISTRIBUTION_ENABLED`

Bu bo'lim yuqoridagi provider bloklari ulangan holatni tasvirlaydi. **Hammasi `DISTRIBUTION_ENABLED=true` orqasida (standart: o'chiq).** O'chiq bo'lsa: yangi marshrut javob bermaydi (404), scheduler hech narsa qilmaydi, admin panelda "Tarqatish" yorlig'i/tugmasi yo'q, konnektorda yangi vosita yo'q, Telegram avvalgidek ishlaydi. Telegram bu PR'da ko'chirilmagan — kanallar ro'yxatida faqat ko'rsatiladi.

**Avtomatik yuborish YO'Q.** Maqola chop etilganda hech narsa yuborilmaydi. Tarqatish faqat egasi (panel) yoki uning yordamchisi (vosita) AYNAN shu post va AYNAN shu kanal uchun "Yuborish"/"Rejalashtirish"ni bosganda boshlanadi. LinkedIn API shartlari (§3.1 "automate posting") shuni talab qiladi — UI va hujjatda ko'rinib turadi.

**Redirect URL'lar** (platforma ilovasida AYNAN shuni kiriting; `API_ORIGIN` ostida, barqaror):

| Platforma | Redirect URL |
|---|---|
| LinkedIn | `<API_ORIGIN>/admin/distribution/callback/linkedin` |
| X | `<API_ORIGIN>/admin/distribution/callback/x` |
| Threads | `<API_ORIGIN>/admin/distribution/callback/threads` |
| Instagram | `<API_ORIGIN>/admin/distribution/callback/instagram` |
| GitHub | yo'q (token yopishtiriladi) |

Aniq URL Sozlamalar → Tarqatish yorlig'ida nusxalash tugmasi bilan ko'rinadi. Callback faqat admin sessiyasi bilan ishlaydi; `state` (+ X uchun PKCE) serverda saqlanadi, 10 daqiqa amal qiladi va bir marta ishlatiladi.

**Egasi uchun qadamlar (har platforma):** 1) Platformada ilova yarating (4-bo'lim). 2) Redirect URL'ni kiriting. 3) Sozlamalar → Tarqatish → Client ID/Secret ni saqlang (yoki `DISTRIBUTION_<PLATFORMA>_CLIENT_ID/_SECRET` env; env DB'dan ustun). 4) "Ulash" → platformada ruxsat bering. 5) Postni oching → "Tarqatish" → matn/rasmni ko'ring → "Yuborish". GitHub: README'ga ikki marker qo'shing, fine-grained tokenni yopishtiring (muddatini kalendarga yozing).

**Holatlar:** `draft` (qoralama) · `scheduled` (rejalashtirilgan yoki navbatda; qayta urinish kutayotgan ham shu) · `sending` (fonda yuborilmoqda) · `sent` (yuborilgan, havola bor) · `failed` (xato; odam qayta urinadi) · `needs_checking` (natija noma'lum) · `cancelled` (bekor qilingan yoki platformadan olib tashlangan). Bir post+kanal uchun bitta faol tarqatish (DB indeksi).

**Qayta urinish:** faqat `transient` va `rate_limited` avtomatik: ko'pi bilan 5 urinish; kutish 1 daq → 5 daq → 15 daq → 1 soat (`rate_limited` da platforma bergan vaqt, 1 daq..6 soat oralig'ida). Qisman bajarilgan bosqich (`partial`: LinkedIn rasm URN, X media id, Threads/Instagram konteyner) saqlanadi va qayta urinishda davom ettiriladi. Qolgan xatolar (`auth_expired`, `permission_missing`, `validation_rejected`, `duplicate_content`, `payment_required`) darhol `failed`. `outcome_unknown` HECH QACHON avtomatik qayta urinilmaydi.

**"Tekshirish kerak" qanday hal qilinadi:** platformada postni qidiring, so'ng panelda: (a) chiqqan bo'lsa — post havolasi bilan "Yuborilgan deb belgilash"; (b) chiqmagan bo'lsa — "Platformada yo'q — yopish" yoki dublikat xavfini tasdiqlab "Bilib turib qayta urinish". Yordamchi (vosita) buni hal qila olmaydi. Server `sending` paytida to'xtab qolsa (crash/deploy) ham shu holatga o'tadi.

**Deploy paytida `needs_checking` nimani anglatadi:** ishga tushganda faqat **20 daqiqadan beri `sending`da turgan** (ESKIRGAN) qatorlar `needs_checking`ga o'tkaziladi — xuddi har daqiqalik tick'dagi qoida. Deploy kesishuvida eski jarayon hali yuborishni tugatayotgan bo'lishi mumkin: uning qatoriga tegilmaydi va u natijani (platforma id + havola) o'zi yozadi. Agar qator allaqachon `needs_checking`ga o'tkazilgan bo'lsa-yu eski jarayon keyin muvaffaqiyatli tugatsa, natija baribir yoziladi (faqat tiklash belgisi turgan, o'sha urinishning qatoriga; siz qo'lda hal qilgan qatorga tegilmaydi) va jurnalda `recordedAfterRecovery` belgisi bo'ladi. Yo'nalish xavfsiz: `sending` yoki `needs_checking` qator hech qachon avtomatik qayta yuborilmaydi — ikkinchi post chiqmaydi. O'lgan jarayonning qatori 20 daqiqadan keyin `needs_checking` bo'ladi: platformada tekshiring (yuqoridagi (a)/(b)).

**Kech natijalar va urinishlar:** har bir urinish (claim) o'z belgisiga ega (qatorning `updatedAt`i — yangi ustun/migratsiya yo'q); natija (muvaffaqiyat ham, xato ham) faqat shu belgi hamon o'sha urinishniki bo'lsa yoziladi. Shuning uchun eski urinishning kech natijasi (eski jarayon tiklanishdan keyin ham tirik qolgan, egasi esa bilib turib qayta uringan) YANGI, hali davom etayotgan urinishning ustiga yozilmaydi. Egasi qatorni «platformada yo'q» deb yopib qo'ygan bo'lsa-yu platforma keyin baribir post chop etilganini xabar qilsa — egasining qarori saqlanadi (qator `cancelled` bo'lib qoladi), lekin jurnalga `distribution.late_result` yozuvi (post havolasi bilan) tushadi va egasiga Telegram bildirishnomasi ketadi, shunda platformadagi post jimgina yo'qolmaydi: uni platformada tekshiring.

**Rasm:** standart — muqova, bo'lmasa saytning o'zi yaratgan OG rasmi (`<WEB_ORIGIN>/<slug>/opengraph-image-<hash>`, faqat blogning o'z veb-originidan). Mavjud rasm quvuri bilan JPEG, uzun tomon ≤1440 px, nisbat 4:5–1.91:1 (markazdan kesiladi). LinkedIn/X uchun baytlar; Threads/Instagram uchun blogning o'z media saqlashidagi (R2 yoki `API_ORIGIN/uploads`) OMMAVIY HTTPS JPEG URL — post bo'yicha keshlanadi. Rasm tayyorlanmasa tekshiruvda ko'rinadi (Instagram/LinkedIn maqola kartasi uchun xato, qolganlarida ogohlantirish).

**Token xizmati (har daqiqalik tick):** X va Threads tokenlari muddatidan oldin yangilanadi (yangi akkaunt yuborishdan OLDIN bazaga yoziladi; `refresh_ambiguous` — eski tokenlar saqlanadi, keyingi urinish ham xato bersa "qayta ulash kerak"). LinkedIn (60 kun), Instagram (faqat muddati bor bo'lsa; muddatsiz token eslatma ham, yangilash ham talab qilmaydi) va GitHub tokenlari yangilanmaydi: muddatdan 10 (GitHub 14) kun oldin boshlab admin Telegram chatiga kuniga ko'pi bilan BITTA eslatma, muddat tugaganda bitta "tugadi" xabari va akkaunt "qayta ulash kerak" holatiga o'tadi. Telegram sozlanmagan bo'lsa eslatma yetkazib bo'lmaydi: bu jurnalga yoziladi (`distribution.reminder_undelivered`) va ertasi kuni qayta uriniladi (har daqiqada emas).

**`BETTER_AUTH_SECRET` almashtirilsa:** tokenlar va Client Secret shu kalitdan olingan kalit bilan shifrlangan. Kalit almashgach ular deshifrlanmaydi. Tizim buni **"qayta ulash kerak"** deb ko'rsatadi ("faol" emas): Sozlamalar'da akkaunt "qayta ulash kerak", kanal "tayyor emas" (sabab: "Saqlangan token o'qib bo'lmadi (maxfiy kalit o'zgargan) — qayta ulang"), tekshiruvda xato, yuborish/olib tashlash platformaga **hech qanday so'rovsiz** rad etiladi (bo'sh bearer token hech qachon yuborilmaydi), token xizmati yangilashga urinmaydi va egasiga BITTA Telegram xabari yuboradi. Saqlangan Client Secret o'qilmasa, ilova sozlanmagan hisoblanadi (X, sirsiz ham ishlay oladigan public client bo'lsa-da) va Sozlamalar'da bu ko'rinadi. Tuzatish: Client Secret'ni qaytadan kiriting va akkauntni qayta ulang. (Kalitni almashtirmaslik eng yaxshisi; almashtirsangiz, barcha ulangan akkauntlar qayta ulanadi.)

**Rejalashtirilgan yuborish — akkaunt va matn "muzlatiladi":** rejalashtirishda (va "Yuborish"da) tizim ikki narsani saqlaydi: ko'rsatilgan (render qilingan) matn va akkauntning platformadagi id'si. Yuborish vaqtida (1) **boshqa akkaunt** ulangan bo'lsa (masalan LinkedIn'ga boshqa profil) tarqatish `failed` bo'ladi ("Rejalashtirilgandan keyin bu kanalga BOSHQA akkaunt ulangan…"), yangi akkauntga post chiqmaydi — bekor qilib, qaytadan rejalashtiring; **xuddi shu akkauntni** qayta ulash (token yangilash, uzib-ulash) muammo emas; (2) qo'lda tahrirlanmagan tarqatish ham postning keyingi tahriridan qayta hisoblangan matnni emas, **rejalashtirish paytida oldindan ko'rsatilgan matnni** yuboradi (rejalashtirilgan tarqatishning matnini saqlash uni yangilaydi). GitHub bloki bundan mustasno: u har safar so'nggi postlardan qayta yig'iladi.

**Qayta urinishda qaysi matn yuboriladi:** egasi boshlagan har bir yuborish/rejalashtirish/**qayta urinish** (shu jumladan «hal qilish → bilib turib qayta urinish») aynan o'sha paytda oldindan ko'rishda ko'rinib turgan matnni yuboradi — saqlangan qo'lda tahrir bilan birga. Ya'ni xatodan keyin matnni tahrirlab saqlasangiz yoki postning sarlavhasini o'zgartirsangiz, «Qayta urinish» eski (rejalashtirish paytidagi) matnni emas, hozir ko'ringan matnni yuboradi: tizim qayta urinishda matnni qayta muzlatadi. **Avtomatik** qayta urinish (`transient`/`rate_limited`) bundan mustasno: u allaqachon muzlatilgan matnni saqlaydi, chunki hech kim uni ko'rib tasdiqlamagan. GitHub bloki doim qayta yig'iladi.

**Savatdagi post:** postni savatga olsangiz ham, "Tarqatish" dialogi Postlar → Savat ro'yxatidan ochiladi. Barcha qatorlar faqat ko'rinadi (qoralama, rejalashtirilgan, tekshirish kerak, yuborilgan): rejalashtirilganni «Bekor qilish» mumkin (savatdagi post baribir yuborilmaydi), «tekshirish kerak»ni mavjud usulda hal qilish mumkin («yuborilgan deb belgilash» yoki «platformada yo'q»; qayta urinish yo'q) va yuborilganlar (platforma qo'llasa) platformadan olib tashlanadi; yangi yuborish/rejalashtirish yo'q. Postni savatdan butunlay o'chirsangiz tarqatish yozuvlari ham o'chadi: agar post platformaga yuborilgan bo'lsa, tasdiq oynasida tarmoqlar ro'yxati bilan ogohlantirish chiqadi — o'chirgandan keyin ularni panel orqali platformadan olib tashlab bo'lmaydi (o'chirishning o'zi mumkin bo'lib qoladi). Avval «Tarqatish» orqali olib tashlang. (Konnektorning `purge_post` vositasi bu ogohlantirishni ko'rsatmaydi.)

**Nosozlik (bayroq yoqilganda API ishga tushmasa):** `DISTRIBUTION_ENABLED=true` bo'lganda tarqatish modullari (`routes/admin-distribution`, `mcp/tools/distribution-tools`) ishga tushishda import qilinadi; import yiqilsa API ATAYIN ishga tushmaydi (deploy'dagi health check avtomatik orqaga qaytaradi). Sababni jurnaldan toping: `[distribution] DISTRIBUTION_ENABLED=true, lekin "<modul>" modulini yuklab bo'lmadi: <sabab>` qatori. Shoshilinch tuzatish — `DISTRIBUTION_ENABLED=false` (bu qism umuman yuklanmaydi, sayt avvalgidek ishlaydi).

**Tick xatolari:** har bir tarqatish va har bir akkaunt o'z xatolarini alohida ushlaydi — bitta yozuvdagi baza xatosi qolganlarini to'xtatmaydi.

**Narx va limit:** X pullik (pay-per-use, 6-bo'lim); qolganlari hujjatda pul ko'rsatilmagan. Konnektor orqali ijtimoiy yuborish (yuborish/rejalashtirish/qayta urinish) **o'z chegarasiga** kiradi: `MCP_WRITE_LIMIT_SOCIAL_SENDS_PER_DAY` (standart **5**/kun, har bir ulanish uchun; `0` — chegarasiz) — Telegram kanalining `MCP_WRITE_LIMIT_CHANNEL_SENDS_PER_DAY` (10) chegarasidan alohida. Platformadan olib tashlash — `MCP_WRITE_LIMIT_DESTRUCTIVE_PER_DAY`, matnni saqlash/bekor qilish — tahrir chegarasi. Konnektor uchun alohida ruxsat: **`social:post`** ("Ijtimoiy tarmoqlarga post chiqarish", Chop etish guruhida) — 11-bo'lim.

**Marshrutlar (admin, `/admin/distribution/...`):** `GET|PUT /settings`, `POST /accounts/:provider/connect`, `POST /accounts/github/token`, `DELETE /accounts/:provider`, `GET /callback/:provider`, `GET /channels`, `GET /posts/:postId`, `POST /posts/:postId/:provider/preview`, `PUT .../draft`, `POST .../send`, `POST .../schedule`, `GET /items/:id`, `POST /items/:id/{cancel,retry,resolve,remove}`. Hammasi faqat admin (xodim 403). Hech bir javob/jurnal/vositada token yoki client secret yo'q.

**Hali haqiqiy akkaunt bilan TEKSHIRILMAGAN** (birinchi ulanishdan keyin tekshiriladi): 9-bo'limdagi barcha `UNVERIFIED` bandlar; LinkedIn `/rest/posts` limiti va §3.1 talqini; X refresh token rotatsiyasi va `expires_in`; Threads `permalink`/`user_id` va Instagram konteyner holati/`permalink`, Unified Login birinchi ulanishi (22–26-bandlar); GitHub token muddati sarlavhasi; Instagram/Threads Meta ilova tasdig'i (tester roli, Instagram Tester taklifi); OG rasm marshrut hash'i prod'da; Telegram eslatma matnlari.

### 11. Konnektor (Claude) ruxsati: `social:post`

Ijtimoiy yuborish vositalari (`send_distribution`, `schedule_distribution`, `retry_distribution`, `cancel_distribution`, `save_distribution_text`, `remove_distribution_from_platform`) endi Telegram'ning `channels:send` ruxsatini **emas**, alohida **`social:post`** ruxsatini talab qiladi (rozilik sahifasida: **Ijtimoiy tarmoqlarga post chiqarish** — LinkedIn, X, Threads, Instagram'da ommaviy post chiqarish va o'chirish). Sabab: faqat o'z Telegram kanalingiz uchun tasdiqlangan ulanish ijtimoiy tarmoqlarda ommaviy post chiqara olmasligi kerak.

- Faqat **`MCP_WRITE_TOOLS_ENABLED=true` VA `DISTRIBUTION_ENABLED=true`** bo'lganda beriladi/e'lon qilinadi. Bayroq o'chiq bo'lsa ruxsat umuman yo'q: rozilik sahifasi, `scopes_supported` va `tools/list` avvalgidek.
- Rozilik sahifasida **hech qachon oldindan belgilanmaydi**; yangi ruxsat bo'lgani uchun avval faqat Telegram'ga rozilik bergan ulanish uni so'rasa, rozilik sahifasi **qayta** chiqadi.
- O'qish vositalari (`list_distribution_channels`, `preview_distribution`, `list_post_distributions`, `get_distribution_status`) `blog:read` bilan qoladi.
- Yuborish chegarasi: `MCP_WRITE_LIMIT_SOCIAL_SENDS_PER_DAY` (standart 5/kun).
- Mavjud ulanishlar (`channels:send` bilan) ijtimoiy vositalardan foydalana olmaydi: qayta ulang va yangi ruxsatni belgilang.

---

## English

### 1. What this is (and is not)

Self-contained building blocks under `apps/api/src/lib/distribution/` to push each article to LinkedIn (personal profile, the priority), X, Threads, Instagram and the GitHub profile README ("latest articles" block). **Merging this PR changes nothing at runtime**: no routes, migrations, UI or required env vars, and no existing file's behaviour is touched. A follow-up PR adds the database tables, account-connection screens, scheduling, admin UI and assistant tools.

Hard rules: no AI model; every request goes only to a hard-coded platform host over HTTPS through an injectable `fetch`; redirects are never followed; tokens and token-bearing response bodies are never logged; tests mock all HTTP.

### 2. The contract in brief

`DistributionProvider` exposes `capabilities`, `limits`, `auth` (authorization URL builder with PKCE where applicable, `exchangeCode`, `refresh`, `connectWithToken` for GitHub, all returning a normalised `ConnectedAccount`; storage is the caller's job), `tokenStatus` (`ok`/`expiring`/`expired`, `canRefresh`, `refreshDue`, `remindAt`), `renderDefaultText`/`measureText` (counted the platform's way), `preflight` (returns the same `ChannelCheck` shape as the Telegram preflight), `publish` and `remove`. Native scheduling is `false` everywhere: scheduling is the caller's job.

Errors are a small taxonomy: `auth_expired`, `permission_missing`, `rate_limited` (with `retryAt`), `validation_rejected`, `duplicate_content`, `payment_required`, `transient` and `outcome_unknown`. **A timeout, dropped connection or 5xx during a create call yields `outcome_unknown`: the post may exist, so the caller must never blindly retry a create.**

### 3. Per channel

LinkedIn: article post with an uploaded thumbnail (Images API) or text + link; delete; 60-day token, no programmatic refresh, reconnect every 60 days (reminder 10 days before, `expiring` at 7). X: text + link, optional single image (`POST /2/media/upload`), delete, refresh-token rotation (always store the new refresh token), URL posts cost far more. Threads: container then publish with `link_attachment`, optional image, delete, 60-day token refreshable after 24 h. Instagram (Unified Login: Facebook Login for Business dialog with `config_id`, `graph.facebook.com`, requests against the Instagram account id, system-user token): single public HTTPS JPEG plus caption, container status polling with a bounded wait, links are not clickable, no delete via API. GitHub: replace only the block between two HTML-comment markers (byte-exact elsewhere), re-read once on a sha conflict, markers created only when asked.

Hardening notes: a 5xx, 408, timeout or body-read timeout on a create call is always `outcome_unknown` and takes precedence over any provider-specific mapping (e.g. a Meta `{error:{code:2}}` returned with HTTP 500). Multi-step failures carry `step` and `partial` (`imageUrn`, `mediaId`, `containerId`) and `PublishInput.resume` lets the caller continue without creating a second image/container. X refresh returns `{account, refreshTokenRotated}`; persist the returned account BEFORE using the new access token; a timeout/5xx during refresh is `refresh_ambiguous` (the token may already have rotated; if the next refresh fails, reconnect). `remove` throws `not_supported` where the platform cannot delete (Instagram, GitHub). All URLs are validated inside `publish` (https, no userinfo/port, no private/loopback/link-local hosts, no whitespace or newlines). LinkedIn hashtags are sent as plain `#Tag`; other reserved characters are escaped (live behaviour UNVERIFIED). GitHub's README block is replaced at the byte level: bytes outside the markers are unchanged, the block uses the file's own line endings, and `latestPosts` is required.

Limits: LinkedIn 150 requests/member/day (UTC; UNVERIFIED for `/rest/posts`); Threads 250 posts/24 h; Instagram 100 API posts/24 h, although the docs contradict themselves (the carousel section says 50), so treat 50 as the safe figure until the first live check; X is pay-per-use with a much higher price for posts containing a URL; text limits: LinkedIn 3000 (UNVERIFIED), X 280 weighted units, Threads 500 (emoji count as UTF-8 bytes), Instagram 2200 characters and at most 30 hashtags; GitHub README up to 1 MB plus secondary limits (80 content-creating requests/min).

### 4. Owner checklist

See the Uzbek section 4 for the step-by-step list per platform (developer app, products/permissions, redirect URL placeholder `https://<API_ORIGIN>/distribution/callback/<provider>` to be confirmed by the integration PR, review/payment needs, Instagram: Meta app in a business portfolio with the "Manage messaging & content on Instagram" use case, "API setup with Unified login" configuration (gives the Config ID; permissions `instagram_basic`, `instagram_manage_messages`, `instagram_content_publish`), Redirect URL `https://api.abdusoft.uz/admin/distribution/callback/instagram`, Instagram Tester invitation accepted, then enter Meta App ID / Meta App Secret / Config ID in the card (or `DISTRIBUTION_INSTAGRAM_CLIENT_ID` / `_CLIENT_SECRET` / `_CONFIG_ID`); GitHub fine-grained token with Contents: write on the profile repo only).

### 5. Terms of service

LinkedIn API Terms of Use §3.1 (last revised 2022-12-13) lists: "Use the Content or the APIs to automate posting on the LinkedIn Services." Whether posting to your own profile on your explicit instruction falls under it is not spelled out (UNVERIFIED). The integration will only post when the owner or their assistant explicitly triggers it, never automatically on publish.

### 4b. Instagram connection errors

Reason codes in the callback URL (texts are a fixed client table; unknown codes are ignored): `denied` (cancelled), `login_failed`, `config_invalid`, `exchange_failed`, `account_lookup_failed` (also a non-numeric account id), `no_instagram_account` (empty list), `multiple_instagram_accounts` (more than one account returned: the connection is refused and nothing is stored; select exactly one account in the login dialog/configuration; usernames appear only in the audit entry). The Config ID must be digits only (1-32); a stored non-digit value reads as "not configured". Meta ids (account, container, post) must be digits only (up to 32) before they are put in a URL path; a bad post id after `media_publish` is `outcome_unknown` (the post may exist, never retried).

### 5b. Token lifetimes

| Channel | Lifetime | Renewal |
|---|---|---|
| LinkedIn | 60 days | none — reconnect |
| X | ~2 hours | rotating refresh token |
| Threads | 60 days | refresh after 24 h |
| Instagram (Unified Login) | Business Integration System User token; depends on the configuration — default "Never": no `expires_in` in the response, so nothing is stored, the card says "Token muddatsiz" and no reminder is sent. If `expires_in` is present, the expiry is stored | none (the token management API needs `business_management` and is not used): reminder 10 days before, reconnect after expiry; also reconnect if the client removes the app from the portfolio or moves the account |
| GitHub | 1-366 days or none | manual |

### 6. UNVERIFIED items

See the table in the Uzbek section 9 (Instagram Unified Login items 17, 22-26: `state` echo with `config_id`, `redirect_uri` at code exchange, cancel/wrong-config error shape, no refresh, publishing limits/permalink not in the new docs); each item is also tagged `UNVERIFIED` next to the relevant constant in code.

### 7. Integration (admin panel, scheduler, tools) — `DISTRIBUTION_ENABLED`

Everything below is behind `DISTRIBUTION_ENABLED=true` (default off). Off: no new route answers (404), no scheduler work, no UI entry point, no new connector tool, Telegram unchanged. Telegram is NOT migrated; it is only shown read-only in the channel list.

**Nothing is ever posted automatically on publish.** A distribution starts only when the owner (panel) or their assistant (tool) explicitly sends or schedules that post to that channel - as the LinkedIn API terms (§3.1, "automate posting") require.

**Redirect URLs** (register exactly these; stable): `<API_ORIGIN>/admin/distribution/callback/{linkedin|x|threads|instagram}`; GitHub has none (pasted token). The settings tab shows them with a copy button. The callback needs the admin session; `state` (+PKCE for X) is stored server-side, expires in 10 minutes and is single-use.

**Owner checklist per platform:** create the app (section 4), register the redirect URL, save Client ID/Secret in Settings → Tarqatish (or `DISTRIBUTION_<PLATFORM>_CLIENT_ID/_CLIENT_SECRET`, env wins), click Connect, then open a post → Tarqatish → review text/image/checks → Send. GitHub: add the two markers to the README and paste a fine-grained token.

**Statuses:** draft, scheduled (also while waiting for an automatic retry), sending, sent, failed, needs_checking, cancelled (also "removed from the platform"). One active distribution per post+channel (partial unique index).

**Retries:** only `transient` and `rate_limited`, automatically: at most 5 attempts, waits 1 min, 5 min, 15 min, 1 h (rate limits: the platform's time clamped to 1 min..6 h). Completed steps (`partial`) are kept and resumed. Other errors fail immediately. `outcome_unknown` is never retried automatically; a crash during `sending` also becomes `needs_checking`.

**What `needs_checking` means after a deploy:** on start only STALE `sending` rows (stuck for 20+ minutes, the same rule as the per-minute tick) become `needs_checking`. During a deploy overlap the old process may still be finishing a send: its fresh row is left alone and it records the result (platform id and URL) itself. If a row was already flipped and the old process then succeeds, the result is still recorded (only on a row that carries the recovery marker, never on one you resolved by hand; the audit entry has `recordedAfterRecovery`). The direction stays safe: a `sending` or `needs_checking` row is never re-sent automatically, so no second post. A dead process's row becomes `needs_checking` after 20 minutes: check the platform.

**Late results and attempts:** every attempt (claim) carries its own marker (the row's `updatedAt`; no new column, no migration) and a result - success or failure - is written only while that marker still belongs to that attempt. A late result of an OLD attempt (the old process survived recovery and the owner retried knowingly) therefore never overwrites a NEW in-flight attempt. If the owner already closed the row as "not posted" and the platform later reports the post as published, the owner's decision stays (the row remains `cancelled`), but an audit entry `distribution.late_result` (with the post URL) is written and the owner gets a Telegram notification, so the post on the platform is not silently lost: check it there.

**Resolving needs_checking:** look for the post on the platform, then in the panel either mark it sent with the post URL, close it as not posted, or retry knowingly (explicit duplicate-risk confirmation). The assistant cannot resolve it.

**Images:** cover, else the site's generated OG image (own web origin only), converted with the existing pipeline (JPEG, long side ≤1440 px, aspect 4:5-1.91:1). Bytes for LinkedIn/X; a public HTTPS JPEG URL on the blog's own media storage for Threads/Instagram, cached per post.

**Token upkeep:** X/Threads tokens are refreshed ahead of expiry (the new account is persisted BEFORE use; `refresh_ambiguous` keeps the old tokens and requires reconnecting if the next attempt also fails). LinkedIn (60 days), Instagram (only when the platform gave an expiry; a token without expiry needs neither refresh nor reminders) and GitHub tokens cannot be refreshed: at most one Telegram reminder per day from 10 (GitHub 14) days before expiry, one message on expiry. When Telegram is not configured the reminder cannot be delivered: that is recorded in the audit log (`distribution.reminder_undelivered`) and retried the next day, not every minute.

**After `BETTER_AUTH_SECRET` changes:** tokens and client secrets are encrypted with a key derived from it and no longer decrypt. They are shown as **reconnect required**, never as active: the account says so in Settings, the channel is not ready (reason "the stored token could not be read (secret key changed) - reconnect"), preflight errors, send/remove are refused with **no outbound request** (an empty bearer token is never sent), token upkeep makes no refresh attempt and sends ONE owner notification. An unreadable stored client secret marks the app as not configured (also for X, which could otherwise run as a public client). Fix: re-enter the client secret and reconnect the account.

**Scheduled sends freeze the account and the text:** at schedule/send time the rendered text and the platform id of the account are stored. At send time (1) if a DIFFERENT account was connected for that channel meanwhile, the distribution fails ("a DIFFERENT account was connected after scheduling...") and nothing is posted to the new account - cancel and schedule again; reconnecting the SAME account is fine; (2) a distribution without hand-edited text posts what the preview showed when it was scheduled, not text regenerated from a later edit of the post (saving the text of a scheduled distribution refreshes it). The GitHub block is excluded (rebuilt from the latest posts each time).

**Which text a retry posts:** every OWNER-initiated send/schedule/**retry** (including resolve → "retry knowingly") posts exactly what the preview shows at that moment, including the saved hand edit. So if you edit and save the text after a failure, or the post title changes, "Retry" posts the text you see now, not the one frozen when it was scheduled: the text is frozen again when the row is re-queued. **Automatic** retries (`transient`/`rate_limited`) are the exception: they keep the already frozen text, since nobody reviewed anything new. The GitHub block is always rebuilt.

**Posts in the trash:** the Tarqatish dialog opens from Posts → Trash. All rows are shown read-only (draft, scheduled, needs checking, sent): a scheduled one can be cancelled (a trashed post is never sent anyway), needs_checking can be resolved the existing way (mark sent / not posted; no retry), and sent ones can be removed from the platform when it supports that; no new send/schedule. Purging the post for good deletes its distribution rows: if it was sent to a platform, the confirm dialog warns in Uzbek and lists the networks - after purging, those posts can no longer be removed from the networks through the panel (the purge itself stays possible). Remove them first via Tarqatish. (The connector's `purge_post` tool does not show this warning.)

**Troubleshooting (API does not start with the flag on):** with `DISTRIBUTION_ENABLED=true` the distribution modules (`routes/admin-distribution`, `mcp/tools/distribution-tools`) are imported at start; if the import throws, the API deliberately does not start (the deploy health check rolls back). Find the cause in the log: the line `[distribution] DISTRIBUTION_ENABLED=true, lekin "<module>" modulini yuklab bo'lmadi: <reason>`. Quick fix: `DISTRIBUTION_ENABLED=false` (this part is not loaded at all and the site behaves as before).

**Tick isolation:** each distribution and each account is handled in its own error handling, so one database error does not stop the rest.

**Limits/costs:** X is pay-per-use. Connector sends (send/schedule/retry) count toward their OWN limit `MCP_WRITE_LIMIT_SOCIAL_SENDS_PER_DAY` (default **5**/day per connection, `0` = unlimited), separate from Telegram's `MCP_WRITE_LIMIT_CHANNEL_SENDS_PER_DAY` (10); removals toward `MCP_WRITE_LIMIT_DESTRUCTIVE_PER_DAY`; saving text and cancelling toward the edit limit.

**Connector permission `social:post`:** the social write tools (`send_distribution`, `schedule_distribution`, `retry_distribution`, `cancel_distribution`, `save_distribution_text`, `remove_distribution_from_platform`) no longer use Telegram's `channels:send`; they require the separate **`social:post`** permission (consent label "Ijtimoiy tarmoqlarga post chiqarish", publishing group). It is only grantable/advertised when BOTH `MCP_WRITE_TOOLS_ENABLED` and `DISTRIBUTION_ENABLED` are on (flag off: consent page, `scopes_supported`, `tools/list` unchanged), never pre-ticked, and asking for it later forces a fresh consent. The four read tools stay on `blog:read`. Existing connections approved with `channels:send` cannot use the social tools until reconnected with the new permission.

**Still UNVERIFIED until the first live connection:** every item in the UNVERIFIED table plus the LinkedIn `/rest/posts` limit and §3.1 interpretation, X refresh-token rotation, Threads/Instagram `permalink`/`user_id` fields, GitHub token-expiry header, Meta app review (tester role), the OG image route hash in production.

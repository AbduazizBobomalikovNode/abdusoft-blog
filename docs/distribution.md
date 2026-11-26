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
| Instagram | 1 ta rasm + caption (havola bosilmaydi) | yo'q (API qo'llamaydi) | OAuth (kod) | 60 kun, 24 soatdan keyin yangilanadi |
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

**Rasm:** standart — muqova, bo'lmasa saytning o'zi yaratgan OG rasmi (`<WEB_ORIGIN>/<slug>/opengraph-image-<hash>`, faqat blogning o'z veb-originidan). Mavjud rasm quvuri bilan JPEG, uzun tomon ≤1440 px, nisbat 4:5–1.91:1 (markazdan kesiladi). LinkedIn/X uchun baytlar; Threads/Instagram uchun blogning o'z media saqlashidagi (R2 yoki `API_ORIGIN/uploads`) OMMAVIY HTTPS JPEG URL — post bo'yicha keshlanadi. Rasm tayyorlanmasa tekshiruvda ko'rinadi (Instagram/LinkedIn maqola kartasi uchun xato, qolganlarida ogohlantirish).

**Token xizmati (har daqiqalik tick):** X va Threads/Instagram tokenlari muddatidan oldin yangilanadi (yangi akkaunt yuborishdan OLDIN bazaga yoziladi; `refresh_ambiguous` — eski tokenlar saqlanadi, keyingi urinish ham xato bersa "qayta ulash kerak"). LinkedIn (60 kun) va GitHub tokenlari yangilanmaydi: muddatdan 10 (GitHub 14) kun oldin boshlab admin Telegram chatiga kuniga ko'pi bilan BITTA eslatma, muddat tugaganda bitta "tugadi" xabari va akkaunt "qayta ulash kerak" holatiga o'tadi. Telegram sozlanmagan bo'lsa eslatma yetkazib bo'lmaydi: bu jurnalga yoziladi (`distribution.reminder_undelivered`) va ertasi kuni qayta uriniladi (har daqiqada emas).

**`BETTER_AUTH_SECRET` almashtirilsa:** tokenlar va Client Secret shu kalitdan olingan kalit bilan shifrlangan. Kalit almashgach ular deshifrlanmaydi. Tizim buni **"qayta ulash kerak"** deb ko'rsatadi ("faol" emas): Sozlamalar'da akkaunt "qayta ulash kerak", kanal "tayyor emas" (sabab: "Saqlangan token o'qib bo'lmadi (maxfiy kalit o'zgargan) — qayta ulang"), tekshiruvda xato, yuborish/olib tashlash platformaga **hech qanday so'rovsiz** rad etiladi (bo'sh bearer token hech qachon yuborilmaydi), token xizmati yangilashga urinmaydi va egasiga BITTA Telegram xabari yuboradi. Saqlangan Client Secret o'qilmasa, ilova sozlanmagan hisoblanadi (X, sirsiz ham ishlay oladigan public client bo'lsa-da) va Sozlamalar'da bu ko'rinadi. Tuzatish: Client Secret'ni qaytadan kiriting va akkauntni qayta ulang. (Kalitni almashtirmaslik eng yaxshisi; almashtirsangiz, barcha ulangan akkauntlar qayta ulanadi.)

**Rejalashtirilgan yuborish — akkaunt va matn "muzlatiladi":** rejalashtirishda (va "Yuborish"da) tizim ikki narsani saqlaydi: ko'rsatilgan (render qilingan) matn va akkauntning platformadagi id'si. Yuborish vaqtida (1) **boshqa akkaunt** ulangan bo'lsa (masalan LinkedIn'ga boshqa profil) tarqatish `failed` bo'ladi ("Rejalashtirilgandan keyin bu kanalga BOSHQA akkaunt ulangan…"), yangi akkauntga post chiqmaydi — bekor qilib, qaytadan rejalashtiring; **xuddi shu akkauntni** qayta ulash (token yangilash, uzib-ulash) muammo emas; (2) qo'lda tahrirlanmagan tarqatish ham postning keyingi tahriridan qayta hisoblangan matnni emas, **rejalashtirish paytida oldindan ko'rsatilgan matnni** yuboradi (rejalashtirilgan tarqatishning matnini saqlash uni yangilaydi). GitHub bloki bundan mustasno: u har safar so'nggi postlardan qayta yig'iladi.

**Savatdagi post:** postni savatga olsangiz ham, "Tarqatish" dialogi Postlar → Savat ro'yxatidan ochiladi: avval yuborilganlar faqat ko'rinadi va (platforma qo'llasa) platformadan olib tashlanadi; yangi yuborish/rejalashtirish yo'q. Postni savatdan butunlay o'chirsangiz tarqatish yozuvlari ham o'chadi — platformadagi postni avval olib tashlang.

**Tick xatolari:** har bir tarqatish va har bir akkaunt o'z xatolarini alohida ushlaydi — bitta yozuvdagi baza xatosi qolganlarini to'xtatmaydi.

**Narx va limit:** X pullik (pay-per-use, 6-bo'lim); qolganlari hujjatda pul ko'rsatilmagan. Konnektor orqali ijtimoiy yuborish (yuborish/rejalashtirish/qayta urinish) **o'z chegarasiga** kiradi: `MCP_WRITE_LIMIT_SOCIAL_SENDS_PER_DAY` (standart **5**/kun, har bir ulanish uchun; `0` — chegarasiz) — Telegram kanalining `MCP_WRITE_LIMIT_CHANNEL_SENDS_PER_DAY` (10) chegarasidan alohida. Platformadan olib tashlash — `MCP_WRITE_LIMIT_DESTRUCTIVE_PER_DAY`, matnni saqlash/bekor qilish — tahrir chegarasi. Konnektor uchun alohida ruxsat: **`social:post`** ("Ijtimoiy tarmoqlarga post chiqarish", Chop etish guruhida) — 11-bo'lim.

**Marshrutlar (admin, `/admin/distribution/...`):** `GET|PUT /settings`, `POST /accounts/:provider/connect`, `POST /accounts/github/token`, `DELETE /accounts/:provider`, `GET /callback/:provider`, `GET /channels`, `GET /posts/:postId`, `POST /posts/:postId/:provider/preview`, `PUT .../draft`, `POST .../send`, `POST .../schedule`, `GET /items/:id`, `POST /items/:id/{cancel,retry,resolve,remove}`. Hammasi faqat admin (xodim 403). Hech bir javob/jurnal/vositada token yoki client secret yo'q.

**Hali haqiqiy akkaunt bilan TEKSHIRILMAGAN** (birinchi ulanishdan keyin tekshiriladi): 9-bo'limdagi barcha `UNVERIFIED` bandlar; LinkedIn `/rest/posts` limiti va §3.1 talqini; X refresh token rotatsiyasi va `expires_in`; Threads/Instagram `permalink`/`user_id` maydonlari va konteyner holati; GitHub token muddati sarlavhasi; Instagram/Threads Meta ilova tasdig'i (tester roli); OG rasm marshrut hash'i prod'da; Telegram eslatma matnlari.

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

LinkedIn: article post with an uploaded thumbnail (Images API) or text + link; delete; 60-day token, no programmatic refresh, reconnect every 60 days (reminder 10 days before, `expiring` at 7). X: text + link, optional single image (`POST /2/media/upload`), delete, refresh-token rotation (always store the new refresh token), URL posts cost far more. Threads: container then publish with `link_attachment`, optional image, delete, 60-day token refreshable after 24 h. Instagram: single public HTTPS JPEG plus caption, container status polling with a bounded wait, links are not clickable, no delete via API. GitHub: replace only the block between two HTML-comment markers (byte-exact elsewhere), re-read once on a sha conflict, markers created only when asked.

Hardening notes: a 5xx, 408, timeout or body-read timeout on a create call is always `outcome_unknown` and takes precedence over any provider-specific mapping (e.g. a Meta `{error:{code:2}}` returned with HTTP 500). Multi-step failures carry `step` and `partial` (`imageUrn`, `mediaId`, `containerId`) and `PublishInput.resume` lets the caller continue without creating a second image/container. X refresh returns `{account, refreshTokenRotated}`; persist the returned account BEFORE using the new access token; a timeout/5xx during refresh is `refresh_ambiguous` (the token may already have rotated; if the next refresh fails, reconnect). `remove` throws `not_supported` where the platform cannot delete (Instagram, GitHub). All URLs are validated inside `publish` (https, no userinfo/port, no private/loopback/link-local hosts, no whitespace or newlines). LinkedIn hashtags are sent as plain `#Tag`; other reserved characters are escaped (live behaviour UNVERIFIED). GitHub's README block is replaced at the byte level: bytes outside the markers are unchanged, the block uses the file's own line endings, and `latestPosts` is required.

Limits: LinkedIn 150 requests/member/day (UTC; UNVERIFIED for `/rest/posts`); Threads 250 posts/24 h; Instagram 100 API posts/24 h, although the docs contradict themselves (the carousel section says 50), so treat 50 as the safe figure until the first live check; X is pay-per-use with a much higher price for posts containing a URL; text limits: LinkedIn 3000 (UNVERIFIED), X 280 weighted units, Threads 500 (emoji count as UTF-8 bytes), Instagram 2200 characters and at most 30 hashtags; GitHub README up to 1 MB plus secondary limits (80 content-creating requests/min).

### 4. Owner checklist

See the Uzbek section 4 for the step-by-step list per platform (developer app, products/permissions, redirect URL placeholder `https://<API_ORIGIN>/distribution/callback/<provider>` to be confirmed by the integration PR, review/payment needs, Instagram professional account, GitHub fine-grained token with Contents: write on the profile repo only).

### 5. Terms of service

LinkedIn API Terms of Use §3.1 (last revised 2022-12-13) lists: "Use the Content or the APIs to automate posting on the LinkedIn Services." Whether posting to your own profile on your explicit instruction falls under it is not spelled out (UNVERIFIED). The integration will only post when the owner or their assistant explicitly triggers it, never automatically on publish.

### 6. UNVERIFIED items

See the table in the Uzbek section 9; each item is also tagged `UNVERIFIED` next to the relevant constant in code.

### 7. Integration (admin panel, scheduler, tools) — `DISTRIBUTION_ENABLED`

Everything below is behind `DISTRIBUTION_ENABLED=true` (default off). Off: no new route answers (404), no scheduler work, no UI entry point, no new connector tool, Telegram unchanged. Telegram is NOT migrated; it is only shown read-only in the channel list.

**Nothing is ever posted automatically on publish.** A distribution starts only when the owner (panel) or their assistant (tool) explicitly sends or schedules that post to that channel - as the LinkedIn API terms (§3.1, "automate posting") require.

**Redirect URLs** (register exactly these; stable): `<API_ORIGIN>/admin/distribution/callback/{linkedin|x|threads|instagram}`; GitHub has none (pasted token). The settings tab shows them with a copy button. The callback needs the admin session; `state` (+PKCE for X) is stored server-side, expires in 10 minutes and is single-use.

**Owner checklist per platform:** create the app (section 4), register the redirect URL, save Client ID/Secret in Settings → Tarqatish (or `DISTRIBUTION_<PLATFORM>_CLIENT_ID/_CLIENT_SECRET`, env wins), click Connect, then open a post → Tarqatish → review text/image/checks → Send. GitHub: add the two markers to the README and paste a fine-grained token.

**Statuses:** draft, scheduled (also while waiting for an automatic retry), sending, sent, failed, needs_checking, cancelled (also "removed from the platform"). One active distribution per post+channel (partial unique index).

**Retries:** only `transient` and `rate_limited`, automatically: at most 5 attempts, waits 1 min, 5 min, 15 min, 1 h (rate limits: the platform's time clamped to 1 min..6 h). Completed steps (`partial`) are kept and resumed. Other errors fail immediately. `outcome_unknown` is never retried automatically; a crash during `sending` also becomes `needs_checking`.

**What `needs_checking` means after a deploy:** on start only STALE `sending` rows (stuck for 20+ minutes, the same rule as the per-minute tick) become `needs_checking`. During a deploy overlap the old process may still be finishing a send: its fresh row is left alone and it records the result (platform id and URL) itself. If a row was already flipped and the old process then succeeds, the result is still recorded (only on a row that carries the recovery marker, never on one you resolved by hand; the audit entry has `recordedAfterRecovery`). The direction stays safe: a `sending` or `needs_checking` row is never re-sent automatically, so no second post. A dead process's row becomes `needs_checking` after 20 minutes: check the platform.

**Resolving needs_checking:** look for the post on the platform, then in the panel either mark it sent with the post URL, close it as not posted, or retry knowingly (explicit duplicate-risk confirmation). The assistant cannot resolve it.

**Images:** cover, else the site's generated OG image (own web origin only), converted with the existing pipeline (JPEG, long side ≤1440 px, aspect 4:5-1.91:1). Bytes for LinkedIn/X; a public HTTPS JPEG URL on the blog's own media storage for Threads/Instagram, cached per post.

**Token upkeep:** X/Threads/Instagram tokens are refreshed ahead of expiry (the new account is persisted BEFORE use; `refresh_ambiguous` keeps the old tokens and requires reconnecting if the next attempt also fails). LinkedIn (60 days) and GitHub tokens cannot be refreshed: at most one Telegram reminder per day from 10 (GitHub 14) days before expiry, one message on expiry. When Telegram is not configured the reminder cannot be delivered: that is recorded in the audit log (`distribution.reminder_undelivered`) and retried the next day, not every minute.

**After `BETTER_AUTH_SECRET` changes:** tokens and client secrets are encrypted with a key derived from it and no longer decrypt. They are shown as **reconnect required**, never as active: the account says so in Settings, the channel is not ready (reason "the stored token could not be read (secret key changed) - reconnect"), preflight errors, send/remove are refused with **no outbound request** (an empty bearer token is never sent), token upkeep makes no refresh attempt and sends ONE owner notification. An unreadable stored client secret marks the app as not configured (also for X, which could otherwise run as a public client). Fix: re-enter the client secret and reconnect the account.

**Scheduled sends freeze the account and the text:** at schedule/send time the rendered text and the platform id of the account are stored. At send time (1) if a DIFFERENT account was connected for that channel meanwhile, the distribution fails ("a DIFFERENT account was connected after scheduling...") and nothing is posted to the new account - cancel and schedule again; reconnecting the SAME account is fine; (2) a distribution without hand-edited text posts what the preview showed when it was scheduled, not text regenerated from a later edit of the post (saving the text of a scheduled distribution refreshes it). The GitHub block is excluded (rebuilt from the latest posts each time).

**Posts in the trash:** the Tarqatish dialog opens from Posts → Trash: earlier sends are shown read-only and can be removed from the platform; no new send/schedule. Purging the post for good deletes its distribution rows - remove the platform post first.

**Tick isolation:** each distribution and each account is handled in its own error handling, so one database error does not stop the rest.

**Limits/costs:** X is pay-per-use. Connector sends (send/schedule/retry) count toward their OWN limit `MCP_WRITE_LIMIT_SOCIAL_SENDS_PER_DAY` (default **5**/day per connection, `0` = unlimited), separate from Telegram's `MCP_WRITE_LIMIT_CHANNEL_SENDS_PER_DAY` (10); removals toward `MCP_WRITE_LIMIT_DESTRUCTIVE_PER_DAY`; saving text and cancelling toward the edit limit.

**Connector permission `social:post`:** the social write tools (`send_distribution`, `schedule_distribution`, `retry_distribution`, `cancel_distribution`, `save_distribution_text`, `remove_distribution_from_platform`) no longer use Telegram's `channels:send`; they require the separate **`social:post`** permission (consent label "Ijtimoiy tarmoqlarga post chiqarish", publishing group). It is only grantable/advertised when BOTH `MCP_WRITE_TOOLS_ENABLED` and `DISTRIBUTION_ENABLED` are on (flag off: consent page, `scopes_supported`, `tools/list` unchanged), never pre-ticked, and asking for it later forces a fresh consent. The four read tools stay on `blog:read`. Existing connections approved with `channels:send` cannot use the social tools until reconnected with the new permission.

**Still UNVERIFIED until the first live connection:** every item in the UNVERIFIED table plus the LinkedIn `/rest/posts` limit and §3.1 interpretation, X refresh-token rotation, Threads/Instagram `permalink`/`user_id` fields, GitHub token-expiry header, Meta app review (tester role), the OG image route hash in production.

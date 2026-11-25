# Claude konnektori (MCP)

[O'zbekcha](#ozbekcha) · [English](#english)

---

## O'zbekcha

### 1. Bu nima?

Claude konnektori — blog API'siga qo'shilgan **masofaviy MCP server** (`https://<API_ORIGIN>/mcp`). U orqali blog egasining o'z Claude'i — claude.ai (brauzer), Claude mobil ilovalari va Claude Code — blogga OAuth bilan ulanib, vositalar (tools) ishlata oladi: postlarni o'qish, qidirish, statistika, izohlar, tarix, chiqindi qutisi, media va amallar jurnalini ko'rish.

> **Hozirgi versiya faqat O'QIYDI.** Yozish, chop etish, o'chirish, izohlarni boshqarish va kanalga yuborish vositalari keyingi PR'da shu tuzilma ustiga qo'shiladi (ruxsatlar ro'yxati hozirdan tayyor — qayta rozilik kerak bo'lmaydi).

**Server tomonda AI modeli YO'Q.** MCP server faqat aniq (deterministik) vositalarni beradi: har bir vosita mavjud xizmat funksiyasini chaqiradi (`/admin/*` marshrutlari ishlatadigan xuddi o'sha kod). Hamma qaror — qaysi postni o'qish, nima yozish, nimani chop etish — ulangan Claude tomonida qoladi; bu server hech qachon model chaqirmaydi.

Hammasi **`MCP_ENABLED` bayrog'i** orqasida (default `false`). O'chiq bo'lsa API aynan avvalgidek ishlaydi: yangi marshrut, plagin va cron yo'q.

### 2. Yoqish

**1. Muhit o'zgaruvchilari** (`apps/api/.env`):

| O'zgaruvchi | Default | Izoh |
|---|---|---|
| `MCP_ENABLED` | `false` | Asosiy bayroq. `true` — konnektor yoqiladi. |
| `API_ORIGIN` | — | **Ommaviy https manzil** (masalan `https://api.abdusoft.uz`). Konnektor URL'i `API_ORIGIN + /mcp` — Claude'ga aynan shuni kiritasiz. Token `aud` maydoni va metadata `resource` shu qiymatga teng bo'lishi shart. |
| `WEB_ORIGIN` | — | Kirish (`/login`) va rozilik (`/consent`) sahifalari shu originda. |
| `MCP_ACCESS_TOKEN_TTL_SECONDS` | `900` | Access token umri (kamida 60). Qisqa — chunki JWT holatsiz; bekor qilish baribir darhol ishlaydi (4-bo'limga qarang). |
| `MCP_REFRESH_TOKEN_TTL_DAYS` | `30` | Refresh token umri; har yangilashda rotatsiya. |
| `MCP_ALLOWED_REDIRECT_URIS` | bo'sh | Qo'shimcha aniq `https://` callback'lar (vergul bilan). Claude'ning `https://claude.ai/api/mcp/auth_callback` va loopback (`http://localhost\|127.0.0.1:<port>/callback`) doim ruxsat etilgan. |
| `MCP_REGISTRATION_RATE_LIMIT_MAX` / `_GLOBAL_MAX` / `_WINDOW_SECONDS` | `20` / `100` / `3600` | Autentifikatsiyasiz ro'yxatdan o'tish: bitta IP uchun / barcha IP'lar uchun umumiy, oyna. |
| `MCP_RATE_LIMIT_MAX` / `_WINDOW_SECONDS` | `300` / `60` | `/mcp` so'rovlari, IP bo'yicha (`0` — o'chiq). |
| `MCP_UNUSED_CLIENT_TTL_HOURS` | `24` | Hech qachon rozilik olmagan ro'yxatdan o'tgan klientlar shuncha soatdan keyin tozalanadi. |
| `MCP_RESULT_MAX_CHARS` | `100000` | Bitta vosita javobining chegarasi (Claude ~150 000 gacha qabul qiladi). |
| `MCP_FORCE_OFFLINE_ACCESS` | `true` | Klient `offline_access`ni so'ramasa ham refresh token berilishi uchun uni qo'shadi. |

`TRUST_PROXY=true` (nginx orqasida) va `COOKIE_DOMAIN` (masalan `.abdusoft.uz`) avvalgidek to'g'ri bo'lishi kerak — sessiya cookie'si API va web orasida umumiy.

**2. Reverse-proxy talabi.** API hostida `/.well-known/*` va `/mcp` yo'llari API'ga **o'zgarishsiz** yetib borishi shart (redirect, qayta yozish, kesish yo'q; `Authorization` sarlavhasi uzatiladi). Ko'p nginx konfiglarida "nuqta bilan boshlanadigan fayllarni yopish" qoidasi (`location ~ /\. { deny all; }`) bor — u `/.well-known/`ni ham yopib yuboradi, shu sabab quyidagi bloklar u qoidadan **oldin** turishi kerak:

```nginx
server {
    listen 443 ssl;
    server_name api.abdusoft.uz;
    # ... certbot SSL sozlamalari ...

    # OAuth/MCP metadata (RFC 8414, RFC 9728) — dot-fayl qoidasidan OLDIN
    location ^~ /.well-known/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # MCP endpoint (Streamable HTTP, faqat POST)
    location = /mcp {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 1m;
        proxy_read_timeout 300s;
    }

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 12m;
    }
}
```

Agar sizda faqat README'dagi oddiy `location / { proxy_pass ... }` bo'lsa va dot-fayl qoidasi yo'q bo'lsa — qo'shimcha hech narsa kerak emas.

**3. Deploy.** API'ni yangilab qayta ishga tushiring: konteyner entrypoint'i `0015_mcp_oauth_tables` migratsiyasini o'zi qo'llaydi (8 ta yangi jadval, mavjudlariga tegmaydi). Keyin `MCP_ENABLED=true` qo'yib qayta ishga tushiring.

**4. Tekshiruv** (o'z serveringizga qarata; hech narsa yaratilmaydi):

```bash
# 401 + WWW-Authenticate: Bearer resource_metadata="https://api.abdusoft.uz/.well-known/oauth-protected-resource/mcp", scope="..."
curl -si -X POST https://api.abdusoft.uz/mcp -H 'content-type: application/json' -d '{}' | head -5
# "resource" aynan https://api.abdusoft.uz/mcp bo'lishi shart
curl -s https://api.abdusoft.uz/.well-known/oauth-protected-resource/mcp
# code_challenge_methods_supported: ["S256"], "none" auth usuli, registration_endpoint
curl -s https://api.abdusoft.uz/.well-known/oauth-authorization-server/api/auth
```

### 3. Claude'ga qo'shish

**claude.ai (brauzer):** *Customize → Connectors → Add custom connector* → URL: `https://api.abdusoft.uz/mcp` (o'zingizning `API_ORIGIN + /mcp`). Client ID/secret kiritish shart emas (Claude o'zini avtomatik ro'yxatdan o'tkazadi). Admin hisobingiz bilan kirasiz, rozilik sahifasida ruxsatlarni ko'rib **Ruxsat berish**ni bosasiz. (Menyu nomlari Claude versiyasiga qarab biroz farq qilishi mumkin.)

**Mobil ilovalar:** konnektor claude.ai'da qo'shilgach, shu akkauntdagi Claude mobil ilovalarida ham paydo bo'ladi — alohida sozlash shart emas.

**Claude Code:**

```bash
claude mcp add --transport http abdusoft-blog https://api.abdusoft.uz/mcp
# so'ng Claude Code ichida /mcp -> abdusoft-blog -> Authenticate (brauzer ochiladi)
```

Sinov: Claude'dan "blogim haqida ma'lumot ber" (`whoami`) yoki "oxirgi 5 ta postimni ko'rsat" (`list_posts`) deb so'rang.

### 4. Ruxsatlar va vositalar

Rozilik sahifasida ruxsatlar guruhlangan: **O'qish / Yozish / Chop etish / Xavfli amallar**.

| Ruxsat | Guruh | Nima beradi |
|---|---|---|
| `blog:read` | O'qish | Postlar (qoralamalar ham), teglar, izohlar, statistika, tarix, chiqindi qutisi, media va amallar jurnalini ko'rish |
| `posts:write` | Yozish | Qoralama yaratish va tahrirlash *(vositalari keyingi PR'da)* |
| `media:upload` | Yozish | Rasm yuklash, alt matnini o'zgartirish *(keyingi PR)* |
| `posts:publish` | Chop etish | Chop etish, rejalashtirish, chop etishdan olish *(keyingi PR)* |
| `channels:send` | Chop etish | Telegram kanalga yuborish *(keyingi PR)* |
| `comments:moderate` | Xavfli | Izohlarni tasdiqlash/yashirish/o'chirish/javob/bloklash *(keyingi PR)* |
| `posts:delete` | Xavfli | Chiqindi qutisiga olish va butunlay o'chirish *(keyingi PR)* |
| `offline_access` | — | Qayta kirmasdan ulanishni saqlash (refresh token) |

Hozir mavjud vositalar (hammasi faqat o'qiydi: `readOnlyHint: true`):

| Vosita | Ruxsat | Vazifasi |
|---|---|---|
| `whoami` | — | Sayt nomi, ulangan egasi, berilgan ruxsatlar, qaysi vositalar mavjud, server chegaralari |
| `list_posts` | `blog:read` | Postlar ro'yxati/qidiruvi (status, so'z, sahifalash) |
| `get_post` | `blog:read` | Bitta post: sozlamalar, teglar, ko'rib chiqish holati, kanal holati, `updatedAt` (keyingi yozish vositalari uchun token) va kontent |
| `list_tags` | `blog:read` | Teglar va chop etilgan postlar soni |
| `list_comments` | `blog:read` | Moderatsiya uchun izohlar (default — kutilayotganlar) |
| `get_site_stats` / `get_post_stats` | `blog:read` | Sayt va bitta post statistikasi |
| `list_post_revisions` / `get_post_revision` | `blog:read` | Post tarixi |
| `list_trash` | `blog:read` | Chiqindi qutisi (boshqa hech bir vosita chiqindidagi postni ko'rsatmaydi) |
| `list_audit_log` | `blog:read` | Amallar jurnali (kim, nima, qaysi kanal orqali) |
| `list_media` | `blog:read` | Media fayllar |

**Post kontenti qanday qaytariladi.** Repoda `markdownToDoc` (Markdown → Tiptap) bor, lekin **teskari (Tiptap → Markdown) serializator yo'q**. Shu sabab `get_post` ikkita shaklni qaytaradi: `content` — o'qish uchun toza matn (bloklar bo'sh qator bilan, sarlavhalar `#`, ro'yxatlar `-`; bu **Markdown emas**, inline format yo'qoladi) va `document` — editor saqlaydigan aniq Tiptap JSON. `include: "text" | "document" | "both"` bilan bittasini so'rash mumkin. Natija hajm chegarasidan oshsa avval `document` tashlanadi, keyin `content` qisqartiriladi (javobda `truncated` sababi bilan). Tahrir vositalari qo'shilganda Markdown serializatorini ham qo'shish taklif qilinadi.

### 5. Claude'da har bir vosita uchun tasdiqlash

Claude konnektor sozlamalarida har bir vosita uchun "har safar so'rash" yoki "doim ruxsat" tanlanadi. Tavsiya: o'qish vositalarini "doim ruxsat" qiling; yozish/chop etish/o'chirish vositalari (keyingi PR) paydo bo'lganda ularni **"har safar so'rash"**da qoldiring. Vositalar `readOnlyHint` / `destructiveHint` annotatsiyalarini beradi — Claude shu asosda ularni guruhlaydi.

### 6. Uzish va telefon yo'qolsa

- **Admin → Ulangan ilovalar → Uzish** (tasdiqlash bilan). Bu *to'liq* bekor qilish: ochiq ulanish (access token) **darhol** ishlamay qoladi, refresh token o'chiriladi, rozilik qatori olib tashlanadi, jurnalga `mcp.revoke` yoziladi.
- Nega darhol? `/mcp` HAR so'rovda bitta DB o'qish bilan tekshiradi: foydalanuvchi hali `admin`mi, shu klient uchun rozilik qatori bormi. Shuning uchun roli tushirilgan yoki uzilgan ulanish keyingi so'rovdayoq 403/401 oladi (JWT hali amal qilsa ham).
- **Telefon/qurilma yo'qolsa:** (1) darhol "Uzish"; (2) Claude akkauntingizdan o'sha qurilmani chiqaring va konnektorni Claude'da ham olib tashlang; (3) sayt parolingizni almashtiring; (4) favqulodda to'xtatish: `MCP_ENABLED=false` qilib API'ni qayta ishga tushiring — `/mcp` va OAuth endpoint'lari yo'qoladi (jadvallardagi yozuvlar saqlanadi). `BETTER_AUTH_SECRET`ni almashtirmang — bu bazadagi shifrlangan sozlamalarni ham buzadi.
- Amallar jurnalida (`Admin → ...` yoki `list_audit_log`) `via: mcp` yozuvlari Claude nima o'qiganini ko'rsatadi (15 daqiqalik oynada yig'ilgan: vosita nomlari va soni; kontent/token yozilmaydi).

### 7. Muammolarni hal qilish

| Belgi | Sabab / yechim |
|---|---|
| Claude "401" bilan aylanib qoladi / ulana olmayapti | `API_ORIGIN` ommaviy **https** URL bo'lmasa token `iss`/`aud` mos kelmaydi. `curl` bilan 2-bo'limdagi tekshiruvlarni qiling; `/.well-known/...` 404 yoki 403 bersa — nginx'da dot-fayl qoidasi (2.2). |
| "wrong resource" / "resource mismatch" | Metadata'dagi `resource` Claude'ga kiritgan URL bilan **aynan** bir xil bo'lishi kerak: `https://api.abdusoft.uz/mcp` (oxirida `/` yo'q, `http` emas). |
| Refresh token berilmayapti / har 15 daqiqada qayta ulanish so'raladi | Klient `offline_access` so'ramagan. `MCP_FORCE_OFFLINE_ACCESS=true` (default) buni o'zi qo'shadi; o'chirilgan bo'lsa yoqing. `MCP_ACCESS_TOKEN_TTL_SECONDS`ni ham tekshiring. |
| Ro'yxatdan o'tishda `429` | `/api/auth/oauth2/register` chegarasi (bitta IP 20/soat, umumiy 100/soat). Umumiy chiqish IP'si orqali ko'p urinish bo'lsa `MCP_REGISTRATION_RATE_LIMIT_MAX`ni oshiring. |
| `invalid_redirect_uri` | Faqat Claude callback'i va loopback ruxsat etilgan. Claude boshqa callback ishlatsa (masalan `https://claude.com/api/mcp/auth_callback`) uni `MCP_ALLOWED_REDIRECT_URIS`ga qo'shing. |
| Rozilik sahifasida "Ruxsat berilmaydi" | Faqat `admin` roli ulay oladi (xodim va oddiy foydalanuvchi — yo'q). |
| Ulangan, lekin "insufficient_scope" | Ulanishda kerakli ruxsat berilmagan: Claude'da konnektorni qayta ulang va ruxsatni bering (vosita xatosida kerakli ruxsat nomi ko'rsatiladi). |
| Admin → Ulangan ilovalar "yoqilmagan" deydi | API'da `MCP_ENABLED=true` emas yoki API javob bermayapti. |

### 8. Xavfsizlik modeli

- **OAuth 2.1**: authorization code + PKCE (faqat S256), `resource` (RFC 8707) bilan token auditoriyasi `…/mcp`ga bog'lanadi; JWT access token (imzo kalitlari `jwks` jadvalida) faqat shu resurs uchun yaroqli. `resource` yubormagan klientga server o'zi qo'shadi, aks holda token shaffof bo'lib `/mcp`da rad etilardi.
- **Faqat admin**: rozilik bosqichida (`403 access_denied`) VA har `/mcp` so'rovida rol qayta tekshiriladi; demote darhol kuchga kiradi.
- **Darhol bekor qilish**: yuqorida (6-bo'lim). Qo'shimcha: rozilik qatori tokenlar bilan **kesishadi** — ruxsatlar token va rozilikning kesishmasi.
- **Ro'yxatdan o'tish cheklangan**: autentifikatsiyasiz, lekin (a) redirect URI faqat Claude/loopback/env ro'yxatidan, (b) IP va umumiy tezlik chegarasi, (c) rozilik olmagan klientlar har soatda tozalanadi.
- **Hajm va tezlik**: `/mcp` tanasi ≤ 1 MB, IP bo'yicha tezlik chegarasi, javob ≤ `MCP_RESULT_MAX_CHARS`.
- **Jurnal**: har chaqiruv `via: mcp`, klient id va vosita nomi bilan; kontent, argument va token jurnalga/logga yozilmaydi.
- Sirli ma'lumotlar vosita javoblarida yo'q (token, parol, webhook sirlari qaytarilmaydi; `list_media` ichki saqlash kalitlarini ham yashiradi).

### 9. Cheklovlar (ochiq ma'lum)

claude.ai'ning aniq discovery tartibi, dinamik ro'yxatdan o'tish yoki o'zining metadata hujjatidan foydalanishi, har doim `resource`/`offline_access` yuborishi va well-known yo'llarni issuer yo'lisiz tekshirishi sinab ko'rilmagan — shuning uchun server har ikkala yo'lni (DCR va Client ID Metadata Document) qo'llaydi, `resource`/`offline_access`ni o'zi to'ldiradi va ildizdagi alias'larni (`/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration`) beradi. Haqiqiy claude.ai bilan birinchi ulanishni deploydan keyin sinab ko'ring.

---

## English

### 1. What is it?

The Claude connector is a **remote MCP server** built into the blog API (`https://<API_ORIGIN>/mcp`). It lets the owner's own Claude (claude.ai, the Claude mobile apps, Claude Code) connect over OAuth and use tools: read and search posts, statistics, comments, revision history, trash, media and the audit log.

**This version is read-only.** Write/publish/delete/moderate/send-to-channel tools arrive in the next PR on the same structure (the permission list is already final, so no re-consent will be needed).

**There is no AI model on the server.** The MCP server only exposes deterministic tools that call the same service functions as the `/admin/*` routes. All judgement stays in the connected client.

Everything sits behind `MCP_ENABLED` (default `false`); with it off the API behaves exactly as before.

### 2. Enable

1. Set `MCP_ENABLED=true` in `apps/api/.env` (variables are listed in the Uzbek table above; the important ones: `API_ORIGIN` must be the public **https** URL, because the connector URL is `API_ORIGIN + /mcp` and the token audience must equal it exactly).
2. **Reverse proxy:** on the API host, `/.well-known/*` and `/mcp` must reach the API unchanged (no redirects, no stripped `Authorization`). If your nginx has a "deny dotfiles" rule, put the `location ^~ /.well-known/` block (see the snippet above) **before** it.
3. Deploy: the entrypoint applies migration `0015_mcp_oauth_tables` (8 new tables, nothing existing is altered).
4. Verify with the `curl` commands above: `POST /mcp` -> `401` with `WWW-Authenticate: Bearer resource_metadata="…"`; the protected-resource `resource` equals the connector URL; the authorization-server metadata lists `code_challenge_methods_supported: ["S256"]` and the `none` auth method.

### 3. Connect

- **claude.ai:** *Customize → Connectors → Add custom connector*, URL `https://api.abdusoft.uz/mcp` (your `API_ORIGIN + /mcp`). No client id/secret needed. Sign in as the admin and approve on the consent page. The connector then also shows up in the Claude mobile apps.
- **Claude Code:** `claude mcp add --transport http abdusoft-blog https://api.abdusoft.uz/mcp`, then `/mcp` → Authenticate.

### 4. Permissions and tools

`blog:read` (read everything, changes nothing), `posts:write`, `media:upload`, `posts:publish`, `channels:send`, `comments:moderate`, `posts:delete` (last two are marked dangerous) plus `offline_access` (keep the connection without signing in again). Current tools (all `readOnlyHint: true`): `whoami`, `list_posts`, `get_post`, `list_tags`, `list_comments`, `get_site_stats`, `get_post_stats`, `list_post_revisions`, `get_post_revision`, `list_trash`, `list_audit_log`, `list_media`.

`get_post` returns `content` (readable plain text — **not** Markdown, there is no Tiptap→Markdown serializer in the repo yet) and `document` (the exact Tiptap JSON). Oversized results drop `document` first, then truncate `content`, and say so in `truncated`.

In Claude's connector settings you can set per-tool approval ("ask every time" vs "always allow"); keep future write/publish/delete tools on "ask every time".

### 5. Revoke / lost device

*Admin → Connected apps (Ulangan ilovalar) → Uzish* revokes completely and immediately: every `/mcp` request re-checks the admin role and the consent row, so the access token dies at once; refresh tokens are deleted. For a lost device: revoke, sign the device out of Claude, change your password; as an emergency kill switch set `MCP_ENABLED=false` and restart. Do **not** rotate `BETTER_AUTH_SECRET` (it also breaks encrypted settings).

### 6. Troubleshooting

401 loop → `API_ORIGIN` not the public https URL, or nginx blocks `/.well-known/`. Wrong `resource` → it must equal the entered URL exactly. No refresh token → keep `MCP_FORCE_OFFLINE_ACCESS=true`. Registration `429` → raise `MCP_REGISTRATION_RATE_LIMIT_MAX`. `invalid_redirect_uri` → add Claude's callback to `MCP_ALLOWED_REDIRECT_URIS`. "Not allowed" on the consent page → only the `admin` role can connect.

### 7. Security model

OAuth 2.1 with PKCE (S256) and RFC 8707 audience binding; admin-only at consent and on every request; immediate revocation (consent-row check per request); unauthenticated registration limited by redirect-URI allow-list, per-IP and global rate limits and hourly cleanup of never-consented clients; request-size and rate limits on `/mcp`; every call audited with `via: mcp` (client id + tool name only — never content or tokens).

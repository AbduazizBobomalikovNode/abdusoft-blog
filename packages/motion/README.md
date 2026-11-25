# @blog/motion

Blog postlari va GitHub repozitoriylari uchun qisqa, **ovozsiz** animatsion tushuntirish videolari ("IT explainer") yasaydigan deterministik dvigatel. Kirish — *storyboard* (sof JSON ma'lumot), chiqish — MP4 (qisqa kliplar uchun GIF) va tekshiruv uchun kichik JPEG kadrlar. Videolar blog'ning o'z ko'rinishida chiqadi: `apps/web` ning rang tokenlari, Geist / Geist Mono shriftlari, `github-light` / `github-dark` kod mavzulari, OG kartochka va prose tipografikasi.

Bu paket faqat **dvigatel va CLI**. Ma'lumotlar bazasi, API route, MCP tool va `apps/api` / `apps/web` bilan integratsiya yo'q — ular keyingi PR'larda.

## Qoidalar (o'zgarmas)

1. **Serverda AI yo'q.** Storyboard'ni yozish — tashqi yordamchining ishi; modul uni faqat tekshiradi va chizadi. Hech qanday model chaqiruvi, ovoz sintezi (TTS) va render vaqtida tarmoq so'rovi yo'q. `src/purity.test.ts` buni testda majburlaydi: SDK importi, `fetch`, `node:http`, `innerHTML`, `Math.random`, `licenseKey` topilsa test yiqiladi.
2. **Deterministik.** Bir xil storyboard — bir xil kadrlar (yozish "jitter"i ham `hash01` bilan aniq hisoblanadi).
3. **Storyboard matni hech qachon HTML bo'lmaydi.** Kod shiki token'lari sifatida (ma'lumot) keladi va React elementlari bilan chiziladi.

## Litsenziya (Remotion)

Render uchun [Remotion](https://www.remotion.dev) 4.0.536 ishlatiladi (`remotion`, `@remotion/bundler`, `@remotion/renderer` — uchalasi aynan bir xil versiya). Remotion'ning `LICENSE.md` faylidagi **Free License** shartlariga ko'ra individual shaxslar (shuningdek 3 tagacha xodimli kompaniyalar) uni bepul, hatto tijorat maqsadida ham ishlatishi mumkin; loyiha egasi yolg'iz ishlaydi, shu sababli bepul litsenziya ostida ishlatiladi. **Litsenziya kaliti berilmaydi va telemetriya yoqilmaydi** (Remotion telemetriyani faqat `licenseKey` berilganda yuboradi; testlar kodda `licenseKey` yo'qligini tekshiradi). Jamoa 3 kishidan oshsa yoki kompaniyaga o'tilsa, litsenziya shartlarini qayta ko'rib chiqish kerak. Shriftlar (Geist, Geist Mono, Noto Sans) SIL OFL 1.1; nusxalari `assets/fonts/` ichida.

## Tez boshlash

Repo ildizidan (`pnpm` — npm/yarn lockfile'ni buzadi):

```bash
pnpm install
cd packages/motion

node src/cli.ts validate fixtures/blog-post.json
node src/cli.ts stills fixtures/blog-post.json --out out/stills          # har sahnaga bitta 960x540 JPEG
node src/cli.ts render fixtures/blog-post.json --out out/blog-post.mp4   # 1920x1080 @ 30 fps, ovozsiz
node src/cli.ts gif fixtures/blog-post.json --from 0 --to 8 --out out/clip.gif
```

Birinchi renderda Remotion Chrome Headless Shell'ni `node_modules/.remotion` ichiga yuklab oladi (~100 MB, faqat bir marta; `--browser <yo'l>` bilan o'z brauzeringizni ko'rsatish mumkin). Remotion bundle'i `packages/motion/.cache/` da dvigatel manbalari xeshi bo'yicha keshlanadi (git'ga kirmaydi). Node >= 24 kerak: `.ts` fayllar Node tomonidan to'g'ridan-to'g'ri ishga tushadi.

### CLI

| Buyruq | Vazifasi |
|---|---|
| `validate <file>` | Storyboard'ni tekshiradi. Xatolarda chiqish kodi 1 va aniq, mashina o'qiy oladigan tuzatish takliflari (`--json` bilan JSON). |
| `timeline <file>` | Sahnalarning boshlanish/tugash kadrlari va umumiy davomiylik (render qilmasdan). |
| `schema [--out f]` | Storyboard JSON Schema'sini chiqaradi (`storyboard.schema.json` — repoda saqlanadi, test uni yangi ekanini tekshiradi). |
| `stills <file> --out <dir> [--at 1.5,4,9] [--scene id]` | Kichik JPEG kadrlar. `--at` bo'lmasa har sahnadan eng ma'lumotli lahzada bittadan; `--scene` bilan — shu sahnaning boshi / erta / o'rtasi / oxiri (`-start`, `-early`, `-middle`, `-end`). |
| `render <file> --out <f.mp4> [--scene id]` | Ovozsiz H.264 MP4 (`yuv420p`, doimiy 30 fps, CRF 17, `+faststart`). `--scene` — faqat bitta sahna (tez iteratsiya uchun). |
| `gif <file> --out <f.gif> [--from s --to s] [--scene id [--loop]]` | Faqat qisqa klip: <= 15 s, <= 800 px, 15 fps. Uzunroq bo'lsa MP4 ishlatishni aytuvchi xato. `--scene id --loop` (faqat `closing`) — oxirgi 2 s "hold": davriy harakat tufayli uzluksiz aylanadi. |

Umumiy: `--theme light\|dark` va `--preset default\|vivid\|blueprint\|neon` (storyboard qiymatlarini bekor qiladi), `--scene <id\|n>` (id yoki 1 dan boshlanuvchi raqam), `--json`, `--cache-dir`, `--browser`, `--concurrency`. Chiqish kodlari: 0 — yaxshi, 1 — storyboard yoki render xatosi, 2 — noto'g'ri foydalanish, 130 — bekor qilindi (`Ctrl+C`: brauzer to'xtatiladi, vaqtinchalik fayllar va yarim tayyor chiqish o'chiriladi).

### Dasturiy API

CLI — yupqa qobiq. Asosiy funksiyalar:

```ts
import { validateStoryboard, computeTimeline, storyboardJsonSchema, formatIssues } from "@blog/motion";
import { MotionRenderer } from "@blog/motion/render"; // brauzerni ishga tushiradi

const r = validateStoryboard(json);          // { ok, storyboard, timeline } | { ok: false, issues }
if (!r.ok) console.error(formatIssues(r.issues));

const renderer = await MotionRenderer.create({ signal, onProgress: (p) => console.log(p.phase, p.fraction) });
try {
  await renderer.stills(json, { outDir });   // bitta brauzer va bundle barcha kadrlar uchun qayta ishlatiladi
  await renderer.video(json, "out.mp4");
} finally {
  await renderer.close();                    // doim: brauzer va vaqtinchalik fayllar tozalanadi
}
```

`signal` (`AbortSignal`) bekor qilish uchun, `onProgress` — `{ phase, fraction, message }`. Render chaqiruvlari jarayon ichida ketma-ket bajariladi va Remotion'ning vaqtinchalik fayllari shaxsiy papkaga yo'naltirilib, har doim o'chiriladi (`src/render/private-tmp.ts`). Ommaviy ish uchun renderlarni alohida worker jarayonlarda ishga tushiring.

## Storyboard formati

Barcha obyektlar qat'iy (strict): noma'lum kalit rad etiladi. To'liq sxema — `storyboard.schema.json`.

```json
{
  "version": 1,
  "title": "Zod bilan API chegarasini himoyalash",
  "theme": "dark",
  "accent": "#4f46e5",
  "siteName": "abdusoft",
  "format": "landscape",
  "defaultTransition": "fade",
  "scenes": [
    { "type": "title", "kicker": "TypeScript", "title": "Zod bilan chegarani himoyalang", "tags": ["zod", "API"] },
    { "type": "bullets", "heading": "Nega chegarada?", "items": ["Tashqi maʼlumot gumonli", "Bitta sxema: tekshiruv va tur"] },
    { "type": "code", "language": "typescript", "fileName": "schema.ts", "typing": true,
      "code": "const Post = z.object({\n  title: z.string(),\n});",
      "steps": [{ "lines": { "from": 1, "to": 3 }, "label": "Sxema chegarani tavsiflaydi" }] },
    { "type": "outro", "cta": "Toʻliq maqolani oʻqing", "url": "blog.abdusoft.uz" }
  ]
}
```

Yuqori daraja: `version` (1), `title`, `theme` (`light` | `dark`), `accent` (ixtiyoriy `#RGB`/`#RRGGBB`; standart — blog'ning yagona xromatik tokeni, dark `--sidebar-primary`; preset tanlansa — presetning o'z rangi), `preset` (ixtiyoriy: `default` | `vivid` | `blueprint` | `neon`, standart `default` = hozirgi minimal ko'rinish), `siteName` (standart `abdusoft`), `format` (hozircha faqat `landscape`: 1920x1080 @ 30 fps), `defaultTransition` (`cut` | `fade` | `slide` | `wipe` | `push` | `zoom`, standart `fade`), `scenes`.

Barcha yangi maydonlar ixtiyoriy yoki yangi sahna turlari: `version: 1` storyboard'lari avvalgidek tekshiruvdan o'tadi va aynan bir xil kadrlar beradi (`src/compat.test.ts` birinchi nashrning vaqt jadvali va tema qiymatlarini qotirib qo'ygan; `default` preset va yangi maydonlarsiz sahnalar piksel-piksel bir xil).

Har sahnada: `id?`, `durationSeconds?` (yo'q bo'lsa mazmundan avtomatik: o'qish va yozish tezligi, min/max bilan; berilsa mazmun talab qiladigan vaqtdan kam bo'la olmaydi), `transition?` (shu sahnaga kirish, birinchi sahnada e'tiborga olinmaydi).

**Sahna turlari**

| `type` | Maydonlar |
|---|---|
| `title` | `kicker?`, `title`, `subtitle?`, `tags?` (so'zma-so'z paydo bo'ladi, teglar "pill" shaklida), `layout?` (`left` standart \| `centered` \| `split`: chapda aksent panel) |
| `bullets` | `heading`, `items[]` (birin-ketin ochiladi), `layout?` (`list` standart \| `centered` \| `split`) |
| `code` | `language`, `fileName?`, `code`, `steps?[{ lines:{from,to}, label?, durationSeconds? }]`, `typing?` (belgilanmagan qatorlar xiralashadi, belgi silliq ko'chadi, yozishda kursor) |
| `terminal` | `title?`, `lines[]`: `{ kind:"command", text, waitSeconds? }` (yoziladi) yoki `{ kind:"output", text, tone?, waitSeconds? }` (paydo bo'ladi; `tone`: default/muted/success/error) |
| `outro` | `siteName?`, `cta`, `url` (faqat matn; hech qachon so'rov yuborilmaydi) |
| `intro` | `variant?` (`aurora` standart \| `blueprint` \| `constellation` \| `boot` \| `signal` \| `slam`), `kicker?`, `title`, `subtitle?`, `tags?` — videoning ochilishi |
| `closing` | `variant?` (intro bilan bir xil ro'yxat), `siteName?`, `cta`, `url` — yakun; oxirgi 2 soniyalik "hold" GIF'da uzluksiz aylanadi |
| `diagram` | `heading?`, `direction?` (`lr` standart \| `tb`), `nodes[]` `{ id, label, detail?, tone? }` (2-8), `edges[]` `{ from, to, label? }` (1-12, ro'yxat tartibida chiziladi), `steps?[]` `{ nodes[], label?, durationSeconds? }` (tugunlarni birin-ketin ajratadi) |
| `compare` | `heading?`, `mode?` (`versus` standart \| `beforeAfter`), `left` / `right` `{ title, items[] }` (1-5), `verdict?` |
| `stat` | `heading?`, `stats[]` `{ value, decimals?, prefix?, suffix?, label, note? }` (1-3; raqam 0 dan sanab chiqadi) |
| `steps` | `heading?`, `layout?` (`horizontal` standart, <= 5 \| `vertical`, <= 6), `items[]` `{ title, detail? }` (2-6; faol qadam oldinga siljiydi) |
| `quote` | `quote`, `author?`, `role?` |
| `codeDiff` | `language`, `fileName?`, `diff` (har qator `+`, `-` yoki bo'sh joy bilan boshlanadi), `label?` |

Tillar (`code.language`): typescript, tsx, javascript, jsx, json, bash, python, go, rust, sql, yaml, html, css, markdown, diff, dockerfile, text.

### Ochilish va yakun (`intro` / `closing`)

Oltita variant, har birining ochilishi va unga mos yakuni bor (`variant`): `aurora` (gradient nur maydoni va kinetik tipografiya), `blueprint` (perspektiv chizma to'ri, chiziqlar chizilib sarlavhani yig'adi), `constellation` (deterministik zarrachalar sarlavhaga yig'iladi), `boot` (terminal yuklanish ketma-ketligi sarlavhaga aylanadi), `signal` (skanlayn / xromatik "signal ushlandi" ochilishi), `slam` (niqobli yirik kinetik matn). Hammasi: 3-6 s, ikkala mavzuda va hamma preset'larda ishlaydi, `accent` rangini oladi, matnni xavfsiz zona ichida va telefonda o'qiladigan o'lchamda saqlaydi.

- **Birinchi kadr** (intro) — ijtimoiy tarmoqlar ko'rsatadigan thumbnail: sarlavha 0-kadrdayoq o'qiladi. **Oxirgi kadr** (closing) — cta + url + sayt nomi tayyor plakat.
- **GIF aylanishi.** `closing` ning oxirgi 2 soniyasi (`LOOP_FRAMES` = 60 kadr) davriy harakatdan iborat, shuning uchun `gif <f> --scene <id> --loop --out x.gif` uzluksiz aylanadi (`timeline --json` da `scenes[i].loop` aniq oraliqni ko'rsatadi).
- Variantlarning har biri uchun qisqa misol: `fixtures/variants/<variant>.json`; hammasini birlashtirgan ko'rgazma: `fixtures/showcase.json`.

### Uslub presetlari (`preset`)

Tema qatlamida (`src/theme/presets.ts`) amalga oshirilgan, shuning uchun eski va yangi sahnalarning hammasi unga ergashadi; shriftlar va kod bo'yoqlari (shiki `github-light` / `github-dark`) hamma presetda blog'nikidek qoladi.

| preset | ko'rinishi |
|---|---|
| `default` | Hozirgi minimal ko'rinish (blog tokenlari), hech narsa o'zgarmaydi. |
| `vivid` | To'qroq fon: aksent va ikkinchi rang (accent2) aralashmasi (gradient mesh) sekin siljiydi, ilgaklar va progress aksent gradienti bilan. |
| `blueprint` | Muhandislik chizmasi: ko'k fon (yorug' mavzuda siyano-tip qog'oz), ingichka va asosiy chiziqli to'r, sovuq cyan aksent. |
| `neon` | Yuqori kontrast: deyarli qora fon, oq matn, cyan/magenta, aksent atrofida nur (yorug' mavzuda — oq-qora va to'q binafsha, nursiz). |

`accent` berilsa preset ranglari ustidan aksent oilasini almashtiradi (matn rangi har doim kontrastga moslab olinadi). Ko'rinish buzilmasligi `src/presets.test.ts` da tekshiriladi: asosiy matn >= 7:1, xira matn va aksent matni >= 4.5:1 (har preset, har mavzu, bir nechta aksent bilan; `default` blog tokenlarini o'zgarishsiz saqlaydi), xiralashtirilgan kod qatorlari birinchi nashrdagidan yomon emas.

### O'tishlar (`transition`)

`cut`, `fade`, `slide` (avvalgidek) va yangilari: `wipe` (kiruvchi sahna chapdan o'ngga ochiladi, chetida aksent chiziq), `push` (kiruvchi sahna chiquvchini itarib chiqaradi), `zoom` ("zoom-through": chiquvchi sahna kameraga uchib keladi, kiruvchisi joylashadi). Brend qatori (sayt nomi, hisoblagich) va progress chizig'i sahnalar ustida turadi: o'tish paytida joyidan siljimaydi.

### Yangi sahnalar: kichik misollar

```json
{ "type": "intro", "variant": "slam", "kicker": "TypeScript", "title": "Zod bilan chegarani himoyalang", "subtitle": "Bitta sxema: tekshiruv va tur.", "tags": ["zod", "API"] }
{ "type": "closing", "variant": "slam", "cta": "Toʻliq maqolani oʻqing", "url": "blog.abdusoft.uz" }
```

`diagram` — tugunlar avtomatik joylashadi (qatlamlar: `lr` da ustunlar, `tb` da qatorlar), yo'llar ro'yxat tartibida chiziladi; orqaga qaytuvchi yo'l yoy bo'lib chiziladi. `steps` — tugunlarni birin-ketin yoritadi (ular orasidagi yo'llar ham yonadi):

```json
{ "type": "diagram", "direction": "lr", "heading": "Soʻrov yoʻli",
  "nodes": [{ "id": "client", "label": "Mijoz" }, { "id": "api", "label": "API", "tone": "accent" }, { "id": "db", "label": "Baza", "detail": "Postgres" }],
  "edges": [{ "from": "client", "to": "api", "label": "JSON" }, { "from": "api", "to": "db" }],
  "steps": [{ "nodes": ["api", "db"], "label": "Faqat toza maʼlumot bazaga yetadi" }] }
```

`compare` — ikki ustun (`right` aksent bilan), `beforeAfter` rejimida chapdan o'ngga o'q:

```json
{ "type": "compare", "mode": "beforeAfter", "left": { "title": "Oldin", "items": ["Qoʻlda if-lar"] }, "right": { "title": "Keyin", "items": ["Bitta sxema"] }, "verdict": "Kod qisqaradi." }
```

`stat` — 1-3 ta raqam 0 dan sanab chiqiladi; kasr kerak bo'lsa `decimals` ni yozing (aks holda aniq xato: `value 3.14 has more decimals than decimals: 0 can show`):

```json
{ "type": "stat", "heading": "Natija", "stats": [{ "value": 38, "suffix": "%", "label": "kamroq xato" }, { "value": 99.9, "decimals": 1, "suffix": "%", "label": "uptime", "note": "2025" }] }
```

`steps` — raqamlangan ketma-ketlik, faol qadam oldinga siljiydi:

```json
{ "type": "steps", "heading": "Tartib", "items": [{ "title": "Sxemani yozing", "detail": "z.strictObject" }, { "title": "Chegarada tekshiring" }, { "title": "Xatoni qaytaring" }] }
```

`quote` va `codeDiff` (qatorlar `+` / `-` / bo'sh joy bilan boshlanadi; kod blog'ning kod oynasida, shiki bo'yoqlari bilan):

```json
{ "type": "quote", "quote": "Chegarada ishonma, ichkarida ishon.", "author": "Abduaziz", "role": "abdusoft blog" }
{ "type": "codeDiff", "language": "typescript", "fileName": "route.ts", "diff": "-const b = await c.req.json();\n+const b = Post.parse(await c.req.json());", "label": "Bitta sxema" }
```

`title` va `bullets` uchun joylashuv variantlari — 16:9 da o'ng yarmi bo'sh qolmasligi uchun: `"layout": "centered"` (markazda) yoki `"layout": "split"` (chapda aksent panel, o'ngda matn). Belgilanmasa — avvalgi ko'rinish.

### Cheklovlar

Hammasi `src/limits.ts` da; xabarlar va README shu yerdan olinadi.

| Nima | Chegara |
|---|---|
| Umumiy davomiylik | <= 60 s (sahnalar kesishmasi hisobga olingan) |
| Sahnalar soni / sahna davomiyligi | <= 16 / 1-30 s |
| `title` / `kicker` / `subtitle` / teglar | 80 / 32 / 120 belgi; <= 5 ta teg, har biri <= 24 |
| `heading` / bullet | 60 / 80 belgi; 1-6 ta bullet |
| Kod | <= 14 qator, qator <= 72 belgi, tab yo'q; <= 8 qadam, `label` <= 80 |
| Terminal | <= 12 yozuv, qator <= 72 belgi, `title` <= 32 |
| `cta` / `url` | 60 / 48 belgi |
| `diagram` | 2-8 tugun, 1-12 yo'l, `label` 24 / `detail` 40 / yo'l yorlig'i 20 belgi, `heading` 60; eng uzun zanjir <= 5 (lr) yoki 4 (tb) qatlam, bir qatlamda <= 4 tugun; <= 6 qadam |
| `compare` | `heading` 60, ustun `title` 28, 1-5 band (<= 60 belgi), ustunlar farqi <= 2 band, `verdict` 90 |
| `stat` | 1-3 raqam, `\|value\|` <= 999 999 999, `decimals` 0-2, `prefix`/`suffix` <= 6, `label` 40, `note` 60 |
| `steps` | 2-6 qadam (gorizontalda <= 5), `title` 40, `detail` 80, `heading` 60 |
| `quote` | `quote` 200, `author` 40, `role` 60 |
| `codeDiff` | <= 14 qator, qator <= 72 belgi (belgidan keyin), tab yo'q, kamida bitta `+` yoki `-`; `label` 80 |
| `intro` / `closing` | `title` 80, `kicker` 32, `subtitle` 120, <= 5 teg (24), `cta` 60, `url` 48, `siteName` 24 (title/outro bilan bir xil) |

Tekshiruv ikki bosqichli: avval tuzilma va maydon limitlari, keyin (tuzilma to'g'ri bo'lsa) vaqt limitlari. Har xato: aniq yo'l (`scenes[2].items[1]`), nima noto'g'ri, chegara va haqiqiy qiymat, tuzatish taklifi:

```
1. scenes[1].items[0]: bullet 1 is 85 characters; the limit is 80
  fix: Rewrite as a short phrase, or split it into two bullets.
2. scenes: total duration is 69.6 s; the limit is 60 s
  fix: Cut about 9.6 s. Longest scenes: scenes[2] (code) 31.1 s; ... Remove or merge scenes, drop bullets or code steps, or remove explicit durationSeconds.
```

## Tuzilma

```
src/
  schema/storyboard.ts   zod 4 sxema (strict) + tur eksportlari (barcha sahna turlari)
  diagram-layout.ts      diagram uchun sof avtomatik joylashuv (qatlamlar, orqaga yo'llar)
  scene-ref.ts           --scene: id yoki raqam bo'yicha sahna tanlash, ko'rib chiqish kadrlari
  schema/issues.ts       zod xatolari -> {path, message, limit, actual, suggestion}
  validate.ts            2 bosqichli tekshiruv, vaqt limitlari
  timeline.ts, timing.ts sof funksiyalar: sahna vaqtlari, yozish jadvali
  layout.ts, fit.ts      format/safe-area abstraksiyasi, matn o'lchami tanlash
  theme/tokens.ts        blog'ning butun vizual identifikatsiyasi (bitta modul) + createTheme(mode, accent, preset)
  theme/presets.ts       vivid / blueprint / neon palitralari; theme/color.ts — kontrast va rang aralashmasi
  theme/font-manifest.ts shrift fayllari va unicode-range
  highlight.ts           shiki token ma'lumot turlari
  bundle/                Remotion bundle: Root, Explainer (o'tishlar), Backdrop (preset foni), scenes/*, showpiece/* (intro/closing variantlari), fonts.ts
  render/                bundle keshi, brauzer, stills/video/gif, bekor qilish, tozalash
  cli.ts                 yupqa CLI
assets/fonts/            Geist, Geist Mono, U+02BB uchun Noto Sans subset + litsenziyalar
fixtures/                misollar (o'zbekcha): blog-post, repository, showcase (barcha yangi sahnalar), variants/* (har variant uchun)
storyboard.schema.json   JSON Schema (yaratiladi: pnpm --filter @blog/motion schema)
```

### Mavzu va shriftlar

`src/theme/tokens.ts` qiymatlarni `apps/web` dan so'zma-so'z ko'chiradi; `src/theme.test.ts` `globals.css`, `layout.tsx`, `render.ts`, `opengraph-image.tsx` va `prose.css` ni o'qib, farq paydo bo'lsa yiqiladi. Shriftlar paket bilan birga (`assets/fonts`) va render `delayRender` bilan hamma shrift yuklanguncha kutadi, tarmoq kerak emas.

Geist'da o'zbek **`ʻ` (U+02BB)** belgisi yo'q (`ʼ` U+02BC bor). Shuning uchun xuddi shu oila ichida faqat U+02BB uchun Noto Sans subset'i (1 KB) ro'yxatdan o'tkazilgan; boshqa hamma belgi Geist'dan chiqadi. `src/fonts.test.ts` `fontkit` bilan haqiqiy fayllarni ochib `oʻzbek`, `gʻoya`, `maʼlumot`, tipografik tirnoqlar va h.k. har bir belgini aynan bitta shrift fayli chizishini tekshiradi.

### Yangi sahna turi qo'shish

1. `src/schema/storyboard.ts`: yangi `z.strictObject({ type: z.literal("..."), ...common, ... })`, `sceneSchema` va `SCENE_TYPES` ga qo'shing; limitlarni `src/limits.ts` ga yozing.
2. `src/schema/issues.ts`: `SCENE_SCHEMAS` ga qo'shing (noma'lum kalit xabari uchun).
3. `src/timeline.ts`: kontent turiga `...Timing` interfeysi, `plan...` funksiyasi (`doneAt`, `hold`, `clampSeconds`, `previewAt`) va `planScene` ga tarmoq.
4. `src/bundle/scenes/NameScene.tsx`: sahna komponenti; o'lchamlar faqat `useStage().layout` (`px`, `sp`, `content`) va `fit.ts` orqali, ranglar faqat `theme` dan. `Explainer.tsx` dagi `switch` ga qo'shing.
5. Testlar: `storyboard.test.ts` (qabul / rad + aniq xabarlar), `timeline.test.ts`; `pnpm --filter @blog/motion schema` bilan JSON Schema'ni yangilang; ikkala mavzuda `stills` bilan ko'z bilan tekshiring.

Kelajakdagi formatlar (`vertical`, `square`): `src/layout.ts` dagi `ENABLED_FORMATS` ga qo'shish yetarli bo'lishi kerak; sahnalar qisqa tomondan masshtablanadi va safe-area ichida turadi.

## Testlar

```bash
pnpm --filter @blog/motion test            # tez, brauzersiz: sxema, limitlar, timeline, tema paritet, shrift, purity
pnpm --filter @blog/motion test:render     # MOTION_RENDER_TESTS=1: haqiqiy render (stills, MP4, GIF, bekor qilish)
```

Standart `pnpm test` va CI hech qachon brauzer yuklamaydi va video render qilmaydi; render testlari faqat `MOTION_RENDER_TESTS=1` bilan ishlaydi.

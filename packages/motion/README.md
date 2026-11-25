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
| `stills <file> --out <dir> [--at 1.5,4,9]` | Kichik JPEG kadrlar. `--at` bo'lmasa har sahnadan eng ma'lumotli lahzada bittadan. |
| `render <file> --out <f.mp4>` | Ovozsiz H.264 MP4 (`yuv420p`, doimiy 30 fps, CRF 17, `+faststart`). |
| `gif <file> --out <f.gif> [--from s --to s]` | Faqat qisqa klip: <= 15 s, <= 800 px, 15 fps. Uzunroq bo'lsa MP4 ishlatishni aytuvchi xato. |

Umumiy: `--theme light\|dark` (storyboard mavzusini bekor qiladi), `--json`, `--cache-dir`, `--browser`, `--concurrency`. Chiqish kodlari: 0 — yaxshi, 1 — storyboard yoki render xatosi, 2 — noto'g'ri foydalanish, 130 — bekor qilindi (`Ctrl+C`: brauzer to'xtatiladi, vaqtinchalik fayllar va yarim tayyor chiqish o'chiriladi).

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

Yuqori daraja: `version` (1), `title`, `theme` (`light` | `dark`), `accent` (ixtiyoriy `#RGB`/`#RRGGBB`; standart — blog'ning yagona xromatik tokeni, dark `--sidebar-primary`), `siteName` (standart `abdusoft`), `format` (hozircha faqat `landscape`: 1920x1080 @ 30 fps), `defaultTransition` (`cut` | `fade` | `slide`, standart `fade`), `scenes`.

Har sahnada: `id?`, `durationSeconds?` (yo'q bo'lsa mazmundan avtomatik: o'qish va yozish tezligi, min/max bilan; berilsa mazmun talab qiladigan vaqtdan kam bo'la olmaydi), `transition?` (shu sahnaga kirish, birinchi sahnada e'tiborga olinmaydi).

| `type` | Maydonlar |
|---|---|
| `title` | `kicker?`, `title`, `subtitle?`, `tags?` (so'zma-so'z paydo bo'ladi, teglar "pill" shaklida) |
| `bullets` | `heading`, `items[]` (birin-ketin ochiladi) |
| `code` | `language`, `fileName?`, `code`, `steps?[{ lines:{from,to}, label?, durationSeconds? }]`, `typing?` (belgilanmagan qatorlar xiralashadi, belgi silliq ko'chadi, yozishda kursor) |
| `terminal` | `title?`, `lines[]`: `{ kind:"command", text, waitSeconds? }` (yoziladi) yoki `{ kind:"output", text, tone?, waitSeconds? }` (paydo bo'ladi; `tone`: default/muted/success/error) |
| `outro` | `siteName?`, `cta`, `url` (faqat matn; hech qachon so'rov yuborilmaydi) |

Tillar (`code.language`): typescript, tsx, javascript, jsx, json, bash, python, go, rust, sql, yaml, html, css, markdown, diff, dockerfile, text.

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
  schema/storyboard.ts   zod 4 sxema (strict) + tur eksportlari
  schema/issues.ts       zod xatolari -> {path, message, limit, actual, suggestion}
  validate.ts            2 bosqichli tekshiruv, vaqt limitlari
  timeline.ts, timing.ts sof funksiyalar: sahna vaqtlari, yozish jadvali
  layout.ts, fit.ts      format/safe-area abstraksiyasi, matn o'lchami tanlash
  theme/tokens.ts        blog'ning butun vizual identifikatsiyasi (bitta modul)
  theme/font-manifest.ts shrift fayllari va unicode-range
  highlight.ts           shiki token ma'lumot turlari
  bundle/                Remotion bundle: Root, Explainer, scenes/*, fonts.ts
  render/                bundle keshi, brauzer, stills/video/gif, bekor qilish, tozalash
  cli.ts                 yupqa CLI
assets/fonts/            Geist, Geist Mono, U+02BB uchun Noto Sans subset + litsenziyalar
fixtures/                ikki misol storyboard (o'zbekcha)
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

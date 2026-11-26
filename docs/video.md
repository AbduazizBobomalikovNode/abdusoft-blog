# Video: animatsiyali tushuntirish xizmati (GitHub Actions'da render)

Egasining yordamchisi (Claude konnektori) post uchun qisqa, **ovozsiz** (≤ 60 s) tushuntirish videosini storyboard asosida tayyorlay oladi. **Serverda AI modeli yo'q:** storyboard'ni yordamchi yozadi, tizim uni tekshiradi va renderlaydi (`packages/motion`, Remotion). Bu hujjat — operator uchun. Konnektor tomoni: [claude-connector.md](claude-connector.md) (18-bo'lim).

Xizmat **default o'chiq** (`VIDEO_ENABLED=false`): o'chiq bo'lsa yangi marshrut, vosita, ruxsat, scheduler ishi va panel tugmasi yo'q; API render kodini umuman yuklamaydi.

## Arxitektura: og'ir ish serverda emas

Production serverda faqat **navbat, tekshiruv, saqlash, kvotalar, marshrutlar, vositalar va panel** turadi. Renderning o'zi **alohida kichik ommaviy repozitoriy**ning (masalan `abdusoft-blog-render`) **GitHub Actions** workflow'ida, GitHub'ning vaqtinchalik hosted runner'ida bajariladi (ommaviy repozitoriy uchun bepul; Ubuntu 24.04, glibc 2.39, 4 vCPU / 16 GB). Workflow blogning o'z repozitoriysida EMAS: shu sababli server tokeni faqat o'sha kichik repozitoriyga beriladi (pastdagi "Nega alohida repozitoriy").

```
  Claude ──MCP──▶ API (server)                         GitHub Actions (hosted runner)
                   │ 1. storyboard tekshiriladi (bir marta)
                   │ 2. ish navbatga (motion_jobs)
                   │ 3. scheduler: ishni "claim" qiladi ──dispatch──▶ render-video.yml (job_id)
                   │                                                    │ 4. blog manbasi, kesh, brauzer
                   │◀────────── claim (HMAC token) ────────────────────┤ 5. storyboard'ni oladi, qayta tekshiradi
                   │◀────────── progress (bekor qilish bayrog'i) ──────┤ 6. renderlaydi
                   │◀────────── fayl bo'laklari (≤ 8 MB) ──────────────┤ 7. natijani yuklaydi
                   │ 8. fayllar media saqlashga ko'chadi, ish "ready"  │
                   ▼
              panel / get_video_job
```

- **Nega serverda emas.** Server Ubuntu 20.04 (glibc 2.31), Remotion'ning compositor binari esa glibc ≥ 2.35 talab qiladi (`GLIBC_2.35 not found`). Bundan tashqari API systemd birligidagi `MemoryMax=768M` bolalar jarayonlarni ham qamraydi, haqiqiy render daraxti ~1.2 GB gacha ko'tariladi, swap yo'q, RAM 3.9 GB.
- **Tokenlar.** Runner uzoq muddatli sirni hech qachon yubormaydi: har bir ish uchun `token = HMAC-SHA256(VIDEO_RUNNER_SECRET, job_id)` hisoblaydi va `Authorization: Bearer` sifatida yuboradi. Token faqat shu ish uchun yaroqli. Server uni doimiy vaqtda solishtiradi; sir yo'q yoki 32 belgidan qisqa bo'lsa hech bir runner so'rovi qabul qilinmaydi.
- **Holatlar.** `queued` → (scheduler claim + dispatch) `running` [`dispatching` → `waiting_runner` → runner `claim` → render → `uploading`] → `ready` | `failed` | `cancelled`. Hamma holat bazada: API qayta ishga tushsa hech narsa yo'qolmaydi (muddati o'tmagan GitHub ishlari `failed` qilinmaydi, `dispatch` yuborilmagan ish qayta yuboriladi).
- **Muddatlar.** Runner dispatch'dan keyin `VIDEO_RUNNER_START_TIMEOUT_SECONDS` (600 s) ichida `claim` qilmasa — `runner_not_started`. Dispatch javobida run id kelgan bo'lsa, scheduler run holatini GitHub'dan (`GET /repos/{owner}/{repo}/actions/runs/{run_id}`, har bir ish uchun ~20 s'da bir marta) so'raydi: run `claim`dan oldin tugagan bo'lsa (bekor qilingan, xato, o'tkazib yuborilgan) ish kutmasdan darhol `runner_not_started` bo'ladi; run id kelmagan bo'lsa faqat muddat ishlaydi. `claim`dan keyin render/ko'rik vaqt chegarasi + 180 s (bundle, yuklash, yakunlash) ichida tugamasa — `runner_timeout` va run bekor qilinadi.
- **Bekor qilish.** Ish darhol `cancelled` bo'ladi, run GitHub'da bekor qilinadi (best effort), runner bayroqni keyingi `progress` chaqiruvida ko'rib to'xtaydi.
- **Qayta dispatch zararsiz.** `claim` bir martalik: ikkinchi run (boshqa run id) rad etiladi va hech narsa qilmasdan tugaydi. Dispatch javobi run id bergan bo'lsa, `claim` FAQAT shu run'dan qabul qilinadi (`run_mismatch`); saqlangan run id hech qachon almashtirilmaydi (u keyinroq run'ni server tokeni bilan bekor qilishda ishlatiladi), id faqat raqamlardan (1..18 xona) iborat bo'lishi kerak.
- **Kvota qaytarilishi.** Infratuzilma xatolarida (`runner_not_configured`, `runner_auth`, `runner_not_found`, `runner_rejected`, `runner_unavailable`, `runner_not_started`) kunlik kvotaning bir birligi qaytariladi (ish `failed` bo'lgan lahzada, bir marta). Render bajarilgan, foydalanuvchi bekor qilgan yoki tekshiruvdan o'tmagan ishlar uchun qaytarilmaydi; ishni o'chirish hisobni tiklamaydi.
- **Tezlik chegarasi.** `/runner/video/*`da avtorizatsiyadan OLDIN faqat MUVAFFAQIYATSIZ urinishlar manzil bo'yicha sanaladi (daqiqada 60, undan keyin 429), haqiqiy token bilan so'rovlar manzilga bog'liq chegaralanmaydi; avtorizatsiyadan keyin ish id bo'yicha daqiqada 600 so'rov.
- **Natija yuklash.** Proksi 12 MB tana va 60 s so'rovni qo'yadi, shuning uchun fayl ≤ 8 MB **bo'laklarda** yuboriladi (`PUT …/files/:name/parts/:n`, qayta yuborish zararsiz), keyin yig'iladi; magic raqam (MP4/GIF/JPEG), ko'rik kadrlarining o'lchami va hajm chegaralari tekshiriladi; MP4 uchun qutilar tuzilishi ham (`ftyp` birinchi, `moov` va `mdat` bor, qutilar o'lchami fayl uzunligiga aniq mos) — shundan o'tmagan fayl `bad_structure` bilan rad etiladi. Vaqtinchalik fayl ostida yoziladi va `rename` qilinadi — yarim fayl "tayyor" bo'lib qolmaydi.

## Nega alohida repozitoriy

Dispatch tokeni "Actions: Read and write" ruxsatini talab qiladi. Bu ruxsat repozitoriydagi **hamma** workflow'ga tegadi: blogning o'z repozitoriysida u `deploy.yml`'ni ham ishga tushira oladi (u qo'lda qaytarish uchun ixtiyoriy eski commit'ni qabul qiladi) va istalgan run'ni bekor qilishi/qayta ishga tushirishi mumkin. Shuning uchun server tokeni **faqat render uchun yaratilgan alohida kichik repozitoriyga** beriladi: token sizib chiqsa ham, u orqali blogni deploy qilib bo'lmaydi. Blogning o'z repozitoriysi `VIDEO_GITHUB_REPO`ga yozilsa, tizim uni **rad etadi** (holat qatorida o'zbekcha xabar, ishlarda `runner_not_configured`); faqat bilib turib `VIDEO_ALLOW_SAME_REPO=true` qo'yish mumkin (tavsiya etilmaydi).

## Bir martalik sozlash (operator)

Render repozitoriysiga qo'yiladigan fayllar blog klonida: `packages/motion/render-workflow/render-video.yml` (workflow shabloni) va `packages/motion/render-workflow/README.md` (qisqa yo'riqnoma).

1. **Alohida ommaviy repozitoriy yarating**, masalan `abdusoft-blog-render` (ommaviy bo'lsa hosted runner daqiqalari bepul). Unga `render-video.yml` ni `.github/workflows/render-video.yml` sifatida, `README.md` ni `README.md` sifatida `main` shoxiga qo'shing. Workflow blog manbasini o'zi checkout qiladi (`repository` — workflow ichida qat'iy yozilgan `AbduazizBobomalikovNode/abdusoft-blog`: u sir bilan qaysi kod ishlashini belgilaydi, shuning uchun ataylab repozitoriy o'zgaruvchisi emas; `ref: main`, `persist-credentials: false`); render repozitoriysida boshqa hech narsa kerak emas. Uchinchi tomon action'lari to'liq commit SHA bilan mahkamlangan.
2. **Runner siri.** Tasodifiy ≥ 32 bayt yarating: `openssl rand -hex 32`. **Bir xil qiymatni** ikki joyga qo'ying: API muhitiga `VIDEO_RUNNER_SECRET=…` va render repozitoriysi environment secret'iga (keyingi qadam). Sirni bazaga yoki panelga kiritmang.
3. **Environment `video-render` (render repozitoriysida).** *Settings → Environments → New environment* (nomi aynan `video-render`):
   - *Deployment branches and tags*: **Selected branches → `main`** (boshqa shoxdagi workflow bu sirga yetmaydi);
   - *Environment secrets*: `VIDEO_RUNNER_SECRET` = 2-qadamdagi qiymat;
   - *Environment variables*: `VIDEO_API_ORIGIN` = API'ning ommaviy **https** manzili, oxirida `/`siz (masalan `https://api.abdusoft.uz`).
   Bu workflow shuni **o'zi yaratmaydi**: operator qo'lda yaratadi.
4. **GitHub token.** *Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate*: **Repository access: Only select repositories → faqat render repozitoriysi** (blogning o'zi EMAS), ruxsat **Repository permissions → Actions: Read and write** (Metadata: Read-only o'zi qo'shiladi). Muddati ≤ 1 yil; tugashidan oldin yangilang.
5. **Blog sozlamalari.** Tokenni va render repozitoriysini (`egasi/abdusoft-blog-render`) *Admin → Sozlamalar → Umumiy → Video* kartasiga kiriting (token shifrlangan saqlanadi, qaytib ko'rinmaydi; workflow fayl nomi va shox default `render-video.yml` / `main`, kerak bo'lsa o'sha kartada o'zgartiriladi) **yoki** `VIDEO_GITHUB_TOKEN`, `VIDEO_GITHUB_REPO` (ixtiyoriy `VIDEO_GITHUB_WORKFLOW`, `VIDEO_GITHUB_REF`) muhit o'zgaruvchilariga yozing (muhit bazadan ustun). Holat qatorida "Workflow: render-video.yml@main" ko'rinadi, sozlama xatosi bo'lsa qizil xabar bilan.
6. **API muhiti** (`apps/api/.env`): `VIDEO_RUNNER_SECRET=…`, `VIDEO_ENABLED=true`, (ixtiyoriy) yuqoridagi `VIDEO_GITHUB_*`; konnektor uchun `MCP_ENABLED=true`, `MCP_WRITE_TOOLS_ENABLED=true`. API'ni qayta ishga tushiring (migratsiya `0019_motion_jobs` deploy bilan o'zi qo'llanadi; bu o'zgarishlar yangi migratsiya qo'shmaydi). `VIDEO_RUNNER` default `github` — serverda brauzer yoki skript kerak emas.
7. **Reverse proxy.** `/runner/video/*` API'ga yetib borishi kerak (boshqa `/` yo'llari kabi). Qo'shimcha sozlama shart emas: yuklash 8 MB bo'laklarda, har bir so'rov 60 soniyadan ancha qisqa. Mijoz manzillari to'g'ri uzatilishi kerak (`TRUST_PROXY`): muvaffaqiyatsiz urinishlar chegarasi manzil bo'yicha.
8. **Konnektorni qayta ulang** va rozilik sahifasida **"Video yaratish"** ruxsatini belgilang (yangi ruxsat eski ulanishga o'zi qo'shilmaydi).

### Tekshirish: bitta ko'rik

1. *Admin → Sozlamalar → Umumiy*: "Video xizmati: yoqilgan (GitHub Actions runner). Token: bor, runner siri: bor, repozitoriy: …" qatori (yoki konnektorda `get_video_status`).
2. Konnektor orqali `preview_storyboard` (yoki `get_storyboard_guide` misolini ishlating). Birinchi javob odatda "still rendering": `get_video_job` bilan 10–20 s'dan keyin kadrlar tayyor bo'ladi.
3. Render repozitoriysida *Actions → Render video* da run ko'rinadi; logda faqat bosqich nomlari, vaqtlar va hajmlar bor.

## Narx, chegaralar, maxfiylik

- **Narx.** Ommaviy repozitoriyda standart hosted runner daqiqalari bepul. Odatiy ish: ishga tushish ~1 daqiqa (runner + `pnpm install` + keshlar) + render. O'lchangan (mahalliy M1, 8 yadro, 4 parallel kadr, sovuq bundle): 56.6 s showcase video **60 s**da (~1.06 s/video soniya), 9 kadrli ko'rik **6.8 s**da, MP4 **6.5 MB**. Hosted 4 vCPU sekinroq bo'lishi mumkin: taxminlar ~2 s/video soniya (`dry_run` tugagan ishlar o'lchovidan o'zi aniqlashtiradi) + ~1 daqiqa ishga tushish. Repozitoriy yopiq bo'lsa daqiqalar tarif bo'yicha hisoblanadi — shu hujjat ommaviy repozitoriyga mo'ljallangan.
- **Parallellik.** Workflow'dagi `concurrency` guruhi **har bir ish uchun alohida** (`render-video-<job_id>`, `cancel-in-progress: false`): GitHub umumiy guruhda bittadan ko'p kutayotgan run'ni saqlamaydi va eskisini bekor qiladi, bu esa navbatdagi ishni yo'qotardi. Yagona cheklovchi — API (`VIDEO_MAX_RUNNING`, default 1, 4 gacha).
- **Maxfiylik.** Chop etilmagan postning storyboard'i **vaqtinchalik GitHub-hosted runner**ga yuboriladi va run tugagach o'chadi. Hech narsa artifact sifatida saqlanmaydi; runner logiga storyboard, token yoki API javoblari **chiqmaydi** (repozitoriy ommaviy, logi ham ommaviy): faqat bosqich nomlari, vaqtlar va hajmlar. Storyboard hamma joyda ishonchsiz kiritma: API'da bir marta, runner'da dvigatelning o'z tekshiruvchisi bilan yana tekshiriladi (farq bo'lsa `engine_mismatch`).
- **Sir tashqariga chiqmaydi.** `VIDEO_GITHUB_TOKEN` hech bir marshrut/vosita/logda qaytmaydi (faqat "sozlangan" belgisi va oxirgi 4 belgi); `VIDEO_RUNNER_SECRET` hech qachon tarmoqqa chiqmaydi (HMAC token chiqadi).

## Sozlamalar (`apps/api/.env`)

| O'zgaruvchi | Default | Ma'nosi |
|---|---|---|
| `VIDEO_ENABLED` | `false` | Asosiy kalit |
| `VIDEO_RUNNER` | `github` | `github` (tavsiya) yoki `local` (serverda; pastga qarang) |
| `VIDEO_RUNNER_SECRET` | bo'sh | Runner bilan umumiy sir, ≥ 32 belgi (faqat muhit). Yo'q/qisqa: GitHub backend "sozlanmagan", ish yaratilmaydi |
| `VIDEO_GITHUB_TOKEN`, `VIDEO_GITHUB_REPO` | bo'sh | Dispatch uchun token (faqat RENDER repozitoriysiga!) va `egasi/nomi` (muhit > panel; token shifrlanadi). Blogning o'z repozitoriysi rad etiladi |
| `VIDEO_GITHUB_WORKFLOW` | `render-video.yml` | Workflow fayl nomi (`[A-Za-z0-9._-]+.yml/.yaml`, yo'lsiz). Muhit > panel |
| `VIDEO_GITHUB_REF` | `main` | Dispatch shoxi (oddiy shox nomi; `video-render` environment shu shoxga ruxsat berishi kerak). Muhit > panel |
| `VIDEO_ALLOW_SAME_REPO` | `false` | `true` — dispatch blogning o'z repozitoriysiga ruxsat etiladi. **Tavsiya etilmaydi**: token `deploy.yml`'ni (eski commit'ga qaytarish) ham ishga tushira oladi |
| `VIDEO_RUNNER_START_TIMEOUT_SECONDS` | `600` | Dispatch'dan `claim`gacha |
| `VIDEO_PREVIEW_WAIT_SECONDS` | `40` | `preview_storyboard` kutadigan eng uzun vaqt (5–50; proksi 60 s'da uzadi) |
| `VIDEO_RUNNER_CONCURRENCY` | `4` | Runner'da parallel kadrlar (runner yadrolari bilan yana cheklanadi) |
| `VIDEO_MAX_RUNNING` | `1` | Bir vaqtda bajarilayotgan ishlar (1..4; `local`da ≤ 2) |
| `VIDEO_RENDER_TIMEOUT_SECONDS` / `VIDEO_PREVIEW_TIMEOUT_SECONDS` | `900` / `120` | Runner'ning render soati (bundle qurish hisobga kirmaydi) |
| `VIDEO_MAX_RENDERS_PER_DAY` / `_PREVIEWS_PER_DAY` | `10` / `60` | Aylanma 24 soat; **ish o'chirilsa ham qaytmaydi** (alohida hisob jadvali) |
| `VIDEO_MAX_QUEUE` | `5` | Navbat uzunligi (parallel chaqiruvlarda ham ushlanadi) |
| `VIDEO_MIN_FREE_DISK_MB` | `2048` | Natijani vaqtincha yozish uchun disk zaxirasi |
| `VIDEO_MAX_MP4_BYTES` / `_GIF_BYTES` / `_STILL_BYTES` | 80 MB / 25 MB / 600 KB | Natija hajmi chegarasi |
| `VIDEO_KEEP_RENDERS_PER_POST` | `3` | Postda oxirgi N render (havola qilingani hech qachon o'chmaydi) |
| `VIDEO_PREVIEW_TTL_HOURS` / `VIDEO_FAILED_TTL_DAYS` | `6` / `7` | Ko'rik va xatolik yozuvlari muddati |
| `VIDEO_DATA_DIR` | bo'sh | Vaqtinchalik yuklashlar (`runner-uploads/`) va `local` ish papkalari (`apps/api/.data/video`) |

`VIDEO_WORKER_*`, `VIDEO_CONCURRENCY`, `VIDEO_MIN_FREE_MEMORY_MB`, `VIDEO_BROWSER_PATH`, `VIDEO_MOTION_DIR` faqat `local` backend uchun.

## Xato kodlari (ish `failed`, `errorCode`)

| Kod | Ma'nosi va nima qilish kerak |
|---|---|
| `runner_not_configured` | Token, repozitoriy yoki runner siri yo'q, sozlama yaroqsiz yoki repozitoriy blogning o'zi (ish yaratilmaydi). 1–6 qadamlar |
| `runner_auth` | GitHub tokenni rad etdi (muddati tugagan/bekor qilingan) yoki "Actions: Read and write" yo'q. Yangi token yarating |
| `runner_not_found` | Render repozitoriysi nomi noto'g'ri, token uni ko'rmaydi yoki workflow fayli (`VIDEO_GITHUB_WORKFLOW`) shoxda (`VIDEO_GITHUB_REF`) yo'q |
| `runner_rejected` | GitHub dispatch'ni rad etdi: workflow'da `workflow_dispatch`/`job_id` kirishi yo'q (422) |
| `runner_unavailable` | GitHub vaqtincha javob bermadi/limit: 3 marta urinildi. Birozdan keyin qaytadan |
| `runner_not_started` | Runner 600 s ichida `claim` qilmadi yoki GitHub run'ni `claim`dan oldin tugagan deb bildirdi (bekor qilingan/xato): Actions o'chirilgan, `video-render` environment/siri/o'zgaruvchisi yo'q yoki `main` shoxi siyosatiga to'g'ri kelmaydi, navbat band. Run GitHub'da bekor qilinadi. Kvota qaytariladi |
| `runner_timeout` | Runner vaqtida tugatmadi; run bekor qilindi. Storyboard'ni qisqartiring |
| `runner_cancelled` | GitHub run tugamasdan bekor qilindi (operator yoki GitHub) |
| `engine_mismatch` | API qabul qilgan storyboard'ni runner'dagi dvigatel rad etdi (API va `main` versiyalari farq qiladi: deploy qiling) |
| `invalid_storyboard`, `gif_limit`, `scene_not_found` | Storyboard/parametr muammosi (xabarda aniq sabab) |
| `render_failed`, `browser_missing` | Renderda xato (workflow brauzerni o'zi o'rnatadi; takrorlansa Actions logiga qarang) |
| `too_large` | MP4/GIF/kadr hajm chegarasidan oshdi: storyboard'ni qisqartiring |
| `upload_failed` | Runner natijani yuklay olmadi (tarmoq/proksi) yoki fayl tekshiruvdan o'tmadi (`bad_magic`, MP4 uchun `bad_structure`). Qaytadan boshlang |
| `disk_full` | API serverida disk to'ldi. Joy bo'shating |
| `storage_failed` | Natijani media saqlashga ko'chirib bo'lmadi (R2/disk) |
| `interrupted` | Faqat `local` backend: API render paytida to'xtagan |

Rad etish (ish yaratilmaydi): `post_busy` (postda faol render bor), `queue_full`, `daily_renders`, `daily_previews`, `low_disk`, `runner_not_configured`.

## Nosozliklarni topish

| Belgi | Sabab / yechim |
|---|---|
| Ish `running`/`waiting_runner`da turibdi | GitHub → Actions'da run bormi? Yo'q bo'lsa `runner_*` xatoni kuting (≤ 10 daqiqa). Bor-u "Waiting for approval" yoki "Environment protection" holatida bo'lsa: environment qoidalarini tekshiring |
| Run darhol qizil: "Environment secret/variable yo'q" | 3-qadam (render repozitoriysida): `video-render` environment, `VIDEO_RUNNER_SECRET`, `VIDEO_API_ORIGIN` |
| Run yashil, lekin ish `failed` (`upload_failed`) | `VIDEO_API_ORIGIN` noto'g'ri yoki API'ga runner'dan yetib bo'lmaydi; proksi `/runner/video/*` ni o'tkazmoqda emas |
| `401` runner logida ("claim failed (401 unauthorized)") | `VIDEO_RUNNER_SECRET` API'da va environment'da **bir xil emas** (probel/yangi qator ham farq) |
| Ish `failed`, `engine_mismatch` | API eski/yangi kodda: `main`ni deploy qiling, keyin qayta urinib ko'ring |

## O'chirish

- `VIDEO_ENABLED=false` va API'ni qayta ishga tushirish: marshrutlar (`/admin/video/*`, `/runner/video/*`), vositalar, ruxsat, scheduler ishi va panel tugmasi yo'qoladi; jadvallar va yuklangan fayllar joyida qoladi. Qolgan runlar API'dan javob topmaydi va tugaydi.
- Faqat dispatch'ni to'xtatish: GitHub tokenni bekor qiling yoki render repozitoriysida Actions → Render video workflow'ini *Disable* qiling.
- Faqat konnektorni cheklash: `MCP_WRITE_TOOLS_ENABLED=false` — render vositalari yo'qoladi (o'qish vositalari qoladi).

## Ixtiyoriy: `VIDEO_RUNNER=local` (serverning o'zida render)

Faqat yetarli kuchli mashina uchun; **kichik serverlarga `github` tavsiya etiladi.**

- **Talablar:** glibc ≥ **2.35** (Ubuntu 22.04+; Ubuntu 20.04'da compositor ishga tushmaydi), ≥ **2 GB** bo'sh xotira, Node 24, `pnpm install` qilingan monorepo. Remotion bundle serveri **3000–3100** portlarda tinglaydi (band bo'lmasligi kerak).
- **systemd:** API birligidagi `MemoryMax`/`MemoryHigh` **ishchi va uning brauzer bolalarini ham** qamraydi (bitta cgroup): render daraxti ~1.2 GB gacha ko'tariladi — limitni shunga qarab oshiring, aks holda tizim butun API'ni o'ldiradi.
- **Sozlash:** `sudo bash scripts/setup-motion-browser.sh --install-deps`, so'ng `bash scripts/setup-motion-browser.sh` — brauzerni yuklaydi va **preflight** o'tkazadi: glibc, compositor binari ishga tushishi va bitta kichik kadr render qilinishi. Muvaffaqiyatsiz bo'lsa aniq xabar (masalan "glibc 2.31 < 2.35") bilan 1 qaytaradi. Muvaffaqiyatli bo'lsa `VIDEO_DATA_DIR/local-preflight.json` yoziladi; **shu faylsiz `local` backend hech bir ishni boshlamaydi** va ish yaratishni rad etadi. Keyin `VIDEO_RUNNER=local`.
- **Xavfsizlik:** ishchi alohida jarayon guruhi, past ustuvorlik, V8 heap chegarasi, devor soati, **butun avlod daraxti (brauzer ham, u alohida sessiyada)** bo'yicha xotira shifti — o'lchab bo'lmasa qisqa muddatdan keyin *to'xtatiladi* (fail closed); to'xtatishda ishchi va brauzerga SIGTERM, qisqa kutish, so'ng SIGKILL; bundle qurilishi ishchi soatiga kirmaydi. Sozlamalar: `VIDEO_WORKER_MEMORY_MB`, `VIDEO_WORKER_HEAP_MB`, `VIDEO_WORKER_NICE`, `VIDEO_CONCURRENCY`, `VIDEO_MIN_FREE_MEMORY_MB`.
- Brauzer holati faqat shu backendda tekshiriladi; `github`da serverda brauzer qidirilmaydi.

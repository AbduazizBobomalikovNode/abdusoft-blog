# Avtomatik deploy (CD)

`main`'ga push qilinib, `CI` muvaffaqiyatli tugagach, GitHub Actions production serverga o'zi deploy qiladi. **Build serverda qilinmaydi** — server (4 yadro, 3.9 GB RAM, swap yo'q, boshqa saytlar bilan umumiy) faqat tayyor build'ni qabul qiladi, bog'liqliklarni o'rnatadi, almashtiradi, migratsiya qiladi va qayta ishga tushiradi.

Qo'lda deploy (`./scripts/deploy-vds.sh`, Mac'dan) o'zgarmagan va zaxira yo'l sifatida doim ishlaydi.

## Qanday ishlaydi

```
main'ga push ──> CI (typecheck, lint, test, build)
                   │ muvaffaqiyatli
                   ▼
   Deploy workflow (.github/workflows/deploy.yml)
   ┌───────────────────────────────────────────────────────────────┐
   │ gate    DEPLOY_ENABLED=true? SHA to'g'rimi? (sirlarsiz)        │
   │ build   runner'da: install, shared+api+web build, bundle       │
   │         (yozish huquqi YO'Q, SSH kalit YO'Q)                   │
   │ deploy  bundle -> `deploy-builds` release; SSH: "<sha> <hash>" │
   └───────────────────────────────────────────────────────────────┘
                   │ ssh (restrict + forced command)
                   ▼
   Server: abdusoft-blog-deploy-entry  (live daraxtdan TASHQARIDA)
     └─ origin/main'dan scripts/server-deploy.sh'ni olib ishga tushiradi
          1. lock (flock) — ikkinchi deploy darrov rad etiladi
          2. git fetch; SHA origin/main tarkibida bo'lishi shart
          3. bundle'ni release'dan yuklab olish (autentifikatsiyasiz HTTPS)
          4. sha256 (.sha256 fayl VA workflow yuborgan hash), manifest
             (commit == so'ralgan SHA, Node major, pnpm-lock.yaml xeshi),
             arxiv tarkibi (faqat ruxsat etilgan yo'llar, symlink yo'q)
          5. manba -> live (rsync, deploy-vds.sh bilan bir xil istisnolar),
             `pnpm install --frozen-lockfile`, Next versiyasi manifestga teng
          6. DB zaxirasi (backup-native.sh), so'ng `pnpm api:migrate`
          7. build'larni rename bilan almashtirish (eskisi *.prev bo'lib qoladi)
          8. ikkala xizmatni qayta ishga tushirish, health check (qayta urinishlar)
          9. muvaffaqiyatsiz bo'lsa — *.prev'ga avtomatik qaytish (BIR marta)
```

### Build almashtirish mexanizmi va chegaralari

- Bundle (`apps/web/.next` — `cache`siz, `apps/api/dist`, `packages/shared/dist` + `MANIFEST.json`) avval `*.new` papkalarga ochiladi. Yuklab olish, checksum, manifest yoki install xatosida ishlayotgan sayt **umuman tegilmaydi**.
- Hammasi tayyor bo'lgach, `X -> X.prev`, `X.new -> X` rename'lari bajariladi (rename — tez; uchta papka ketma-ket almashadi, oraliq bir necha millisekund) va darrov xizmatlar qayta ishga tushadi. Eski build `*.prev`'da qoladi: rollback — rename + restart, qayta build yo'q.
- **Chegaralar (halol):**
  - `pnpm install` live `node_modules`'ni joyida o'zgartiradi. Lockfile o'zgargan bo'lsa va install o'rtada uzilsa, ishlayotgan jarayonlar odatda xotirada yuklangan bo'ladi, lekin kutilmagan crash-restart shu oraliqda buzuq `node_modules` ko'rishi mumkin. Lockfile o'zgarmasa install hech narsani o'zgartirmaydi (no-op). Xatoda skript oldingi commit manbasini qaytarib, lockfile farq qilgan bo'lsa qayta install qilishga urinadi (best-effort).
  - Production-only install (`--prod`) ISHLATILMAYDI: `next.config.ts`ni yuklash `typescript`ni, `pnpm api:migrate` esa `tsx`/`drizzle`ni talab qiladi (devDependencies). Shuning uchun `deploy-vds.sh`dagidek to'liq install.
  - Swap va restart orasida ishlayotgan eski `next start` jarayoni yangi fayllarni o'qishi mumkin (soniyalar); shuning uchun restart darrov bajariladi.
  - `.next/cache` (ISR keshi) almashtirishda yo'qoladi va restartdan keyin qayta to'ldiriladi.
  - Migratsiyalar loyiha siyosatiga ko'ra additive va **orqaga qaytarilmaydi**: eski kod yangi sxema bilan ishlashi kerak. Migratsiya swap'dan OLDIN bajariladi, shuning uchun migratsiya xatosida build almashtirilmaydi.
  - Birinchi pipeline deploy'idan oldin `*.prev` bo'lgan eski (qo'lda yig'ilgan) build uchun commit noma'lum — rollback build'ni qaytaradi, lekin manba daraxtini qaytara olmaydi (keyingi deploy to'liq sinxronlaydi).

### Bundle qayerda saqlanadi

Bundle shu repository'dagi `deploy-builds` **pre-release**'iga asset sifatida yuklanadi (`abdusoft-blog-<sha>.tar.gz` + `.sha256`, oxirgi 5 ta commit qoladi, "latest" emas). Faqat shu workflow'ning `deploy` job'i yozadi (`contents: write` faqat unda). Server uni kalitsiz yuklab oladi.

- Poyga yo'q: yuklash tugamaguncha SSH buyrug'i yuborilmaydi; workflow ommaviy URL'dan qayta yuklab, hashni solishtiradi.
- Build'lar Releases sahifasida bitta "Deploy builds (texnik)" yozuvi sifatida ko'rinadi; uni o'chirmang.
- Bundle ichida Next.js'ning build vaqtida tasodifiy yaratgan kalitlari bor (`preview-props.json`, `server-reference-manifest.json`) va repository ochiq bo'lgani uchun bundle ham ochiq. Loyiha Server Actions ham, `draftMode` ham ishlatmaydi, shuning uchun amalda bu kalitlar hech narsani himoya qilmaydi; eng yomoni preview-cookie bilan ISR keshini aylanib o'tish (yuklama). Haqiqiy sirlar (`.env*`) bundle'ga tushmasligi build jobida tekshiriladi (fayl nomi + maxfiy kalit/DB-URL/token shakllari).
- Agar bundle'ni ochiq qoldirmaslik kerak bo'lsa, muqobil: GitHub artifact attestation + serverda `gh attestation verify` (serverga `gh` va token kerak bo'ladi). Hozirgi yechim bundan oddiyroq; farq — pastdagi xavfsizlik bo'limida.

## Xavfsizlik modeli

| Kim | Nima qila oladi | Nima qila OLMAYDI |
|---|---|---|
| **Deploy SSH kaliti oqib ketsa** | Serverga ulanib, `status` ko'rish yoki `main`'dagi mavjud commit'ni (va faqat uning workflow yuklagan bundle'ini) qayta deploy qilish | Shell olish, fayl o'qish/yozish, o'zboshimchalik bilan kod yuborish, port forwarding (`restrict`), `main`'da bo'lmagan commit, o'z bundle'ini yuklash |
| **Zararli pull request (fork/Dependabot ham)** | CI'da test/build ishlatish (sirlarsiz) | Deploy ishga tushirish, sirlar yoki `production` environment'ga yetish |
| **Faqat release'ga yozish huquqi bor kishi** | Asset almashtirish | Serverga o'z bundle'ini o'tkazish: workflow SSH orqali bundle'ning sha256'ini ham yuboradi, server uni asset bilan solishtiradi — almashtirilgan asset rad etiladi (kalit ham kerak bo'lardi) |
| **Repository'ga yozish huquqi + `main`'ga push** | Kod `main`'ga tushadi va deploy bo'ladi (bu pipeline'ning maqsadi) | — (bu ishonch chegarasi: GitHub akkaunti/branch protection himoyalanishi shart) |

Nima uchun PR'lar yetib bora olmaydi:
1. Deploy workflow'ida `pull_request` triggeri yo'q. `workflow_run` har bir CI tugashida ishga tushadi, lekin `gate` job faqat `event == push`, `head_branch == main`, `head_repository == shu repo` va `conclusion == success` bo'lganda davom etadi; PR'dagi CI `pull_request` hodisasi bo'lgani uchun rad etiladi.
2. `workflow_run` va `workflow_dispatch` workflow faylini default branch'dan oladi — PR'da o'zgartirilgan `deploy.yml` hisobga olinmaydi.
3. SSH kalit — `production` environment secret'i; environment faqat `main` branch'iga ochiladi. Secret'lar faqat `deploy` jobida ishlatiladi; dependency kodini ishga tushiradigan `build` jobida na kalit, na yozish huquqi bor (`contents: read`).
4. Faqat GitHub'ning o'z action'lari (`actions/*`) ishlatiladi; SSH — oddiy `ssh`, `StrictHostKeyChecking=yes` va oldindan mahkamlangan host kalit bilan.

Hash yuborish nega muhim: agar "commit tekshirildi" degan nom bilan release'ga zararli bundle qo'yilsa, server baribir hash mos kelmaganini ko'radi. Workflow hashni SSH kanalidan, bundle'ni esa release'dan beradi — ikki alohida kanal. Piping bilan (bundle'ni SSH orqali oqim sifatida) yuborish bu ajratishni yo'q qilar edi va kalit egasiga o'zboshimchalik bilan kod yuborish imkonini berar edi — shu uchun qilinmagan.

## Bir martalik sozlash

> Deploy workflow `DEPLOY_ENABLED` repository variable'i `true` bo'lmaguncha **o'tkazib yuboriladi** (muvaffaqiyat bilan, xatosiz). PR'ni merge qilish bundan oldin hech narsani o'zgartirmaydi. `DEPLOY_ENABLED`'ni eng OXIRIDA yoqing.

### A. Server (`abdusoft` foydalanuvchisi sifatida)

```bash
# 1) Manba clone (ommaviy repo, HTTPS, kalitsiz) va ishchi papkalar
git clone https://github.com/AbduazizBobomalikovNode/abdusoft-blog.git /home/abdusoft/abdusoft-blog-src
mkdir -p /home/abdusoft/bin /home/abdusoft/abdusoft-blog-deploy

# 2) Kirish wrapper'i — live daraxtdan TASHQARIDA (deploy uni hech qachon qayta yozmaydi)
install -m 755 /home/abdusoft/abdusoft-blog-src/scripts/server-deploy-entry.sh \
  /home/abdusoft/bin/abdusoft-blog-deploy-entry

# 3) Deploy kalit juftligi (alohida, faqat shu maqsad uchun; parolsiz)
ssh-keygen -t ed25519 -N '' -C abdusoft-blog-deploy -f /tmp/abdusoft-blog-deploy
cat /tmp/abdusoft-blog-deploy.pub      # 4-qadam uchun

# 4) authorized_keys: kalit FAQAT wrapper'ni ishga tushira oladi
#    (<PUBLIC_KEY> o'rniga .pub faylning "ssh-ed25519 AAAA..." qismini qo'ying)
echo 'restrict,command="/home/abdusoft/bin/abdusoft-blog-deploy-entry" <PUBLIC_KEY> abdusoft-blog-deploy' \
  >> /home/abdusoft/.ssh/authorized_keys

# 5) Shaxsiy kalitni GitHub secret'ga qo'ygach, serverdan O'CHIRING
#    (B bo'limidagi `gh secret set` buyrug'idan keyin):
#    shred -u /tmp/abdusoft-blog-deploy   (yoki rm -P)

# 6) Tekshirish (qo'lda, deploy qilmaydi):
/home/abdusoft/bin/abdusoft-blog-deploy-entry status
```

Talablar: serverda `git`, `rsync`, `curl`, `flock`, `tar`, `sha256sum`, `/opt/node-v24/bin` (node, pnpm) bor; `abdusoft` uchun parolsiz `sudo systemctl restart abdusoft-blog-api abdusoft-blog-web`. Cron backup (`scripts/backup-native.sh`) o'zgarmaydi.

Wrapper juda kam o'zgaradi. O'zgarsa (`scripts/server-deploy-entry.sh`), 2-qadamdagi `install`ni qayta ishga tushiring. Qolgan hamma mantiq (`scripts/server-deploy.sh`) har deploy'da `origin/main`'dan olinadi.

Host kalit barmoq izini serverda tekshiring: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`, so'ng `ssh-keyscan -t ed25519 -p <PORT> <HOST>` natijasidagi izni solishtiring.

### B. GitHub (`gh` bilan; `OWNER/REPO` = `AbduazizBobomalikovNode/abdusoft-blog`)

```bash
R=AbduazizBobomalikovNode/abdusoft-blog

# 1) `production` environment, faqat main branch'iga ochiq
gh api -X PUT repos/$R/environments/production \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST repos/$R/environments/production/deployment-branch-policies -f name=main -f type=branch
# (ixtiyoriy) majburiy tasdiqlovchi: -f 'reviewers[][type]=User' -F 'reviewers[][id]=<USER_ID>' ni PUT'ga qo'shing
#   Eslatma: build va deploy joblari ikkalasi ham shu environment'da, tasdiq HAR BIRI uchun so'raladi.

# 2) Environment variables (sir EMAS)
gh variable set DEPLOY_HOST       --env production --repo $R --body '<SERVER_HOST_YOKI_IP>'
gh variable set DEPLOY_USER       --env production --repo $R --body 'abdusoft'
gh variable set DEPLOY_PORT       --env production --repo $R --body '22'
gh variable set DEPLOY_KNOWN_HOSTS --env production --repo $R --body "$(ssh-keyscan -t ed25519 <SERVER_HOST_YOKI_IP>)"
gh variable set NEXT_PUBLIC_API_URL   --env production --repo $R --body 'https://api.abdusoft.uz'
gh variable set NEXT_PUBLIC_SITE_URL  --env production --repo $R --body 'https://blog.abdusoft.uz'
gh variable set NEXT_PUBLIC_SITE_NAME --env production --repo $R --body 'abdusoft'
# Serverdagi apps/web/.env.production'dagi QOLGAN NEXT_PUBLIC_* qiymatlar ham shu yerga (bo'sh qoldirilsa, mos funksiya o'chadi):
gh variable set NEXT_PUBLIC_GITHUB_LOGIN         --env production --repo $R --body '<qiymat>'
gh variable set NEXT_PUBLIC_TURNSTILE_SITE_KEY   --env production --repo $R --body '<qiymat>'
gh variable set NEXT_PUBLIC_UMAMI_SCRIPT_URL     --env production --repo $R --body '<qiymat>'
gh variable set NEXT_PUBLIC_UMAMI_WEBSITE_ID     --env production --repo $R --body '<qiymat>'
gh variable set NEXT_PUBLIC_TELEGRAM_URL         --env production --repo $R --body '<qiymat>'
gh variable set NEXT_PUBLIC_GITHUB_URL           --env production --repo $R --body '<qiymat>'

# 3) Secret: deploy shaxsiy kaliti
gh secret set DEPLOY_SSH_KEY --env production --repo $R < /tmp/abdusoft-blog-deploy

# 4) ENG OXIRIDA — deploy'ni yoqish (repository darajasidagi variable)
gh variable set DEPLOY_ENABLED --repo $R --body 'true'
```

| Nom | Turi | Joyi | Ma'nosi |
|---|---|---|---|
| `DEPLOY_ENABLED` | variable | repository | `true` bo'lsagina deploy ishlaydi; aks holda workflow toza o'tkazib yuboriladi |
| `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PORT` | variable | production | SSH manzili (port ixtiyoriy, default 22) |
| `DEPLOY_KNOWN_HOSTS` | variable | production | Server host kaliti (`ssh-keyscan` satri); ochiq ma'lumot, `StrictHostKeyChecking=yes` shu bilan ishlaydi |
| `DEPLOY_SSH_KEY` | **secret** | production | Deploy shaxsiy kaliti (serverda `restrict,command=` bilan cheklangan) |
| `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_SITE_NAME` | variable | production | Majburiy; bundle ichiga build vaqtida yoziladi |
| `NEXT_PUBLIC_TELEGRAM_URL`, `_GITHUB_URL`, `_TURNSTILE_SITE_KEY`, `_GITHUB_LOGIN`, `_UMAMI_SCRIPT_URL`, `_UMAMI_WEBSITE_ID` | variable | production | Ixtiyoriy ochiq qiymatlar (serverdagi hozirgi `.env.production` bilan bir xil bo'lsin) |

Sir EMAS va build vaqtida kerak EMAS: `REVALIDATE_SECRET` (faqat runtime, serverdagi `.env.production`da qoladi), `apps/api/.env`dagi hamma narsa (serverda qoladi).

## Foydalanish

- **Avtomatik:** `main`'ga merge/push -> CI -> Deploy. Natija Actions logida (serverning qadam-baqadam chiqishi shu yerda).
- **Qo'lda deploy / rollback (eski commit):** Actions -> Deploy -> *Run workflow*, `sha` maydoniga `main`'dagi istalgan commit SHA'sini yozing (bo'sh = main oxirgi commit'i). Workflow uni qayta build qiladi va deploy qiladi.
- **Zudlik bilan rollback (qayta build'siz)** — serverda: `/home/abdusoft/bin/abdusoft-blog-deploy-entry rollback` (faqat qo'lda; SSH kaliti bu buyruqni bajara olmaydi). Bitta qadamga qaytadi (`*.prev`).
- **Holat:** `ssh abdusoft@HOST` (yoki serverda) `/home/abdusoft/bin/abdusoft-blog-deploy-entry status` — hozirgi commit, vaqt, oldingi commit, oxirgi natija, xizmatlar. Hech narsani o'zgartirmaydi. Deploy kaliti bilan: `ssh -i KEY HOST status`.
- **Log:** `/home/abdusoft/abdusoft-blog-deploy/deploy.log` (vaqt belgisi bilan), holat: `.../state`.

## Qo'lda zaxira yo'l

`./scripts/deploy-vds.sh` (Mac'dan, rsync + serverda build) o'zgarmagan. Eslatma: u CD holat faylini yangilamaydi (`status` eskirgan commit ko'rsatadi) va `*.prev` papkalarni o'chiradi (keyingi deploy'gacha zudlik bilan rollback mavjud bo'lmaydi). Ikki yo'lni bir vaqtda ishga tushirmang.

## Nosozliklar va nima qilish kerak

| Alomat | Sabab | Nima qilish |
|---|---|---|
| Workflow "o'tkazib yuborildi" notice | `DEPLOY_ENABLED` yo'q / CI muvaffaqiyatsiz / PR | Kutilgan; sozlash yuqorida |
| `build`: "API javob bermadi" | Production API `/health`, `/site`, `/tags`, `/posts...` ga 200 bermadi | API'ni tekshiring (`systemctl status abdusoft-blog-api`); keyin Re-run. Bo'sh sahifalar deploy QILINMAYDI |
| `build`: sir/`.env` topildi | Bundle ichida sirga o'xshash qiymat | Natijani tekshiring; deploy to'xtaydi |
| SSH: host key verification failed | `DEPLOY_KNOWN_HOSTS` mos emas (server almashgan/MITM) | Barmoq izini qo'lda solishtirib, variable'ni yangilang |
| "Rad etildi: faqat '<sha>'..." (kod 64) | Wrapper kutilmagan argument oldi | Workflow faqat SHA yuboradi; qo'lda yuborgan bo'lsangiz formatni tekshiring |
| "boshqa deploy hozir ishlayapti" (kod 3) | Lock band | Tugashini kuting; yopishib qolgan jarayon bo'lsa `ps`/`status` |
| "origin/main tarkibida emas" | SHA `main`'da emas | To'g'ri SHA bilan qayta ishga tushiring |
| "Checksum mos kelmadi" / "Manifest ..." | Bundle buzilgan/almashtirilgan yoki boshqa commit | Sayt tegilmagan. Workflow'ni qayta ishga tushiring (bundle qayta yig'iladi) |
| "Next.js versiyasi mos emas" | Server `node_modules` versiyasi bundle'ga teng emas | Sayt tegilmagan (manba qaytariladi); lockfile'ni tekshiring |
| `pnpm install` xatosi | Tarmoq/lockfile | Sayt eski build bilan ishlayapti; log'ni ko'ring, qayta urining |
| Migratsiya xatosi | SQL xatosi | Build almashtirilmagan, eski sayt ishlayapti; zaxira `/home/abdusoft/backups/abdusoft-blog/` da; migratsiyani tuzatib yangi commit |
| "DEPLOY MUVAFFAQIYATSIZ ... qaytarildi" (kod 1) | Yangi build health check'dan o'tmadi; avtomatik qaytarildi | Sayt oldingi versiyada. Sababni log/`journalctl -u abdusoft-blog-web` dan toping. DB migratsiyalari qaytarilMAGAN (additive) |
| "ORQAGA QAYTARISH HAM MUVAFFAQIYATSIZ" (kod 2) | Ikkala versiya ham ko'tarilmadi | Qo'lda aralashuv: `journalctl -u abdusoft-blog-api -u abdusoft-blog-web`, keyin `./scripts/deploy-vds.sh` (zaxira yo'l) |
| SSH uzilib qoldi | Tarmoq | Server skripti HUP/PIPE'ni e'tiborsiz qoldiradi va deploy'ni oxiriga yetkazadi; natijani `status`/log'dan ko'ring |

## Sinov

`./scripts/tests/server-deploy-sim.sh` — haqiqiy serversiz lokal simulyatsiya (vaqtinchalik papkalar, lokal bare git repo, `sudo/systemctl/pnpm/curl/flock/backup` shim'lari). CI'da ham ishlaydi (`deploy-scripts` job). Qamrab oladi: muvaffaqiyatli deploy, noto'g'ri argument va in'ektsiya urinishlari, main'da bo'lmagan SHA, `status`, lock, yuklab olish/checksum/manifest/lockfile/Node/Next nomuvofiqligi, zararli arxiv, install/backup/migratsiya xatosi, health check xatosi -> avtomatik rollback, rollback ham yiqilgan holat, zudlik bilan rollback va eski commit'ni qayta deploy.

Simulyatsiya qila OLMAYDI: haqiqiy `systemd`, `sshd` (`restrict`/forced-command), GitHub release yuklashlari, serverdagi haqiqiy `pnpm`/`next start` va xotira cheklovlari — birinchi haqiqiy deploy shuni tekshiradi.

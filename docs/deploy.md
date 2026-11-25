# Avtomatik deploy (CD)

> **Ishonch modeli (avval shuni o'qing).** `main` branch'iga kod yuklay oladigan har kim production serverda `sudo` huquqli foydalanuvchi sifatida kod ishga tushira oladi: `main`'dagi har bir commit CI'dan o'tgach avtomatik build qilinadi va deploy bo'ladi. Pipeline'ning butun xavfsizligi shu bitta nuqtaga tayanadi. Shuning uchun: (1) `main` himoyalanishi shart — majburiy CI tekshiruvlari, force-push va o'chirish taqiqlangan; (2) GitHub akkaunti 2FA (yaxshisi passkey) bilan himoyalangan bo'lishi kerak; (3) `main`'ga yozish huquqi bor token/akkauntlar minimal bo'lsin. Tavsiya etiladigan aniq sozlamalar — pastda, "Repository sozlamalari" bo'limida. Pipeline faqat *tashqi* hujumni (oqib ketgan kalit, zararli PR) cheklaydi; `main`'ga push huquqini egallagan hujumchini to'xtata olmaydi.

`main`'ga push qilinib, `CI` muvaffaqiyatli tugagach, GitHub Actions production serverga o'zi deploy qiladi. **Build serverda qilinmaydi** — server (4 yadro, 3.9 GB RAM, swap yo'q, boshqa saytlar bilan umumiy) faqat tayyor build'ni qabul qiladi, bog'liqliklarni o'rnatadi, almashtiradi, migratsiya qiladi va qayta ishga tushiradi.

Qo'lda deploy (`./scripts/deploy-vds.sh`, Mac'dan) o'zgarmagan va zaxira yo'l sifatida doim ishlaydi.

## Qanday ishlaydi

```
main'ga push ──> CI (typecheck, lint, test, build)
                   │ muvaffaqiyatli
                   ▼
   Deploy workflow (.github/workflows/deploy.yml)
   ┌─────────────────────────────────────────────────────────────────────┐
   │ gate    DEPLOY_ENABLED=true? CI `push`/`main`mi? SHA to'g'rimi?       │
   │ build   [environment: production-build] runner'da: install, shared+  │
   │         api+web build, sir tekshiruvi, bundle SHIFRLANADI, artifact   │
   │         (yozish huquqi YO'Q, SSH kalit YO'Q)                          │
   │ deploy  [environment: production] shifrlangan bundle -> `deploy-      │
   │         builds` release; SSH: "<sha> <bundle-sha256>"                 │
   │         (shifrlash kaliti YO'Q)                                       │
   └─────────────────────────────────────────────────────────────────────┘
                   │ ssh (restrict + forced command)
                   ▼
   Server: abdusoft-blog-deploy-entry  (live daraxtdan TASHQARIDA)
     └─ origin/main'dan scripts/server-deploy.sh'ni olib ishga tushiradi
          0. lock (flock) — ikkinchi deploy darrov rad etiladi; oldingi deploy
             o'ldirilgan bo'lsa (yarim holat) — avtomatik tiklash; shu commit
             allaqachon ishlayotgan bo'lsa — arzon no-op (chiqish 0)
          1. kalit fayli (600) va bo'sh disk tekshiruvi — hech narsa tegilmaydi
          2. git fetch; SHA origin/main tarkibida bo'lishi shart
          3. shifrlangan bundle'ni release'dan yuklash (autentifikatsiyasiz HTTPS)
          4. sha256: .sha256 fayl VA SSH orqali kelgan hash (ikkalasi ham shart);
             shifrdan chiqarish (openssl, kalit fayli); arxiv tekshiruvi (hajm,
             yozuvlar soni, faqat oddiy fayl/papka, ruxsat etilgan yo'llar);
             manifest (commit, Node major, pnpm-lock.yaml xeshi)
          5. `pnpm fetch` (bog'liqliklar oldindan do'konga), live manba
             snapshot'i, manba sinxroni (rsync, deploy-vds.sh bilan bir xil
             istisnolar), `pnpm install --frozen-lockfile --offline`,
             Next versiyasi manifestga teng
          6. DB zaxirasi (faqat baza, `--db-only`), so'ng `pnpm api:migrate`
          7. build'larni rename bilan almashtirish (eskisi *.prev bo'lib qoladi)
          8. ikkala xizmatni qayta ishga tushirish; health check (qayta urinishlar)
          9. muvaffaqiyatsiz bo'lsa — *.prev'ga va manba snapshot'iga avtomatik qaytish (BIR marta)
```

### Build almashtirish mexanizmi va chegaralari

- Bundle (`apps/web/.next` — `cache`siz, `apps/api/dist`, `packages/shared/dist` + `MANIFEST.json`) avval `*.new` papkalarga ochiladi. Yuklab olish, checksum, shifrdan chiqarish, manifest, `pnpm fetch`, kalit yoki disk xatosida ishlayotgan sayt **umuman tegilmaydi**.
- Hammasi tayyor bo'lgach, `X -> X.prev`, `X.new -> X` rename'lari bajariladi va darrov xizmatlar qayta ishga tushadi. Eski build `*.prev`'da qoladi: rollback — rename + restart, qayta build yo'q. Rename o'rtada yiqilsa, shu papka darrov tiklanadi.
- **Manba tiklash git'ga emas, snapshot'ga tayanadi.** Sinxrondan oldin live manbaning nusxasi `…/abdusoft-blog-deploy/src.cur`ga olinadi; xatoda aynan o'sha holat qaytariladi (node_modules, `.env*`, `.data` hech qachon tegilmaydi). Muvaffaqiyatdan keyin u `src.prev` bo'ladi (`*.prev` build'ga mos — qo'lda rollback uchun). Shu sababli live qo'lda (`deploy-vds.sh`) o'zgartirilgan bo'lsa ham, pipeline "eski commit"ni ustiga yozib yubormaydi.
- **Drift aniqlash.** Har muvaffaqiyatli deploy'dan keyin `apps/web/.next/BUILD_ID` holat fayliga yoziladi. Keyingi deploy boshida u live bilan solishtiriladi; mos kelmasa (birinchi ishga tushirish yoki qo'lda deploy) oldingi commit "noma'lum" deb olinadi va aniq ogohlantirish chiqadi; build rollback ishlayveradi.
- **Crash safety.** Holat faylida `phase` yuritiladi (`source` → `swapping` → `restarting` → `idle`) va almashtirish jarayoni (`swap_cur`, `swap_done`) yoziladi. Skript o'ldirilsa (SIGKILL, elektr), keyingi so'rov avval avtomatik tiklaydi (yarim rename'lar, manba, build, restart, health) va chiqish kodi 1 bilan "so'rovni qayta yuboring" deydi; `*.prev`'ni hech qachon allaqachon almashgan build bilan ustiga yozmaydi. `*.prev` yo'q bo'lsa — rad etadi (kod 2) va qo'lda ko'rsatma beradi.
- **Vaqt chegaralari.** `git fetch`, `pnpm fetch`, `pnpm install`, zaxira, migratsiya, restart va yuklash `timeout` ichida; osilib qolgan qadam lock'ni abadiy ushlab turmaydi va normal xato/rollback yo'lidan o'tadi. Standart qiymatlar (soniya): git 120, pnpm fetch 600, install 900, backup 600, migrate 300, restart 120, download 600. Wrapper'ning conf faylida `BLOGDEPLOY_TIMEOUT_*` bilan o'zgartiriladi.
- **Install tarmoqsiz.** `pnpm fetch` tayyorgarlik bosqichida (live daraxt tegilmagan) do'konni to'ldiradi; live'dagi install `--offline`. Rollback'dagi qayta install ham avval oflayn, bo'lmasa onlayn. pnpm skript ruxsat ro'yxati (`onlyBuiltDependencies`) qo'lda skriptdagidek o'zgarmagan (`--ignore-scripts` ishlatilmaydi — Linux'da `tsx/esbuild` va `next start` skriptlarsiz ishlashini sinab bo'lmadi).
- **Health check yangi build'ni va bazani isbotlaydi:** web — `/` va `/_next/static/<BUILD_ID>/_buildManifest.js` (aynan yangi bundle'ning BUILD_ID'si; eski jarayon bunga javob bermaydi); API — `/health` va bazaga so'rov yuboradigan `/tags`.
- **Chegaralar (halol):**
  - `pnpm install` live `node_modules`'ni joyida o'zgartiradi. Lockfile o'zgargan va install o'rtada uzilsa, ishlayotgan jarayonlar odatda xotirada yuklangan bo'ladi, lekin kutilmagan crash-restart shu oraliqda buzuq `node_modules` ko'rishi mumkin. Lockfile o'zgarmasa install no-op. Xatoda lockfile farq qilgan bo'lsa qayta install urinadi (best-effort).
  - Production-only install (`--prod`) ISHLATILMAYDI: `next.config.ts`ni yuklash `typescript`ni, `pnpm api:migrate` esa `tsx`/`drizzle`ni talab qiladi.
  - Swap va restart orasida eski `next start` yangi fayllarni o'qishi mumkin (soniyalar); restart darrov bajariladi.
  - `.next/cache` (ISR keshi) almashtirishda yo'qoladi va restartdan keyin qayta to'ldiriladi.
  - Migratsiyalar loyiha siyosatiga ko'ra additive va **orqaga qaytarilmaydi**. Migratsiya swap'dan OLDIN bajariladi, shuning uchun uning xatosida build almashtirilmaydi (lekin manba va DB o'zgargan bo'lishi mumkin; manba tiklanadi, DB — zaxiradan).
  - Faqat kutilayotgan migratsiya bo'lganda zaxira olishni ishonchli aniqlab bo'lmaydi (DB parollari kerak) — shuning uchun doim zaxira olinadi, lekin **faqat baza** (uploads arxivisiz) va oxirgi 5 ta saqlanadi (`blog_predeploy_*`). Cron'dagi kunlik zaxira o'zgarmagan.
  - Server bo'sh joyi `MIN_FREE_MB` (standart 1024) dan kam bo'lsa deploy boshlanmaydi.
  - Birinchi pipeline deploy'idagi `*.prev` (qo'lda yig'ilgan eski build) uchun commit noma'lum; build rollback ishlaydi.
  - `deploy.log` 2 MB dan oshsa `deploy.log.1`ga aylantiriladi; `*.failed` papkalar va eski yuklamalar keyingi deploy boshida tozalanadi.

### Bundle qayerda saqlanadi va nega shifrlanadi

Bundle shu repository'dagi `deploy-builds` **pre-release**'iga asset sifatida yuklanadi (`abdusoft-blog-<sha>.tar.gz.enc` + `.sha256`, oxirgi 5 ta commit qoladi, "latest" emas). Faqat shu workflow'ning `deploy` job'i yozadi (`contents: write` faqat unda). Server uni kalitsiz yuklab oladi.

Repository ochiq bo'lgani uchun release asset'lari va Actions artifact'lari ham hamma uchun yuklab olinadi. `.next` ichida Next.js'ning har build'da yaratadigan tasodifiy kalitlari bor (masalan preview-mode id): ular ochiq bo'lsa, begona kishi header/cookie bilan ISR keshini aylanib o'tib, har so'rovda server render'ni majburlashi mumkin. Hozir bu kalit ochiq emas — pipeline bu ta'sirni **kiritmasligi** kerak. Shuning uchun bundle runner'da yig'ilgach, HECH QANDAY yuklashdan oldin (inter-job artifact ham, release ham) shifrlanadi:

```
openssl enc -aes-256-cbc -pbkdf2 -md sha256 -iter 200000 -pass file:<kalit-fayli>
```

- Parametrlar runner (OpenSSL 3.x) va server (Ubuntu 20.04 — OpenSSL 1.1.1) tomonida AYNAN bir xil. Sir tekshiruvi shifrlashdan OLDIN, ochiq matnda bajariladi.
- `-pass file:` — kalit buyruq qatoriga ham, logga ham chiqmaydi.
- CBC o'zi autentifikatsiya bermaydi: yaxlitlik shifrlangan faylning SHA-256'si bilan ta'minlanadi — u `.sha256` faylda VA SSH kanali orqali (workflow → server) keladi; server ikkalasini ham talab qiladi.
- Noto'g'ri yoki yo'q kalit serverda hech narsa tegilmasdan, aniq xabar bilan to'xtatadi (kalit fayli mavjudligi/ruxsati yuklashdan oldin, noto'g'ri kalit esa shifrdan chiqarishda tekshiriladi).
- Kalit generatsiyasi va aylantirish (rotation) — pastdagi "Bundle kaliti" bo'limida.
- Agar kelajakda shifrlash o'rniga to'liq mustaqil autentifikatsiya kerak bo'lsa, muqobil: GitHub artifact attestation + serverda `gh attestation verify` (serverga `gh` va token kerak bo'ladi).

## Xavfsizlik modeli

| Kim | Nima qila oladi | Nima qila OLMAYDI |
|---|---|---|
| **Deploy SSH kaliti oqib ketsa** | Serverga ulanib `status` ko'rish yoki `main`'dagi mavjud commit'ni, workflow yuklagan bundle bilan qayta so'rash. Hash majburiy, shuning uchun noto'g'ri hash — rad; shu commit allaqachon ishlayotgan bo'lsa — hech narsa qilmaydi (restart/backup sikli yo'q) | Shell olish, fayl o'qish/yozish, o'zboshimchalik bilan kod yuborish, port forwarding (`restrict`), `main`'da bo'lmagan commit, `--force`/`rollback` (faqat qo'lda), o'z bundle'ini yuklash |
| **Zararli pull request (fork/Dependabot ham)** | CI'da test/build ishlatish (sirlarsiz) | Deploy ishga tushirish, sirlar yoki environment'larga yetish |
| **Release'ga yozish huquqi bor, lekin SSH kalit yo'q** | Asset almashtirish | Server uni qabul qilmaydi: asset hashi SSH orqali kelgan hashga mos emas; shifrlash kalitisiz yaroqli bundle ham yasay olmaydi |
| **Ochiq repo/artifact/release'ni o'qiy olgan begona** | Shifrlangan faylni yuklab olish | Next build kalitlari yoki kodni ochiq matnda ko'rish (AES-256, kalit faqat GitHub secret va serverda) |
| **`production-build` secret'lari** (build job) | Bundle'ni shifrlash kaliti va ochiq `NEXT_PUBLIC_*` qiymatlar | SSH kalitiga yetish; build job'da `contents: read` |
| **`production` secret'lari** (deploy job) | SSH kalit, release'ga yozish | Shifrlash kalitiga yetish (build job'da) — ya'ni bundle ichini ocholmaydi |
| **`main`'ga push huquqi** | Kod `main`'ga tushadi va deploy bo'ladi (pipeline'ning maqsadi) | — (ishonch chegarasi: yuqoridagi paragraf) |

Nima uchun PR'lar yetib bora olmaydi:
1. Deploy workflow'ida `pull_request` triggeri yo'q. `workflow_run` `branches: [main]` bilan cheklangan (PR branch'lari uchun run umuman yaratilmaydi), qolgan holatlarda `gate` job faqat `event == push`, `head_branch == main`, `head_repository == shu repo` va `conclusion == success` bo'lganda davom etadi.
2. `workflow_run` va `workflow_dispatch` workflow faylini default branch'dan oladi — PR'da o'zgartirilgan `deploy.yml` hisobga olinmaydi.
3. Secret'lar environment'larda; ikkala environment faqat `main` branch'iga ochiq. Dependency kodini ishga tushiradigan `build` jobida SSH kalit yo'q, `deploy` jobida shifrlash kaliti yo'q.
4. Faqat GitHub'ning o'z action'lari (`actions/*`); SSH — oddiy `ssh`, `StrictHostKeyChecking=yes` va oldindan mahkamlangan host kalit bilan.

## Repository sozlamalari (tavsiya)

Settings → Branches → `main` uchun qoida (Rulesets yoki Branch protection):
- Require status checks to pass: **`Typecheck, lint, test, build`** va **`Deploy scripts (shellcheck, simulation)`**; "Require branches to be up to date".
- Block force pushes; block deletions.
- Ixtiyoriy, lekin tavsiya: Require a pull request before merging (hatto yolg'iz egasi uchun — CI deploy'dan oldin ishlashini kafolatlaydi); `.github/workflows/**`, `scripts/server-deploy*.sh`, `scripts/make-deploy-bundle.sh` uchun CODEOWNERS.
- Settings → Actions → General: *Workflow permissions* = "Read repository contents" (workflow'lar kerak joyida `permissions:` bilan oshiradi); "Allow GitHub Actions to create and approve pull requests" — o'chiq; *Fork pull request workflows* — "Require approval for all outside collaborators"; ruxsat etilgan action'lar: GitHub'niki + `pnpm/action-setup` (CI ishlatadi).
- Settings → Environments: `production-build` va `production` — *Deployment branches*: faqat `main`. Ixtiyoriy required reviewers faqat `production`'da.
- Akkaunt: 2FA (passkey/hardware key), ishlatilmayotgan PAT'lar va deploy key'larni o'chirish, `main`'ga yozish huquqi bor boshqa akkauntlar bo'lmasin.

## Bir martalik sozlash

> Deploy workflow `DEPLOY_ENABLED` repository variable'i `true` bo'lmaguncha **o'tkazib yuboriladi** (muvaffaqiyat bilan, xatosiz). PR'ni merge qilish bundan oldin hech narsani o'zgartirmaydi. `DEPLOY_ENABLED`'ni eng OXIRIDA yoqing.

### A. Mac'da: kalitlarni yaratish (private kalitlar serverda yaratilMAYDI)

```bash
umask 077
mkdir -p ~/abdusoft-deploy-keys && cd ~/abdusoft-deploy-keys

# 1) SSH deploy kalit juftligi (parolsiz, faqat shu maqsad uchun)
ssh-keygen -t ed25519 -N '' -C abdusoft-blog-deploy -f ./deploy_ssh_key
#    private: ./deploy_ssh_key  (GitHub secret'ga ketadi, serverga HECH QACHON)
#    public : ./deploy_ssh_key.pub (faqat shu serverga boradi)

# 2) Bundle shifrlash kaliti (tasodifiy, 48 bayt base64)
openssl rand -base64 48 > ./bundle.key
```

### B. Serverda (`abdusoft` foydalanuvchisi; boshqa saytlarga tegilmaydi)

Boshlashdan oldin **ikkinchi SSH sessiyani ochiq qoldiring** — `authorized_keys`'ni buzib qo'ysangiz, o'sha orqali tuzatasiz.

```bash
# 1) Manba clone (ommaviy repo, HTTPS, kalitsiz) va ishchi papkalar
git clone https://github.com/AbduazizBobomalikovNode/abdusoft-blog.git /home/abdusoft/abdusoft-blog-src
mkdir -p /home/abdusoft/bin /home/abdusoft/abdusoft-blog-deploy
install -d -m 700 /home/abdusoft/.config/abdusoft-blog-deploy

# 2) Kirish wrapper'i — live daraxtdan TASHQARIDA (deploy uni hech qachon qayta yozmaydi)
install -m 755 /home/abdusoft/abdusoft-blog-src/scripts/server-deploy-entry.sh \
  /home/abdusoft/bin/abdusoft-blog-deploy-entry
```

Mac'dan (bir qator) bundle kalitini serverga fayl sifatida qo'ying — buyruq qatoriga yozilmaydi:

```bash
ssh abdusoft@<HOST> 'umask 077; cat > ~/.config/abdusoft-blog-deploy/bundle.key' < ~/abdusoft-deploy-keys/bundle.key
```

Public SSH kalitni `authorized_keys`'ga qo'shing (zaxira nusxa bilan; oldingi satr oxirida yangi qator bo'lmasa ham qo'shilib ketmasligi uchun avval `\n`):

```bash
# serverda
cp ~/.ssh/authorized_keys ~/.ssh/authorized_keys.bak.$(date +%F)
printf '\n%s\n' 'restrict,command="/home/abdusoft/bin/abdusoft-blog-deploy-entry" <PUBLIC_KEY> abdusoft-blog-deploy' \
  >> ~/.ssh/authorized_keys
# <PUBLIC_KEY> o'rniga deploy_ssh_key.pub faylidagi "ssh-ed25519 AAAA..." qismini qo'ying
```

Tekshirish (ikkinchi sessiyani yopmasdan; Mac'dan):

```bash
ssh -i ~/abdusoft-deploy-keys/deploy_ssh_key -o IdentitiesOnly=yes abdusoft@<HOST> status   # holat chiqadi
ssh -i ~/abdusoft-deploy-keys/deploy_ssh_key -o IdentitiesOnly=yes abdusoft@<HOST> id        # "Rad etildi..." (shell YO'Q)
```

Talablar: serverda `git`, `rsync`, `curl`, `flock`, `timeout`, `tar`, `gzip`, `openssl`, `sha256sum`, `/opt/node-v24/bin` (node, pnpm) bor; `abdusoft` uchun parolsiz `sudo systemctl restart abdusoft-blog-api abdusoft-blog-web`. Cron backup (`scripts/backup-native.sh`) o'zgarmaydi.

Wrapper juda kam o'zgaradi. O'zgarsa (`scripts/server-deploy-entry.sh`), 2-qadamdagi `install`ni qayta ishga tushiring. Qolgan hamma mantiq (`scripts/server-deploy.sh`) har deploy'da `origin/main`'dan olinadi. Ixtiyoriy sozlamalar wrapper yonidagi `/home/abdusoft/bin/abdusoft-blog-deploy.conf` faylida (`BLOGDEPLOY_*=...`; masalan `BLOGDEPLOY_TIMEOUT_MIGRATE=600`); chaqiruvchi (SSH) muhiti hech qachon hisobga olinmaydi.

### C. GitHub (`gh` bilan, Mac'dan; `R=AbduazizBobomalikovNode/abdusoft-blog`)

**Host kalitini mahkamlash.** `DEPLOY_KNOWN_HOSTS` — serverning ochiq host kaliti; uni ishonchli yo'l bilan oling va barmoq izini o'zingizdagi `known_hosts` bilan solishtiring:

```bash
ssh-keyscan -t ed25519 <HOST> > /tmp/hk.txt            # non-22 port: ssh-keyscan -t ed25519 -p <PORT> <HOST>  (natija avtomatik "[host]:port ..." shaklida bo'ladi)
ssh-keygen -lf /tmp/hk.txt                              # shu serverdan olingan izni
ssh-keygen -F <HOST> -l                                 # Mac'dagi ~/.ssh/known_hosts'dagi iz (non-22: ssh-keygen -F '[<HOST>]:<PORT>' -l)
```
Ikkala SHA256 iz bir xil bo'lishi shart. Serverda ham tekshirsa bo'ladi: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`.

```bash
R=AbduazizBobomalikovNode/abdusoft-blog

# 1) Ikkita environment, ikkalasi ham faqat main branch'iga ochiq (reviewer'siz)
for ENV in production-build production; do
  gh api -X PUT repos/$R/environments/$ENV \
    -F 'deployment_branch_policy[protected_branches]=false' \
    -F 'deployment_branch_policy[custom_branch_policies]=true'
  gh api -X POST repos/$R/environments/$ENV/deployment-branch-policies -f name=main -f type=branch
done
# (ixtiyoriy) majburiy tasdiqlovchi FAQAT `production`ga: PUT'ga  -f 'reviewers[][type]=User' -F 'reviewers[][id]=<USER_ID>'  qo'shing.
#  Build job'da reviewer yo'q, shuning uchun tasdiq faqat BIR marta so'raladi.

# 2) production-build: ochiq build qiymatlari (sir EMAS) + shifrlash kaliti
gh variable set NEXT_PUBLIC_API_URL   --env production-build --repo $R --body 'https://api.abdusoft.uz'
gh variable set NEXT_PUBLIC_SITE_URL  --env production-build --repo $R --body 'https://blog.abdusoft.uz'
gh variable set NEXT_PUBLIC_SITE_NAME --env production-build --repo $R --body 'abdusoft'
# Serverdagi apps/web/.env.production'dagi QOLGAN NEXT_PUBLIC_* qiymatlar ham (bo'sh qoldirilsa, mos funksiya o'chadi):
gh variable set NEXT_PUBLIC_GITHUB_LOGIN       --env production-build --repo $R --body '<qiymat>'
gh variable set NEXT_PUBLIC_TURNSTILE_SITE_KEY --env production-build --repo $R --body '<qiymat>'
gh variable set NEXT_PUBLIC_UMAMI_SCRIPT_URL   --env production-build --repo $R --body '<qiymat>'
gh variable set NEXT_PUBLIC_UMAMI_WEBSITE_ID   --env production-build --repo $R --body '<qiymat>'
gh variable set NEXT_PUBLIC_TELEGRAM_URL       --env production-build --repo $R --body '<qiymat>'
gh variable set NEXT_PUBLIC_GITHUB_URL         --env production-build --repo $R --body '<qiymat>'
gh secret   set DEPLOY_BUNDLE_KEY --env production-build --repo $R < ~/abdusoft-deploy-keys/bundle.key

# 3) production: server manzili + SSH kalit
gh variable set DEPLOY_HOST        --env production --repo $R --body '<HOST>'
gh variable set DEPLOY_USER        --env production --repo $R --body 'abdusoft'
gh variable set DEPLOY_PORT        --env production --repo $R --body '22'
gh variable set DEPLOY_KNOWN_HOSTS --env production --repo $R --body "$(cat /tmp/hk.txt)"
gh variable set DEPLOY_SITE_URL    --env production --repo $R --body 'https://blog.abdusoft.uz'   # ixtiyoriy, faqat tashqi ogohlantirish
gh secret   set DEPLOY_SSH_KEY --env production --repo $R < ~/abdusoft-deploy-keys/deploy_ssh_key
```

Keyin Mac'dagi **private** fayllarni o'chiring (GitHub'dagi secret'lar va serverdagi `bundle.key` qoladi; zaxira kerak bo'lsa parol menejerida saqlang):

```bash
rm -P ~/abdusoft-deploy-keys/deploy_ssh_key ~/abdusoft-deploy-keys/bundle.key     # Linux'da: shred -u
```

Oxirida, hammasi tayyor bo'lgach (birinchi ishga tushirish ro'yxatiga qarang):

```bash
gh variable set DEPLOY_ENABLED --repo $R --body 'true'      # repository darajasidagi variable
```

| Nom | Turi | Environment / joy | Ma'nosi |
|---|---|---|---|
| `DEPLOY_ENABLED` | variable | repository | `true` bo'lsagina deploy ishlaydi; aks holda workflow toza o'tkazib yuboriladi |
| `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_SITE_NAME` | variable | `production-build` | Majburiy; bundle ichiga build vaqtida yoziladi |
| `NEXT_PUBLIC_TELEGRAM_URL`, `_GITHUB_URL`, `_TURNSTILE_SITE_KEY`, `_GITHUB_LOGIN`, `_UMAMI_SCRIPT_URL`, `_UMAMI_WEBSITE_ID` | variable | `production-build` | Ixtiyoriy ochiq qiymatlar (serverdagi `.env.production` bilan bir xil bo'lsin; farq bo'lsa deploy chiqishida ogohlantirish chiqadi) |
| `DEPLOY_BUNDLE_KEY` | **secret** | `production-build` | Bundle shifrlash kaliti (serverdagi `bundle.key` bilan bir xil) |
| `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PORT` | variable | `production` | SSH manzili (port ixtiyoriy, default 22) |
| `DEPLOY_KNOWN_HOSTS` | variable | `production` | Server host kaliti (`ssh-keyscan` satri); `StrictHostKeyChecking=yes` shu bilan ishlaydi |
| `DEPLOY_SSH_KEY` | **secret** | `production` | Deploy shaxsiy kaliti (serverda `restrict,command=` bilan cheklangan) |
| `DEPLOY_SITE_URL` | variable | `production` | Ixtiyoriy: deploy'dan keyin tashqi ogohlantirish tekshiruvi |

Serverdagi fayllar: `/home/abdusoft/abdusoft-blog-src` (clone), `/home/abdusoft/bin/abdusoft-blog-deploy-entry` (wrapper, 755), `/home/abdusoft/.config/abdusoft-blog-deploy/bundle.key` (600), `authorized_keys` satri; holat va log — `/home/abdusoft/abdusoft-blog-deploy/` (wrapper o'zi yaratadi).

Sir EMAS va build vaqtida kerak EMAS: `REVALIDATE_SECRET` (faqat runtime, serverdagi `.env.production`da qoladi), `apps/api/.env`dagi hamma narsa (serverda qoladi).

### Bundle kaliti: generatsiya va aylantirish

Generatsiya — yuqorida (A. 2). Aylantirish (rotation), masalan har yili yoki shubha tug'ilganda:
1. Deploy to'xtab turganini tekshiring (`gh variable set DEPLOY_ENABLED --body false`, ishlayotgan run yo'qligiga ishonch hosil qiling).
2. Mac'da yangi kalit: `openssl rand -base64 48 > bundle.key`.
3. Serverda faylni almashtiring (`ssh abdusoft@<HOST> 'umask 077; cat > ~/.config/abdusoft-blog-deploy/bundle.key' < bundle.key`) va secret'ni yangilang (`gh secret set DEPLOY_BUNDLE_KEY --env production-build --repo $R < bundle.key`).
4. Mac'dagi faylni o'chiring; `DEPLOY_ENABLED=true`; Actions'da *Run workflow* bilan sinang. Eski kalit bilan shifrlangan release asset'lari yaroqsiz bo'ladi — ular baribir qayta quriladi.

### Birinchi ishga tushirish ro'yxati

- [ ] PR merge qilindi (hech narsa o'zgarmadi — `DEPLOY_ENABLED` hali yo'q).
- [ ] Production API ochiq GET'lari 200 qaytarishini tekshiring: `/health`, `/site`, `/tags`, `/posts?page=1&limit=50`, `/posts/feed` (build ularni preflight qiladi; biri 200 bo'lmasa build to'xtaydi).
- [ ] Serverdagi `apps/web/.env.production`dagi barcha `NEXT_PUBLIC_*` qiymatlar `production-build` variables'da bor.
- [ ] Server sozlandi (B), `status` va `id` sinovlari o'tdi, ikkinchi SSH sessiya ochiq.
- [ ] GitHub environment'lar, variables va secret'lar yaratildi (C); `gh variable list --env production-build` va `--env production` bilan tekshirildi.
- [ ] Qo'lda zaxira: serverda `./scripts/backup-native.sh` (to'liq) bajarilgan; joriy ishlayotgan build `deploy-vds.sh` bilan qayta yig'ish mumkinligi ma'lum.
- [ ] Tinch vaqtni tanlang. `DEPLOY_ENABLED=true` qo'ying, so'ng Actions → Deploy → *Run workflow* (`sha` bo'sh). Serverda `journalctl -fu abdusoft-blog-web -u abdusoft-blog-api` va ikkinchi terminalda `status` kuzatib turing.
- [ ] Muvaffaqiyatdan keyin saytni (bosh sahifa, bitta post, `/rss.xml`, `/sitemap.xml`, admin kirish) qo'lda tekshiring. Avvalgi (qo'lda yig'ilgan) build `*.prev`'da turibdi — zudlik bilan `rollback` mumkin.
- [ ] Faqat shundan keyin push'ga ishoning.

### To'xtatish (abort) tartibi

- **Yangi deploy'larni to'xtatish:** `gh variable set DEPLOY_ENABLED --repo $R --body false` (yoki `gh variable delete DEPLOY_ENABLED`). Keyingi run'lar `gate`da toza o'tkazib yuboriladi.
- **Ishlayotgan run'ni "Cancel" qilish nimani to'xtatadi va nimani yo'q:** runner tomonini (build/yuklash) to'xtatadi. Agar SSH bosqichi allaqachon boshlangan bo'lsa, server skripti SSH uzilishiga (HUP/PIPE) e'tibor bermaydi va deploy'ni oxirigacha (muvaffaqiyat yoki avtomatik rollback) yetkazadi — ya'ni Cancel serverdagi jarayonni to'xtatmaydi. Natijani `abdusoft-blog-deploy-entry status` va `deploy.log`dan ko'ring. Skriptni majburan o'ldirish (`pkill -f abdusoft-blog-deploy`) mumkin, lekin yarim holat qoladi — keyingi so'rov uni avtomatik tiklaydi.
- **Zudlik bilan orqaga qaytish:** serverda `/home/abdusoft/bin/abdusoft-blog-deploy-entry rollback` (bitta qadam, `*.prev`'ga). Yoki Actions → *Run workflow* → `sha` = eski commit. Oxirgi chora — `./scripts/deploy-vds.sh` (Mac'dan).
- **Kirishni butunlay yopish:** `authorized_keys`'dan `abdusoft-blog-deploy` satrini o'chiring; GitHub'da `DEPLOY_SSH_KEY` secret'ini o'chiring.

## Foydalanish

- **Avtomatik:** `main`'ga merge/push -> CI -> Deploy. Natija Actions logida (serverning qadam-baqadam chiqishi shu yerda).
- **Qo'lda deploy / rollback (eski commit):** Actions → Deploy → *Run workflow*, `sha` maydoniga `main`'dagi istalgan commit SHA'sini yozing (bo'sh = main oxirgi commit'i). Workflow uni qayta build qiladi va deploy qiladi.
- **Shu commit'ni majburan qayta deploy** (masalan live buzilgan bo'lsa): faqat serverda qo'lda — `/home/abdusoft/bin/abdusoft-blog-deploy-entry --force <sha> <bundle-sha256>` (hash Actions logida/`.sha256` faylida). SSH kaliti `--force`ni bajara olmaydi.
- **Zudlik bilan rollback (qayta build'siz):** serverda `/home/abdusoft/bin/abdusoft-blog-deploy-entry rollback` (faqat qo'lda). Bitta qadamga qaytadi (`*.prev` + `src.prev`).
- **Holat:** `/home/abdusoft/bin/abdusoft-blog-deploy-entry status` — hozirgi commit, vaqt, oldingi commit, oxirgi natija, xizmatlar. Hech narsani o'zgartirmaydi. Deploy kaliti bilan: `ssh -i KEY abdusoft@HOST status`.
- **Log:** `/home/abdusoft/abdusoft-blog-deploy/deploy.log` (vaqt belgisi bilan, 2 MB'da aylantiriladi), holat: `.../state`.

## Qo'lda zaxira yo'l

`./scripts/deploy-vds.sh` (Mac'dan, rsync + serverda build) o'zgarmagan. Eslatma: u CD holat faylini yangilamaydi, `*.prev` papkalarni o'chiradi (keyingi deploy'gacha zudlik bilan rollback mavjud bo'lmaydi) va live `.next`ni almashtiradi — keyingi pipeline deploy buni BUILD_ID farqidan aniqlaydi, ogohlantiradi va "oldingi commit noma'lum" deb davom etadi (qo'lda deploy qilingan manbani eski commit bilan ustiga yozmaydi). Ikki yo'lni bir vaqtda ishga tushirmang.

## Nosozliklar va nima qilish kerak

| Alomat | Sabab | Nima qilish |
|---|---|---|
| Workflow "o'tkazib yuborildi" notice | `DEPLOY_ENABLED` yo'q / CI muvaffaqiyatsiz / PR | Kutilgan; sozlash yuqorida |
| `build`: "API javob bermadi" | Production API `/health`, `/site`, `/tags`, `/posts...` ga 200 bermadi | API'ni tekshiring (`systemctl status abdusoft-blog-api`); keyin Re-run. Bo'sh sahifalar deploy QILINMAYDI |
| `build`: sir/`.env` topildi | Bundle ichida sirga o'xshash qiymat | Natijani tekshiring; deploy to'xtaydi |
| `build`: `DEPLOY_BUNDLE_KEY` yo'q | Secret `production-build`da sozlanmagan | C bo'limi |
| SSH: host key verification failed | `DEPLOY_KNOWN_HOSTS` mos emas (server almashgan/MITM) | Barmoq izini qo'lda solishtirib, variable'ni yangilang |
| "Rad etildi: faqat '<sha> <sha256>'..." (kod 64) | Wrapper kutilmagan argument oldi (hash'siz SHA ham) | Workflow doim ikkalasini yuboradi; qo'lda yuborsangiz formatni tekshiring |
| "boshqa deploy hozir ishlayapti" (kod 3) | Lock band | Tugashini kuting; `status`/`deploy.log` |
| "allaqachon deploy qilingan ... hech narsa qilinmadi" (kod 0) | Shu commit ishlayapti (no-op) | Majburan kerak bo'lsa — qo'lda `--force` |
| "Bundle shifrlash kaliti topilmadi / ruxsati ..." | Server kalit fayli yo'q yoki 600 emas | `chmod 600 ~/.config/abdusoft-blog-deploy/bundle.key`; fayl mavjudligi (B bo'limi). Sayt tegilmagan |
| "Shifrdan chiqarib bo'lmadi — kalit noto'g'ri" | Server va GitHub kalitlari farq qiladi / bundle buzilgan | Kalitlarni solishtiring (rotation tartibi); sayt tegilmagan |
| "Diskda bo'sh joy yetarli emas" | `MIN_FREE_MB`dan kam | Disk tozalang (eski `blog_predeploy_*`/zaxiralar); sayt tegilmagan |
| "Checksum mos kelmadi" / "Manifest ..." / "Arxiv ..." | Bundle buzilgan/almashtirilgan yoki boshqa commit | Sayt tegilmagan. Workflow'ni qayta ishga tushiring (bundle qayta yig'iladi) |
| "Next.js versiyasi mos emas" | Server `node_modules` versiyasi bundle'ga teng emas | Sayt tegilmagan (manba qaytariladi); lockfile'ni tekshiring |
| "FARQ QILADI: NEXT_PUBLIC_..." (ogohlantirish) | `production-build` variables serverdagi `.env.production`dan farq qiladi | Deploy davom etadi; kerak bo'lsa variables'ni tuzating va qayta deploy qiling |
| `pnpm fetch`/`install` xatosi yoki timeout | Tarmoq/lockfile/osilib qoldi | Sayt eski build bilan ishlayapti; manba snapshot'dan qaytarilgan; log'ni ko'ring, qayta urining |
| Migratsiya xatosi yoki timeout | SQL xatosi | Build almashtirilmagan, eski sayt ishlayapti; zaxira `/home/abdusoft/backups/abdusoft-blog/blog_predeploy_*`; migratsiyani tuzatib yangi commit |
| "DEPLOY MUVAFFAQIYATSIZ ... qaytarildi" (kod 1) | Yangi build health check'dan o'tmadi (yangi BUILD_ID yoki baza endpointi); avtomatik qaytarildi | Sayt oldingi versiyada. Sabab: log/`journalctl -u abdusoft-blog-web`. DB migratsiyalari qaytarilMAGAN (additive) |
| "ORQAGA QAYTARISH HAM MUVAFFAQIYATSIZ" (kod 2) | Ikkala versiya ham ko'tarilmadi | Qo'lda aralashuv: `journalctl -u abdusoft-blog-api -u abdusoft-blog-web`, keyin `./scripts/deploy-vds.sh` |
| "oldingi deploy yarim qolgan ... tiklandi" (kod 1) | Oldingi run o'ldirilgan edi | Avtomatik tiklandi; so'rovni qayta yuboring. "*.prev yo'q" (kod 2) bo'lsa — qo'lda: `deploy-vds.sh` |
| SSH uzilib qoldi | Tarmoq | Server skripti HUP/PIPE'ni e'tiborsiz qoldiradi va oxiriga yetkazadi; natijani `status`/log'dan ko'ring |

## Sinov

`./scripts/tests/server-deploy-sim.sh` — haqiqiy serversiz lokal simulyatsiya (vaqtinchalik papkalar, lokal bare git repo, `sudo/systemctl/pnpm/curl/flock/timeout/backup` shim'lari; arxiv, shifrlash, rsync va git haqiqiy). CI'da ham ishlaydi (`deploy-scripts` job, GNU tar/openssl bilan). Qamrab oladi: muvaffaqiyatli deploy; majburiy hash va in'ektsiya urinishlari; shu commit uchun no-op va `--force` cheklovi; main'da bo'lmagan SHA; kalit fayli yo'q/ruxsati noto'g'ri/noto'g'ri kalit; yuklash/checksum/manifest/lockfile/Node/Next nomuvofiqligi; zararli arxivlar (traversal, absolyut yo'l, symlink, hardlink, FIFO, qurilma, juda ko'p yozuv, juda katta); `pnpm fetch`/install/backup/migratsiya xatosi va timeout; disk to'lishi; swap yarim yiqilishi; health xatosi (eski build xizmat qilyapti, baza ishlamayapti) → avtomatik rollback; rollback ham yiqilsa; lock; zudlik bilan rollback; drift (pipeline → qo'lda deploy → pipeline); SIGKILL har bosqichda va swap o'rtasida; ochiq config farqi ogohlantirishi; log aylantirish; runner bundle skripti va sir tekshiruvi; `backup-native.sh --db-only`.

Simulyatsiya qila OLMAYDI: haqiqiy `systemd`, `sshd` (`restrict`/forced-command), GitHub release/artifact yuklashlari, serverdagi haqiqiy `pnpm`/`next start`/xotira cheklovlari, OpenSSL 1.1.1 (faqat 3.6/4.0/LibreSSL 3.3 o'zaro tekshirilgan) — birinchi haqiqiy deploy shuni tekshiradi.

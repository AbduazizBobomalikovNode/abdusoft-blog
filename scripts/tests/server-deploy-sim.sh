#!/bin/bash
# scripts/server-deploy-entry.sh + scripts/server-deploy.sh (+ make-deploy-bundle.sh,
# backup-native.sh --db-only) uchun lokal simulyatsiya: vaqtinchalik papkalar
# live/source o'rniga, lokal bare git repo "GitHub" o'rniga, PATH shim'lar
# sudo/systemctl/pnpm/curl/flock/timeout/backup o'rniga. Haqiqiy server, tarmoq va
# systemd KERAK EMAS. Arxiv/kripto tekshiruvlari haqiqiy tar/openssl bilan.
#
#   ./scripts/tests/server-deploy-sim.sh
#
# Chiqish kodi 0 — hamma tekshiruv o'tdi.
# shellcheck disable=SC2030,SC2031
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export COPYFILE_DISABLE=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=sim GIT_AUTHOR_EMAIL=sim@example.invalid GIT_COMMITTER_NAME=sim GIT_COMMITTER_EMAIL=sim@example.invalid

SIM="$(mktemp -d "${TMPDIR:-/tmp}/blog-deploy-sim.XXXXXX")"
trap 'rm -rf "$SIM"' EXIT
LIVE="$SIM/live" SRC="$SIM/src" STATE="$SIM/state" SHIMS="$SIM/shims" CTL="$SIM/ctl" REL="$SIM/release"
CALLS="$SIM/calls.log"
KEY="$SIM/server.key" # serverdagi kalit fayli
mkdir -p "$LIVE" "$STATE" "$SHIMS" "$CTL" "$REL"
: >"$CALLS"
openssl rand -base64 48 >"$SIM/bundle.key" # runner kaliti (secret)
cp "$SIM/bundle.key" "$KEY"
chmod 600 "$KEY" "$SIM/bundle.key"
openssl rand -base64 48 >"$SIM/wrong.key"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "  ok   - $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }
check() { # check <nom> <buyruq...>
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi
}
contains() { [[ "$1" == *"$2"* ]]; }
section() { echo; echo "## $*"; }

# ---------------------------------------------------------------- shim'lar
cat >"$SHIMS/killparent" <<'EOF'
#!/bin/bash
# deploy skriptini (abdusoft-blog-deploy.XXXXXX) SIGKILL qiladi — o'ldirilgan jarayonni simulyatsiya.
p=$$
while [ "$p" -gt 1 ]; do
  cmd="$(ps -o command= -p "$p" 2>/dev/null)"
  case "$cmd" in
    *abdusoft-blog-deploy.*) kill -9 "$p"; exit 0 ;;
  esac
  p="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"
  [ -n "$p" ] || exit 0
done
EOF
cat >"$SHIMS/sudo" <<EOF
#!/bin/bash
[ "\${1:-}" = "-n" ] && shift
exec "\$@"
EOF
cat >"$SHIMS/systemctl" <<EOF
#!/bin/bash
case "\$1" in
  is-active) echo active ;;
  restart)
    echo "restart \${*:2} build=\$(cat "$LIVE/apps/web/.next/BUILD_ID" 2>/dev/null)" >>"$CALLS"
    [ -e "$CTL/kill_restart" ] && { "$SHIMS/killparent"; exit 137; }
    [ -e "$CTL/fail_restart" ] && exit 1
    exit 0 ;;
esac
EOF
cat >"$SHIMS/pnpm" <<EOF
#!/bin/bash
case "\$1" in
  fetch)
    echo "pnpm fetch" >>"$CALLS"
    [ -e "$CTL/fail_fetch" ] && { echo "ERR_PNPM_FAKE fetch failed"; exit 1; }
    exit 0 ;;
  install)
    echo "pnpm install \${*:2} lock=\$(cat pnpm-lock.yaml | cksum | cut -d' ' -f1)" >>"$CALLS"
    [ -e "$CTL/kill_install" ] && { "$SHIMS/killparent"; exit 137; }
    [ -e "$CTL/hang_install" ] && exec sleep 30
    [ -e "$CTL/fail_install" ] && { echo "ERR_PNPM_FAKE install failed"; exit 1; }
    if [[ " \$* " == *" --offline "* ]] && [ -e "$CTL/fail_install_offline" ]; then echo "ERR_PNPM_OFFLINE_FAKE"; exit 1; fi
    mkdir -p apps/web/node_modules/next node_modules
    printf '{"version":"%s"}' "\$(cat "$CTL/next_version" 2>/dev/null || echo 16.4.5)" >apps/web/node_modules/next/package.json
    exit 0 ;;
  api:migrate)
    echo "migrate" >>"$CALLS"
    [ -e "$CTL/kill_migrate" ] && { "$SHIMS/killparent"; exit 137; }
    [ -e "$CTL/hang_migrate" ] && exec sleep 30
    [ -e "$CTL/sabotage_new" ] && rm -rf "$LIVE/packages/shared/dist.new"
    [ -e "$CTL/fail_migrate" ] && { echo "migrate failed"; exit 1; }
    exit 0 ;;
esac
echo "kutilmagan pnpm chaqiruvi: \$*" >&2
exit 99
EOF
cat >"$SHIMS/curl" <<EOF
#!/bin/bash
out=""
url=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    -o) out="\$2"; shift 2 ;;
    http*) url="\$1"; shift ;;
    *) shift ;;
  esac
done
live_bid="\$(cat "$LIVE/apps/web/.next/BUILD_ID" 2>/dev/null)"
case "\$url" in
  https://dl.test/*)
    echo "download \${url##*/}" >>"$CALLS"
    [ -e "$CTL/dl_fail" ] && exit 22
    [ -f "$REL/\${url##*/}" ] || exit 22
    cp "$REL/\${url##*/}" "\$out" ;;
  http://127.0.0.1:4000/health|http://127.0.0.1:4000/tags|http://127.0.0.1:3100/|http://127.0.0.1:3100/_next/static/*)
    echo "health \$url" >>"$CALLS"
    [ -e "$CTL/kill_health" ] && { "$SHIMS/killparent"; exit 137; }
    [ -e "$CTL/health_always_fail" ] && exit 22
    [ "\$url" = "http://127.0.0.1:4000/tags" ] && [ -f "$CTL/db_down" ] && [ "\$(cat "$CTL/db_down")" = "\$live_bid" ] && exit 22
    if [ -f "$CTL/bad_build" ] && [ "\$(cat "$CTL/bad_build")" = "\$live_bid" ]; then exit 22; fi
    case "\$url" in
      */_next/static/*)
        id="\${url#*/_next/static/}"; id="\${id%%/*}"
        # eski jarayon hali eski build'ni xizmat qilyapti: serving_build fayli bor bo'lsa, faqat shu id javob beradi
        if [ -f "$CTL/serving_build" ]; then [ "\$id" = "\$(cat "$CTL/serving_build")" ] || exit 22; fi
        [ "\$id" = "\$live_bid" ] || exit 22 ;;
    esac
    exit 0 ;;
  *) echo "kutilmagan curl URL: \$url" >&2; exit 99 ;;
esac
EOF
cat >"$SHIMS/fake-backup.sh" <<EOF
#!/bin/bash
echo "backup \$*" >>"$CALLS"
[ -e "$CTL/hang_backup" ] && exec sleep 30
[ -e "$CTL/fail_backup" ] && exit 1
exit 0
EOF
if ! command -v flock >/dev/null 2>&1; then
  # macOS'da flock yo'q: fd 9'ni (meros olingan open file description) python bilan qulflaymiz.
  cat >"$SHIMS/flock" <<'EOF'
#!/bin/bash
exec /usr/bin/python3 -c 'import fcntl,sys; fcntl.flock(9, fcntl.LOCK_EX|fcntl.LOCK_NB)' || exit 1
EOF
fi
if ! command -v timeout >/dev/null 2>&1; then
  cat >"$SHIMS/timeout" <<'EOF'
#!/bin/bash
# GNU timeout o'rnini bosuvchi minimal shim: timeout [-k N] SECS cmd...
[ "$1" = "-k" ] && shift 2
TIMEOUT_FLAG="${TMPDIR:-/tmp}/timeout-flag.$$"
secs="$1"
shift
"$@" &
pid=$!
( i=0
  while [ "$i" -lt "$secs" ]; do
    sleep 1
    i=$((i + 1))
    kill -0 "$pid" 2>/dev/null || exit 0
  done
  touch "$TIMEOUT_FLAG"
  kill -TERM "$pid" 2>/dev/null
  sleep 1
  kill -KILL "$pid" 2>/dev/null ) >/dev/null 2>&1 9>&- &
wait "$pid"
rc=$?
if [ -e "$TIMEOUT_FLAG" ]; then rc=124; fi
rm -f "$TIMEOUT_FLAG"
exit "$rc"
EOF
fi
ln -sf "$(command -v node)" "$SHIMS/node"
chmod +x "$SHIMS"/*

# ---------------------------------------------------- wrapper + conf (SSH tomoni)
ENTRY="$SIM/bin/abdusoft-blog-deploy-entry"
CONF="$SIM/bin/abdusoft-blog-deploy.conf"
mkdir -p "$SIM/bin"
cp "$REPO_ROOT/scripts/server-deploy-entry.sh" "$ENTRY"
cat >"$CONF" <<EOF
BLOGDEPLOY_LIVE_DIR="$LIVE"
BLOGDEPLOY_SRC_DIR="$SRC"
BLOGDEPLOY_STATE_DIR="$STATE"
BLOGDEPLOY_NODE_BIN="$SHIMS"
BLOGDEPLOY_REPO_URL="file://$SIM/remote.git"
BLOGDEPLOY_RELEASE_BASE_URL="https://dl.test"
BLOGDEPLOY_BUNDLE_KEY_FILE="$KEY"
BLOGDEPLOY_BACKUP_SCRIPT="$SHIMS/fake-backup.sh"
BLOGDEPLOY_HEALTH_TRIES=2
BLOGDEPLOY_HEALTH_INTERVAL=0
BLOGDEPLOY_TIMEOUT_INSTALL=3
BLOGDEPLOY_TIMEOUT_BACKUP=3
BLOGDEPLOY_TIMEOUT_MIGRATE=3
BLOGDEPLOY_MAX_ENTRIES=500
BLOGDEPLOY_MAX_UNCOMPRESSED_BYTES=5000000
BLOGDEPLOY_MIN_FREE_MB=1
EOF
cp "$CONF" "$CONF.base"
conf_set() { echo "$1=$2" >>"$CONF"; }
conf_reset() { cp "$CONF.base" "$CONF"; }

# forced(): SSH forced-command yo'li (SSH_ORIGINAL_COMMAND). Natija: $OUT, $RC
forced() {
  OUT="$(SSH_ORIGINAL_COMMAND="$1" bash "$ENTRY" 2>&1)"
  RC=$?
}
manual() {
  OUT="$(env -u SSH_ORIGINAL_COMMAND bash "$ENTRY" "$@" 2>&1)"
  RC=$?
}

# ------------------------------------------------------------ git "remote"
git init -q --bare -b main "$SIM/remote.git"
git init -q -b main "$SIM/work"
commit() { # commit <fayl-mazmuni-belgisi> -> SHA (main'da)
  (
    cd "$SIM/work" || exit 1
    mkdir -p scripts apps/web apps/api packages/shared
    echo "{}" >apps/web/package.json
    echo "{}" >apps/api/package.json
    echo "{}" >packages/shared/package.json
    echo "{\"name\":\"blog\",\"rev\":\"$1\"}" >package.json
    echo "lock-$1" >pnpm-lock.yaml
    echo "# backup" >scripts/backup-native.sh
    cp "$REPO_ROOT/scripts/server-deploy.sh" scripts/server-deploy.sh
    git add -A >/dev/null
    git commit -q -m "c$1"
    git rev-parse HEAD
  )
}
C1="$(commit 1)"
C2="$(commit 2)"
C3="$(commit 3)"
C4="$(commit 4)"
(cd "$SIM/work" && git remote add origin "file://$SIM/remote.git" && git push -q origin main)
(cd "$SIM/work" && git checkout -q -b feature && echo x >feature.txt && git add feature.txt && git commit -q -m feature)
CX="$(cd "$SIM/work" && git rev-parse HEAD)"
(cd "$SIM/work" && git push -q origin feature && git checkout -q main)

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1
}
lockhash() { (cd "$SIM/work" && git show "$1:pnpm-lock.yaml" | sha256_stdin); }
sha256f() { sha256_stdin <"$1"; }
ENCOPTS=(-aes-256-cbc -pbkdf2 -md sha256 -iter 200000)
PUB_ENV_JSON='{"NEXT_PUBLIC_SITE_NAME":"abdusoft"}'

# enc_publish <sha> <ochiq.tar.gz> [kalit-fayli] — shifrlab release papkasiga qo'yadi (+ .sha256 shifrlangan fayl uchun)
enc_publish() {
  local sha="$1" plain="$2" keyf="${3:-$SIM/bundle.key}"
  openssl enc "${ENCOPTS[@]}" -pass "file:$keyf" -in "$plain" -out "$REL/abdusoft-blog-$sha.tar.gz.enc"
  echo "$(sha256f "$REL/abdusoft-blog-$sha.tar.gz.enc")  abdusoft-blog-$sha.tar.gz.enc" >"$REL/abdusoft-blog-$sha.tar.gz.enc.sha256"
}
# make_bundle <sha> <build-id> [manifest-commit] [lock-hash] [next-version] [node-major] [kalit-fayli]
make_bundle() {
  local sha="$1" bid="$2" mc="${3:-$1}" lh="${4:-$(lockhash "$1")}" nv="${5:-16.4.5}" nm="${6:-$(node -p 'process.versions.node.split(".")[0]')}" keyf="${7:-$SIM/bundle.key}"
  local st="$SIM/stage.$sha.$bid"
  rm -rf "$st"
  mkdir -p "$st/apps/web/.next/server" "$st/apps/api/dist/src" "$st/packages/shared/dist"
  echo "$bid" >"$st/apps/web/.next/BUILD_ID"
  echo "web-$bid" >"$st/apps/web/.next/server/app.js"
  echo "api-$bid" >"$st/apps/api/dist/src/index.js"
  echo "shared-$bid" >"$st/packages/shared/dist/index.js"
  printf '{"format":2,"commit":"%s","node_major":"%s","next_version":"%s","lockfile_sha256":"%s","public_env":%s,"public_env_sha256":"x","built_at":"x"}\n' "$mc" "$nm" "$nv" "$lh" "$PUB_ENV_JSON" >"$st/MANIFEST.json"
  tar -czf "$SIM/plain.tgz" -C "$st" MANIFEST.json apps packages
  enc_publish "$sha" "$SIM/plain.tgz" "$keyf"
  rm -rf "$st" "$SIM/plain.tgz"
}
bundle_hash() { cut -d' ' -f1 <"$REL/abdusoft-blog-$1.tar.gz.enc.sha256"; }
req() { echo "$1 $(bundle_hash "$1")"; } # forced-command so'rovi: "<sha> <hash>"

reset_ctl() { rm -f "$CTL"/*; }
reset_calls() { : >"$CALLS"; }
calls_count() { grep -c "$1" "$CALLS" || true; }
live_build() { cat "$LIVE/apps/web/.next/BUILD_ID" 2>/dev/null; }
state_get() { grep -m1 "^$1=" "$STATE/state" 2>/dev/null | cut -d= -f2-; }
set_state() { # set_state k v
  local tmp="$STATE/state.t"
  { grep -v "^$1=" "$STATE/state" 2>/dev/null || true; echo "$1=$2"; } >"$tmp"
  mv "$tmp" "$STATE/state"
}
live_rev() { node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).rev' "$LIVE/package.json" 2>/dev/null; }
baseline() { # baseline <sha>: qo'lda --force bilan toza deploy
  reset_ctl
  manual --force "$(req "$1")"
  [ "$RC" -eq 0 ] || echo "  (baseline $1 muvaffaqiyatsiz: $RC)" >&2
}

# -------------------------------------------------- "live" boshlang'ich holat
mkdir -p "$LIVE/apps/web/.next" "$LIVE/apps/api/dist/src" "$LIVE/packages/shared/dist" "$LIVE/apps/api/.data/uploads" "$LIVE/node_modules/keep" "$LIVE/scripts"
echo manual-old >"$LIVE/apps/web/.next/BUILD_ID"
echo old >"$LIVE/apps/api/dist/src/index.js"
echo old >"$LIVE/packages/shared/dist/index.js"
echo "SECRET=do-not-touch" >"$LIVE/apps/api/.env"
echo "NEXT_PUBLIC_SITE_NAME=abdusoft" >"$LIVE/apps/web/.env.production"
echo upload >"$LIVE/apps/api/.data/uploads/a.jpg"
echo "stray-file" >"$LIVE/stray.txt"
git clone -q "file://$SIM/remote.git" "$SRC"
git -C "$SRC" fetch -q origin feature # CX lokal mavjud, lekin main'da emas

make_bundle "$C1" "build-c1"
make_bundle "$C2" "build-c2"
make_bundle "$C3" "build-c3"
make_bundle "$C4" "build-c4"

# ======================================================================
section "1. Noto'g'ri argumentlar va in'ektsiya urinishlari (forced-command yo'li)"
PWN="$SIM/PWNED"
H1="$(bundle_hash "$C1")"
bad_inputs=(
  "" "foo" "deploy $C1 $H1" "status; touch $PWN" "status extra"
  "$C1" "$C1 " "${C1:0:39} $H1" "${C1}0 $H1" "$(echo "$C1" | tr a-f A-F) $H1" "${C1:0:39}g $H1"
  "$C1 ${H1:0:63}" "$C1 ${H1}0" "$C1 $(echo "$H1" | tr a-f A-F)" "$C1  $H1" "$C1 $C1"
  "$C1; touch $PWN" "$C1 && touch $PWN" "$C1 | touch $PWN" "$C1 \`touch $PWN\`" "\`touch $PWN\`" "\$(touch $PWN)"
  "$C1 \$(touch $PWN)" "$C1 $H1; touch $PWN" "$C1 $H1 && touch $PWN" "$C1 $H1\`touch $PWN\`" "$C1 \$(touch $PWN)$H1"
  "$C1 $H1 --force" "--force $C1 $H1" "--force" "$C1; rm -rf $LIVE"
  "$C1 $H1
touch $PWN" "$C1 $H1
" "
$C1 $H1" "$C1
$H1" "$C1 $H1
$C1 $H1" "rollback" "--help" "-x" "../../etc/passwd"
)
i=0
for inp in "${bad_inputs[@]}"; do
  i=$((i + 1))
  forced "$inp"
  if [ "$RC" -eq 64 ]; then ok "rad etildi #$i (kod 64)"; else bad "rad etilmadi #$i (kod $RC): $(printf %q "$inp")"; fi
done
check "hech narsa bajarilmadi (PWNED yo'q)" test ! -e "$PWN"
check "live daraxt tegilmadi" test "$(live_build)" = manual-old
check "hech qanday tashqi buyruq chaqirilmadi" test ! -s "$CALLS"
check "holat fayli yaratilmadi" test ! -e "$STATE/state"
manual "$C1"
check "qo'lda ham hash'siz SHA rad etiladi (64)" test "$RC" -eq 64
manual --force "$C1"
check "qo'lda --force ham hash'siz rad etiladi (64)" test "$RC" -eq 64

# ======================================================================
section "2. status (hech narsani o'zgartirmaydi)"
forced "status"
check "status kod 0" test "$RC" -eq 0
check "status xizmat holatini ko'rsatadi" contains "$OUT" "abdusoft-blog-api: active"
check "status 'hali deploy qilinmagan' deydi" contains "$OUT" "holat fayli hali yo'q"
check "status holat fayli yaratmadi" test ! -e "$STATE/state"
check "status log yozmadi" test ! -e "$STATE/deploy.log"

# ======================================================================
section "3. SHA main'da emas / mavjud emas; kalit fayli oldindan tekshiriladi"
forced "$CX $(printf '%064d' 0)"
check "feature commit rad etildi (kod 1)" test "$RC" -eq 1
check "sabab ko'rsatildi" contains "$OUT" "origin/main tarkibida emas"
forced "0000000000000000000000000000000000000000 $(printf '%064d' 0)"
check "mavjud bo'lmagan SHA rad etildi" test "$RC" -eq 1
check "live tegilmadi" test "$(live_build)" = manual-old
check "xizmat qayta ishga tushirilmadi" test "$(calls_count restart)" -eq 0
check "bundle yuklanmadi" test "$(calls_count download)" -eq 0
mv "$KEY" "$KEY.bak"
forced "$(req "$C1")"
check "kalit fayli yo'q: kod 1, aniq xabar" bash -c "[ $RC -eq 1 ] && [[ \"\$1\" == *'kaliti topilmadi'* ]]" _ "$OUT"
check "kalit fayli yo'q: hech narsa yuklanmadi/o'zgarmadi" bash -c "[ \$(grep -c '^download\|^pnpm' '$CALLS') -eq 0 ] && [ '$(live_build)' = manual-old ]"
mv "$KEY.bak" "$KEY"
chmod 644 "$KEY"
forced "$(req "$C1")"
check "kalit ruxsati 644: rad etildi" bash -c "[ $RC -eq 1 ] && [[ \"\$1\" == *'faqat 600'* ]]" _ "$OUT"
chmod 600 "$KEY"
check "kalit qiymati chiqishda yo'q" bash -c "! printf '%s' \"\$1\" | grep -qF \"\$(head -c 20 '$KEY')\"" _ "$OUT"

# ======================================================================
section "4. Muvaffaqiyatli deploy (C1) — forced yo'l, hash majburiy"
reset_ctl
forced "$(req "$C1")"
check "kod 0" test "$RC" -eq 0
check "web build almashtirildi" test "$(live_build)" = build-c1
check "eski build .prev sifatida saqlandi" test "$(cat "$LIVE/apps/web/.next.prev/BUILD_ID")" = manual-old
check "api dist almashtirildi" test "$(cat "$LIVE/apps/api/dist/src/index.js")" = api-build-c1
check "shared dist almashtirildi" test "$(cat "$LIVE/packages/shared/dist/index.js")" = shared-build-c1
check ".env tegilmadi" test "$(cat "$LIVE/apps/api/.env")" = "SECRET=do-not-touch"
check ".env.production tegilmadi" test "$(cat "$LIVE/apps/web/.env.production")" = "NEXT_PUBLIC_SITE_NAME=abdusoft"
check ".data tegilmadi" test "$(cat "$LIVE/apps/api/.data/uploads/a.jpg")" = upload
check "node_modules tegilmadi" test -d "$LIVE/node_modules/keep"
check ".git live'ga tushmadi" test ! -e "$LIVE/.git"
check "manba commit'ga sinxronlandi (rsync --delete)" test "$(live_rev)" = 1 -a ! -e "$LIVE/stray.txt"
check "staging qoldiqlari tozalandi" bash -c "test ! -e '$LIVE/.deploy-stage' && test ! -e '$LIVE/apps/web/.next.new'"
check "tartib: fetch < install(--offline) < backup(--db-only) < migrate < restart" bash -c "calls=\$(grep -o '^pnpm fetch\|^pnpm install --frozen-lockfile --offline\|^backup --db-only\|^migrate\|^restart' '$CALLS' | tr '\n' ,); [ \"\$calls\" = 'pnpm fetch,pnpm install --frozen-lockfile --offline,backup --db-only,migrate,restart,' ]"
check "restart yangi build bilan" bash -c "grep -q 'restart abdusoft-blog-api abdusoft-blog-web build=build-c1' '$CALLS'"
check "health: yangi BUILD_ID statik fayli tekshirildi" bash -c "grep -q 'health http://127.0.0.1:3100/_next/static/build-c1/_buildManifest.js' '$CALLS'"
check "health: API baza endpointi tekshirildi" bash -c "grep -q 'health http://127.0.0.1:4000/tags' '$CALLS'"
check "holat: current_sha" test "$(state_get current_sha)" = "$C1"
check "holat: last_result=ok, phase=idle" test "$(state_get last_result)" = ok -a "$(state_get phase)" = idle
check "holat: live_build_id yozildi" test "$(state_get live_build_id)" = build-c1
check "log fayli yozilgan" test -s "$STATE/deploy.log"
check "chiqishda sirlar yo'q" bash -c "! printf '%s' \"\$1\" | grep -q 'do-not-touch'" _ "$OUT"
check "chiqishda qadamlar ko'rinadi" contains "$OUT" "[9/9] Health check"
check "birinchi ishga tushirishda drift ogohlantirishi" contains "$OUT" "mos emas"
check "ochiq env mos: ogohlantirish yo'q" bash -c "! printf '%s' \"\$1\" | grep -q 'FARQ QILADI'" _ "$OUT"

# ======================================================================
section "5. Bir xil commit: arzon no-op; --force faqat qo'lda"
reset_calls
forced "$(req "$C1")"
check "no-op: kod 0" test "$RC" -eq 0
check "no-op: xabar" contains "$OUT" "allaqachon deploy qilingan"
check "no-op: restart/backup/migrate/install/download yo'q" test ! -s "$CALLS"
check "no-op: build o'sha" test "$(live_build)" = build-c1
forced "--force $(req "$C1")"
check "SSH orqali --force rad etiladi (64)" test "$RC" -eq 64
check "SSH --force: hech narsa bajarilmadi" test ! -s "$CALLS"
manual --force "$(req "$C1")"
check "qo'lda --force: to'liq qayta deploy (kod 0)" test "$RC" -eq 0
check "qo'lda --force: restart bo'ldi" test "$(calls_count '^restart')" -eq 1
check "qo'lda --force: holat C1" test "$(state_get current_sha)" = "$C1"
# no-op faqat live build haqiqatan o'sha bo'lsa
echo tampered >"$LIVE/apps/web/.next/BUILD_ID"
reset_calls
forced "$(req "$C1")"
check "live BUILD_ID o'zgargan: no-op EMAS, qayta deploy" test "$RC" -eq 0 -a "$(calls_count '^restart')" -eq 1

# ======================================================================
section "6. Yangi commit C2, status"
forced "$(req "$C2")"
check "kod 0" test "$RC" -eq 0
check "build C2" test "$(live_build)" = build-c2
check "previous_sha = C1" test "$(state_get previous_sha)" = "$C1"
manual status
check "status C2 ni ko'rsatadi" contains "$OUT" "$C2"

# ======================================================================
section "7. Yuklab olish xatosi"
reset_calls
touch "$CTL/dl_fail"
forced "$(req "$C3")"
check "kod 1" test "$RC" -eq 1
check "sayt tegilmadi: build C2" test "$(live_build)" = build-c2
check "sayt tegilmadi: manba C2" test "$(live_rev)" = 2
check "install chaqirilmadi" test "$(calls_count '^pnpm install')" -eq 0
check "restart chaqirilmadi" test "$(calls_count restart)" -eq 0
check "holat: current_sha C2 qoldi" test "$(state_get current_sha)" = "$C2"
check "holat: last_result=failed" test "$(state_get last_result)" = failed
reset_ctl

# ======================================================================
section "8. Checksum mos kelmasligi va noto'g'ri kalit"
reset_calls
H3="$(bundle_hash "$C3")"
cp "$REL/abdusoft-blog-$C3.tar.gz.enc" "$SIM/c3.good"
echo "tamper" >>"$REL/abdusoft-blog-$C3.tar.gz.enc"
forced "$C3 $H3"
check "buzilgan fayl: kod 1" test "$RC" -eq 1
check "buzilgan fayl: sabab Checksum" contains "$OUT" "Checksum mos kelmadi"
check "buzilgan fayl: sayt tegilmadi" test "$(live_build)" = build-c2
check "buzilgan fayl: install yo'q" test "$(calls_count '^pnpm install')" -eq 0
cp "$SIM/c3.good" "$REL/abdusoft-blog-$C3.tar.gz.enc"
forced "$C3 $(printf '%064d' 0)"
check "workflow yuborgan sha256 mos emas: kod 1" test "$RC" -eq 1
check "workflow sha256: sabab" contains "$OUT" "SSH orqali yuborgan"
check "workflow sha256: sayt tegilmadi" test "$(live_build)" = build-c2
# ikkalasi ham bir tomonlama almashtirilgan (.sha256 ham moslab qo'yilgan), lekin SSH hash boshqa -> rad
echo "tamper" >>"$REL/abdusoft-blog-$C3.tar.gz.enc"
echo "$(sha256f "$REL/abdusoft-blog-$C3.tar.gz.enc")  x" >"$REL/abdusoft-blog-$C3.tar.gz.enc.sha256"
forced "$C3 $H3"
check "release asset VA .sha256 almashtirilgan, SSH hash asl: rad etildi" test "$RC" -eq 1
cp "$SIM/c3.good" "$REL/abdusoft-blog-$C3.tar.gz.enc"
echo "zzzz" >"$REL/abdusoft-blog-$C3.tar.gz.enc.sha256"
forced "$C3 $H3"
check "noto'g'ri .sha256 formati: kod 1" test "$RC" -eq 1
echo "$H3  x" >"$REL/abdusoft-blog-$C3.tar.gz.enc.sha256"
make_bundle "$C3" "build-c3-wrongkey" "$C3" "$(lockhash "$C3")" 16.4.5 "$(node -p 'process.versions.node.split(".")[0]')" "$SIM/wrong.key"
forced "$(req "$C3")"
check "noto'g'ri kalit bilan shifrlangan: kod 1, aniq xabar" bash -c "[ $RC -eq 1 ] && [[ \"\$1\" == *'kalit noto'* ]]" _ "$OUT"
check "noto'g'ri kalit: sayt/manba tegilmadi, install yo'q" bash -c "[ '$(live_build)' = build-c2 ] && [ \$(grep -c '^pnpm' '$CALLS') -eq 0 ]"
make_bundle "$C3" "build-c3"

# ======================================================================
section "9. Manifest / SHA / lockfile / Node / Next mos kelmasligi"
reset_calls
make_bundle "$C3" "build-c3-badcommit" "$C2"
forced "$(req "$C3")"
check "manifest commit boshqa: kod 1" test "$RC" -eq 1
check "manifest commit boshqa: sabab" contains "$OUT" "Manifest commit"
check "manifest commit boshqa: tegilmadi" test "$(live_build)" = build-c2
make_bundle "$C3" "build-c3-badlock" "$C3" "$(printf '%064d' 1)"
forced "$(req "$C3")"
check "lockfile xeshi mos emas: kod 1" test "$RC" -eq 1
check "lockfile xeshi: sabab" contains "$OUT" "lock"
check "lockfile xeshi: tegilmadi" test "$(live_build)" = build-c2
check "lockfile xeshi: install/fetch chaqirilmadi (manba tegilmadi)" test "$(calls_count '^pnpm')" -eq 0
make_bundle "$C3" "build-c3-badnode" "$C3" "$(lockhash "$C3")" 16.4.5 1
forced "$(req "$C3")"
check "Node major mos emas: kod 1" test "$RC" -eq 1
check "Node major: sabab" contains "$OUT" "Node major"
check "Node major: tegilmadi" test "$(live_build)" = build-c2
make_bundle "$C3" "build-c3-badnext" "$C3" "$(lockhash "$C3")" 99.0.0
reset_calls
forced "$(req "$C3")"
check "Next versiyasi mos emas: kod 1" test "$RC" -eq 1
check "Next versiyasi: sabab" contains "$OUT" "Next.js versiyasi mos emas"
check "Next versiyasi: build C2 qoldi" test "$(live_build)" = build-c2
check "Next versiyasi: manba C2 ga qaytarildi" test "$(live_rev)" = 2
check "Next versiyasi: restart yo'q" test "$(calls_count restart)" -eq 0
check "Next versiyasi: .new qoldig'i yo'q" test ! -e "$LIVE/apps/web/.next.new"
check "Next versiyasi: lock farq qilgani uchun oflayn qayta install" bash -c "[ \$(grep -c '^pnpm install --frozen-lockfile --offline' '$CALLS') -eq 2 ]"
make_bundle "$C3" "build-c3"

# ======================================================================
section "10. Arxiv xavfsizligi (GNU/BSD tar, shifrlangan zararli arxivlar)"
mk_evil() { # mk_evil <tur>
  local d="$SIM/evil.$1"
  rm -rf "$d"
  mkdir -p "$d/apps/web/.next" "$d/apps/api/dist/src" "$d/packages/shared/dist"
  echo b >"$d/apps/web/.next/BUILD_ID"
  echo x >"$d/apps/api/dist/src/index.js"
  echo x >"$d/packages/shared/dist/index.js"
  printf '{"format":2,"commit":"%s","node_major":"24","next_version":"16.4.5","lockfile_sha256":"%s","public_env":{}}' "$C3" "$(lockhash "$C3")" >"$d/MANIFEST.json"
  python3 - "$1" "$d" "$SIM/evil.tgz" <<'PY'
import sys, tarfile
kind, d, out = sys.argv[1:4]
with tarfile.open(out, "w:gz") as t:
    t.add(d + "/MANIFEST.json", "MANIFEST.json")
    t.add(d + "/apps", "apps")
    t.add(d + "/packages", "packages")
    def special(name, typ, link=""):
        ti = tarfile.TarInfo(name)
        ti.type = typ
        ti.linkname = link
        t.addfile(ti)
    if kind == "traversal":
        t.add(d + "/MANIFEST.json", "../evil.txt")
    elif kind == "absolute":
        t.add(d + "/MANIFEST.json", "/tmp/evil-abs.txt")
    elif kind == "extra":
        t.add(d + "/MANIFEST.json", "etc/cron.d/evil")
    elif kind == "symlink":
        special("apps/web/.next/link", tarfile.SYMTYPE, "/etc/passwd")
    elif kind == "hardlink":
        special("apps/web/.next/hl", tarfile.LNKTYPE, "MANIFEST.json")
    elif kind == "fifo":
        special("apps/web/.next/fifo", tarfile.FIFOTYPE)
    elif kind == "device":
        special("apps/web/.next/dev", tarfile.CHRTYPE)
    elif kind == "many":
        import io
        for i in range(600):
            ti = tarfile.TarInfo("apps/web/.next/f%d" % i)
            ti.size = 1
            t.addfile(ti, io.BytesIO(b"x"))
    elif kind == "big":
        import io
        ti = tarfile.TarInfo("apps/web/.next/big")
        ti.size = 8 * 1024 * 1024
        t.addfile(ti, io.BytesIO(b"\0" * ti.size))
PY
  enc_publish "$C3" "$SIM/evil.tgz"
  rm -f "$SIM/evil.tgz"
}
for kind in traversal absolute extra symlink hardlink fifo device many big; do
  mk_evil "$kind"
  reset_calls
  forced "$(req "$C3")"
  check "arxiv '$kind': rad etildi (kod 1)" test "$RC" -eq 1
  check "arxiv '$kind': sayt tegilmadi, install yo'q" bash -c "[ '$(live_build)' = build-c2 ] && [ \$(grep -c '^pnpm' '$CALLS') -eq 0 ]"
done
check "tashqariga hech narsa yozilmadi" bash -c "test ! -e '$SIM/evil.txt' && test ! -e /tmp/evil-abs.txt"
make_bundle "$C3" "build-c3"

# ======================================================================
section "11. pnpm fetch / install xatosi"
reset_calls
touch "$CTL/fail_fetch"
forced "$(req "$C3")"
check "fetch xatosi: kod 1" test "$RC" -eq 1
check "fetch xatosi: live manba va build tegilmagan (install chaqirilmadi)" bash -c "[ '$(live_build)' = build-c2 ] && [ '$(live_rev)' = 2 ] && [ \$(grep -c '^pnpm install' '$CALLS') -eq 0 ]"
reset_ctl
reset_calls
touch "$CTL/fail_install"
forced "$(req "$C3")"
check "install xatosi: kod 1" test "$RC" -eq 1
check "install xatosi: build C2 qoldi" test "$(live_build)" = build-c2
check "install xatosi: manba C2 ga qaytarildi (snapshot)" test "$(live_rev)" = 2
check "install xatosi: restart chaqirilmadi" test "$(calls_count restart)" -eq 0
check "install xatosi: backup/migrate chaqirilmadi" test "$(calls_count '^backup\|^migrate')" -eq 0
check "install xatosi: holat C2, phase=idle" test "$(state_get current_sha)" = "$C2" -a "$(state_get phase)" = idle
reset_ctl
# restore'da oflayn install yiqilsa — onlayn urinadi
reset_calls
touch "$CTL/fail_install_offline"
forced "$(req "$C3")"
check "oflayn install yiqildi: kod 1" test "$RC" -eq 1
check "oflayn yiqilgach onlayn install urinildi" bash -c "grep -q '^pnpm install --frozen-lockfile lock' '$CALLS'"
reset_ctl

# ======================================================================
section "12. Backup / migratsiya xatosi, timeout, disk, swap yarim yiqilishi"
reset_calls
touch "$CTL/fail_backup"
forced "$(req "$C3")"
check "backup xatosi: kod 1" test "$RC" -eq 1
check "backup xatosi: migratsiya chaqirilmadi" test "$(calls_count '^migrate')" -eq 0
check "backup xatosi: build C2" test "$(live_build)" = build-c2
reset_ctl
reset_calls
touch "$CTL/fail_migrate"
forced "$(req "$C3")"
check "migratsiya xatosi: kod 1" test "$RC" -eq 1
check "migratsiya xatosi: build C2 qoldi" test "$(live_build)" = build-c2
check "migratsiya xatosi: restart yo'q" test "$(calls_count restart)" -eq 0
check "migratsiya xatosi: manba C2" test "$(live_rev)" = 2
check "migratsiya xatosi: eslatma (additive)" contains "$OUT" "additive"
reset_ctl
for what in migrate install backup; do
  reset_calls
  touch "$CTL/hang_$what"
  forced "$(req "$C3")"
  check "timeout ($what): kod 1 (normal xato yo'li)" test "$RC" -eq 1
  check "timeout ($what): build C2, restart yo'q, manba C2" bash -c "[ '$(live_build)' = build-c2 ] && [ \$(grep -c restart '$CALLS') -eq 0 ] && [ '$(live_rev)' = 2 ]"
  reset_ctl
done
conf_set BLOGDEPLOY_MIN_FREE_MB 999999999
reset_calls
forced "$(req "$C3")"
check "disk to'la: rad etildi, hech narsa o'zgarmadi" bash -c "[ $RC -eq 1 ] && [[ \"\$1\" == *'bo'\"'\"'sh joy'* ]] && [ ! -s '$CALLS' ]" _ "$OUT"
conf_reset
reset_calls
touch "$CTL/sabotage_new"
forced "$(req "$C3")"
check "swap yarim yiqildi: kod 1" test "$RC" -eq 1
check "swap yarim yiqildi: HAMMA build eski (web/api/shared)" bash -c "[ '$(live_build)' = build-c2 ] && [ \"\$(cat '$LIVE/apps/api/dist/src/index.js')\" = api-build-c2 ] && [ \"\$(cat '$LIVE/packages/shared/dist/index.js')\" = shared-build-c2 ]"
check "swap yarim yiqildi: restart bo'lmadi" test "$(calls_count restart)" -eq 0
check "swap yarim yiqildi: holat idle" test "$(state_get phase)" = idle
reset_ctl

# ======================================================================
section "13. Health xatosi -> avtomatik rollback (3 xil sabab)"
reset_calls
echo build-c3 >"$CTL/bad_build"
forced "$(req "$C3")"
check "kod 1" test "$RC" -eq 1
check "avtomatik orqaga qaytarish xabari" contains "$OUT" "ORQAGA QAYTARISH"
check "migratsiya qaytarilmasligi aytildi" contains "$OUT" "orqaga qaytarilmaydi"
check "build C2 ga qaytdi" test "$(live_build)" = build-c2
check "api dist C2" test "$(cat "$LIVE/apps/api/dist/src/index.js")" = api-build-c2
check "manba C2 ga qaytdi" test "$(live_rev)" = 2
check "restart aynan 2 marta — sikl yo'q" test "$(calls_count '^restart')" -eq 2
check "holat: rolled_back, current C2, phase idle" test "$(state_get last_result)" = rolled_back -a "$(state_get current_sha)" = "$C2" -a "$(state_get phase)" = idle
check "holat: last_attempt_sha C3" test "$(state_get last_attempt_sha)" = "$C3"
check "*.failed qoldig'i bor (keyingi deploy tozalaydi)" test -d "$LIVE/apps/web/.next.failed"
reset_ctl
# eski jarayon hali eski build'ni xizmat qilyapti (restart yangi build'ni ko'tarmadi) — "/" 200, lekin yangi BUILD_ID yo'q
reset_calls
echo build-c2 >"$CTL/serving_build"
forced "$(req "$C3")"
check "eski build xizmat qilyapti: health yiqildi -> rollback (kod 1)" test "$RC" -eq 1
check "eski build xizmat qilyapti: build C2 ga qaytdi" test "$(live_build)" = build-c2
check "eski build xizmat qilyapti: ikki restart" test "$(calls_count '^restart')" -eq 2
reset_ctl
reset_calls
echo build-c3 >"$CTL/db_down"
forced "$(req "$C3")"
check "baza ishlamayapti (/tags): rollback (kod 1)" test "$RC" -eq 1
check "baza ishlamayapti: build C2 ga qaytdi" test "$(live_build)" = build-c2
reset_ctl

# ======================================================================
section "14. Rollback ham muvaffaqiyatsiz -> kod 2"
reset_calls
touch "$CTL/health_always_fail"
forced "$(req "$C3")"
check "kod 2" test "$RC" -eq 2
check "qo'lda aralashuv xabari" contains "$OUT" "QO'LDA ARALASHING"
check "holat: rollback_failed" test "$(state_get last_result)" = rollback_failed
reset_ctl
check "holat: phase=idle (keyingi so'rov yarim holat deb tiklamaydi)" test "$(state_get phase)" = idle
manual --force "$(req "$C2")"
check "tiklash: C2 qayta deploy ok" test "$RC" -eq 0

# ======================================================================
section "15. Bir vaqtda ikkinchi deploy lock bilan to'sildi"
reset_calls
(
  PATH="$SHIMS:$PATH"
  exec 9>"$STATE/deploy.lock"
  flock -n 9 || exit 1
  sleep 6
) &
HOLDER=$!
sleep 1
forced "$(req "$C3")"
check "kod 3 (lock band)" test "$RC" -eq 3
check "aniq xabar" contains "$OUT" "boshqa deploy hozir ishlayapti"
check "lock ostida hech narsa o'zgarmadi" test "$(live_build)" = build-c2
check "lock paytida yuklab olish yo'q" test "$(calls_count download)" -eq 0
wait "$HOLDER" 2>/dev/null
forced "$(req "$C3")"
check "lock bo'shagach deploy ishlaydi" test "$RC" -eq 0

# ======================================================================
section "16. Qo'lda zudlik bilan rollback va eski commit'ni qayta deploy"
reset_calls
manual rollback
check "rollback kod 0" test "$RC" -eq 0
check "build C2 ga qaytdi" test "$(live_build)" = build-c2
check "manba C2 (src.prev'dan) qaytdi" test "$(live_rev)" = 2
check "rollback bundle yuklamadi (zudlik)" test "$(calls_count download)" -eq 0
check "rollback restart qildi" bash -c "grep -q 'restart .* build=build-c2' '$CALLS'"
check "holat current_sha C2, live_build_id mos" test "$(state_get current_sha)" = "$C2" -a "$(state_get live_build_id)" = build-c2
manual rollback
check "ikkinchi rollback (prev yo'q, kod 1)" test "$RC" -eq 1
check "ikkinchi rollback: build o'zgarmadi" test "$(live_build)" = build-c2
forced "$(req "$C1")"
check "eski commit (C1) qayta deploy: kod 0" test "$RC" -eq 0
check "eski commit: build C1" test "$(live_build)" = build-c1
check "eski commit: manba C1" test "$(live_rev)" = 1

# ======================================================================
section "17. Muhit o'zgaruvchilari e'tiborsiz"
reset_calls
OUT="$(BLOGDEPLOY_RELEASE_BASE_URL=https://evil.test BLOGDEPLOY_BACKUP_SCRIPT=/bin/false BLOGDEPLOY_BUNDLE_KEY_FILE=/etc/hosts SSH_ORIGINAL_COMMAND="$(req "$C2")" bash "$ENTRY" 2>&1)"
RC=$?
check "chaqiruvchi muhiti e'tiborsiz (kod 0)" test "$RC" -eq 0
check "evil.test'ga murojaat bo'lmadi" bash -c "! grep -q evil '$CALLS'"

# ======================================================================
section "18. Drift: pipeline -> qo'lda deploy-vds.sh -> pipeline (migratsiyada yiqiladi)"
baseline "$C1"
# qo'lda deploy-vds.sh: manba va build o'zgaradi, *.prev o'chadi
echo '{"name":"blog","rev":"manual"}' >"$LIVE/package.json"
echo "manual-only" >"$LIVE/manual-marker.txt"
echo manual-build >"$LIVE/apps/web/.next/BUILD_ID"
rm -rf "$LIVE"/apps/web/.next.prev "$LIVE"/apps/api/dist.prev "$LIVE"/packages/shared/dist.prev
reset_calls
touch "$CTL/fail_migrate"
forced "$(req "$C2")"
check "kod 1" test "$RC" -eq 1
check "drift ogohlantirishi (oldingi commit noma'lum)" contains "$OUT" "NOMA'LUM"
check "qo'lda deploy qilingan manba saqlandi (C1 ga 'qaytarilmadi')" test "$(live_rev)" = manual
check "qo'lda deploy marker fayli saqlandi" test -f "$LIVE/manual-marker.txt"
check "qo'lda yig'ilgan build saqlandi" test "$(live_build)" = manual-build
check "restart bo'lmadi" test "$(calls_count restart)" -eq 0
reset_ctl
# drift paytida yangi deploy ham ishlaydi va rollback build'ni qaytara oladi
echo manual-build2 >"$LIVE/apps/web/.next/BUILD_ID"
reset_calls
echo build-c2 >"$CTL/bad_build"
forced "$(req "$C2")"
check "drift + health xatosi: rollback kod 1" test "$RC" -eq 1
check "drift + health xatosi: qo'lda build qaytdi" test "$(live_build)" = manual-build2
check "drift + health xatosi: current_sha noma'lum (bo'sh)" test -z "$(state_get current_sha)"
reset_ctl

# ======================================================================
section "19. Crash safety: har bosqichda SIGKILL"
for k in install migrate; do
  baseline "$C1"
  touch "$CTL/kill_$k"
  forced "$(req "$C2")"
  check "kill@$k: skript o'ldirildi (kod != 0)" test "$RC" -ne 0
  check "kill@$k: holat phase=source" test "$(state_get phase)" = source
  check "kill@$k: manba yarim sinxronlangan (C2)" test "$(live_rev)" = 2
  rm -f "$CTL/kill_$k"
  forced "$(req "$C2")"
  check "kill@$k: keyingi ishga tushirish avtomatik tiklaydi (kod 1)" bash -c "[ $RC -eq 1 ] && [[ \"\$1\" == *'yarim qolgan'* ]]" _ "$OUT"
  check "kill@$k: manba C1 ga qaytdi, build C1" test "$(live_rev)" = 1 -a "$(live_build)" = build-c1
  check "kill@$k: phase=idle" test "$(state_get phase)" = idle
  forced "$(req "$C2")"
  check "kill@$k: tiklangach oddiy deploy ishlaydi" test "$RC" -eq 0 -a "$(live_build)" = build-c2
done
for k in restart health; do
  baseline "$C1"
  touch "$CTL/kill_$k"
  forced "$(req "$C2")"
  check "kill@$k: skript o'ldirildi" test "$RC" -ne 0
  check "kill@$k: holat phase=restarting, build almashgan" test "$(state_get phase)" = restarting -a "$(live_build)" = build-c2
  rm -f "$CTL/kill_$k"
  reset_calls
  forced "$(req "$C2")"
  check "kill@$k: avtomatik tiklash (kod 1)" bash -c "[ $RC -eq 1 ] && [[ \"\$1\" == *'yarim qolgan'* ]]" _ "$OUT"
  check "kill@$k: eski build qaytdi, *.prev almashgan build bilan ustiga yozilmadi" test "$(live_build)" = build-c1 -a "$(cat "$LIVE/apps/api/dist/src/index.js")" = api-build-c1
  check "kill@$k: tiklash restart+health qildi" test "$(calls_count '^restart')" -eq 1
  forced "$(req "$C2")"
  check "kill@$k: tiklangach deploy ishlaydi" test "$RC" -eq 0 -a "$(live_build)" = build-c2
done
# swap o'rtasida o'ldirilgan holatlarni qo'lda tuzamiz (rename'lar o'rtasida SIGKILL)
baseline "$C1"
cp -R "$LIVE/apps/web/.next" "$SIM/old-web"
cp -R "$LIVE/apps/api/dist" "$SIM/old-api"
# (a) web almashgan; api: eski .prev'ga ko'chgan, yangisi hali joyiga qo'yilmagan; shared tegilmagan
rm -rf "$LIVE/apps/web/.next.prev" "$LIVE/apps/api/dist.prev" "$LIVE/packages/shared/dist.prev"
mv "$LIVE/apps/web/.next" "$LIVE/apps/web/.next.prev"
mkdir -p "$LIVE/apps/web/.next" && echo build-new >"$LIVE/apps/web/.next/BUILD_ID"
mv "$LIVE/apps/api/dist" "$LIVE/apps/api/dist.prev"
mkdir -p "$LIVE/apps/api/dist.new/src" && echo api-new >"$LIVE/apps/api/dist.new/src/index.js"
mkdir -p "$LIVE/packages/shared/dist.new" && echo shared-new >"$LIVE/packages/shared/dist.new/index.js"
set_state phase swapping
set_state swap_cur apps/api/dist
set_state swap_done apps/web/.next
forced "$(req "$C2")"
check "swap o'rtasida o'ldirilgan (a): tiklandi (kod 1)" test "$RC" -eq 1
check "(a): web eski" test "$(live_build)" = build-c1
check "(a): api eski joyiga qaytdi" test "$(cat "$LIVE/apps/api/dist/src/index.js")" = api-build-c1
check "(a): shared tegilmagan (eski)" test "$(cat "$LIVE/packages/shared/dist/index.js")" = shared-build-c1
check "(a): *.new qoldiqlari tozalandi" bash -c "! ls '$LIVE'/apps/*/*.new '$LIVE'/apps/api/dist.new '$LIVE'/packages/shared/dist.new >/dev/null 2>&1"
# (b) api: yangisi joyiga qo'yilgan, lekin swap_done'ga yozilmagan
baseline "$C1"
rm -rf "$LIVE/apps/api/dist.prev"
mv "$LIVE/apps/api/dist" "$LIVE/apps/api/dist.prev"
mkdir -p "$LIVE/apps/api/dist/src" && echo api-new >"$LIVE/apps/api/dist/src/index.js"
set_state phase swapping
set_state swap_cur apps/api/dist
set_state swap_done ""
forced "$(req "$C2")"
check "(b): tugallangan-lekin-yozilmagan almashtirish ham qaytarildi" test "$RC" -eq 1 -a "$(cat "$LIVE/apps/api/dist/src/index.js")" = api-build-c1
# (c) *.prev yo'q: avtomatik tiklab bo'lmaydi -> rad etadi (kod 2) va aniq ko'rsatma
baseline "$C1"
set_state phase restarting
rm -rf "$LIVE/apps/web/.next.prev"
set_state swap_done "apps/web/.next"
forced "$(req "$C2")"
check "(c): *.prev yo'q -> kod 2 va ko'rsatma" bash -c "[ $RC -eq 2 ] && [[ \"\$1\" == *'deploy-vds.sh'* ]]" _ "$OUT"
set_state phase idle
set_state swap_done ""

# ======================================================================
section "20. Ochiq config farqi, log aylantirish, *.failed tozalash"
baseline "$C1"
echo "NEXT_PUBLIC_SITE_NAME=other-name-xyz" >"$LIVE/apps/web/.env.production"
forced "$(req "$C2")"
check "farq bor: deploy davom etadi (kod 0)" test "$RC" -eq 0
check "farq bor: prominent ogohlantirish, nom ko'rsatiladi" contains "$OUT" "FARQ QILADI: NEXT_PUBLIC_SITE_NAME"
check "farq bor: qiymatlar chiqishga bosilmadi" bash -c "! printf '%s' \"\$1\" | grep -q 'other-name-xyz'" _ "$OUT"
echo "NEXT_PUBLIC_SITE_NAME=abdusoft" >"$LIVE/apps/web/.env.production"
# *.failed: avto-rollbackdan keyin bor, keyingi deploy tozalaydi
echo build-c3 >"$CTL/bad_build"
forced "$(req "$C3")"
check "*.failed hosil bo'ldi" test -d "$LIVE/apps/web/.next.failed"
reset_ctl
forced "$(req "$C4")"
check "keyingi deploy *.failed'ni tozaladi" test ! -e "$LIVE/apps/web/.next.failed"
# log aylantirish
conf_set BLOGDEPLOY_LOG_MAX_BYTES 100
manual --force "$(req "$C4")"
check "log katta: deploy.log.1 ga aylantirildi" test -f "$STATE/deploy.log.1"
conf_reset
# eski yuklamalar tozalanadi
mkdir -p "$STATE/download.99999"
manual --force "$(req "$C4")"
check "eski yuklama papkasi tozalandi" test ! -e "$STATE/download.99999"

# ======================================================================
section "21. make-deploy-bundle.sh (runner tomoni): shifrlash, sir tekshiruvi"
FR="$SIM/fakerepo"
mkdir -p "$FR/scripts" "$FR/apps/web/.next/server" "$FR/apps/web/node_modules/next" "$FR/apps/api/dist/src" "$FR/packages/shared/dist"
cp "$REPO_ROOT/scripts/make-deploy-bundle.sh" "$FR/scripts/"
echo build-real >"$FR/apps/web/.next/BUILD_ID"
echo "web" >"$FR/apps/web/.next/server/app.js"
mkdir -p "$FR/apps/web/.next/cache" && echo cachedata >"$FR/apps/web/.next/cache/c"
echo '{"version":"16.4.5"}' >"$FR/apps/web/node_modules/next/package.json"
echo "api" >"$FR/apps/api/dist/src/index.js"
echo "shared" >"$FR/packages/shared/dist/index.js"
git -C "$SIM/work" show "$C4:pnpm-lock.yaml" >"$FR/pnpm-lock.yaml"
OUTB="$SIM/outb"
rm -rf "$OUTB"
OUT="$(cd "$FR" && NEXT_PUBLIC_SITE_NAME=abdusoft BUNDLE_KEY_FILE="$SIM/bundle.key" bash scripts/make-deploy-bundle.sh "$C4" "$OUTB" 2>&1)"
RC=$?
check "bundle yig'ildi (kod 0)" test "$RC" -eq 0
check "faqat shifrlangan fayl chiqdi, ochiq .tar.gz yo'q" bash -c "ls '$OUTB' | grep -q '\.tar\.gz\.enc$' && ! ls '$OUTB' | grep -q '\.tar\.gz$'"
check "shifrlangan fayl gzip EMAS (ochiq matn emas)" bash -c "! gzip -t '$OUTB/abdusoft-blog-$C4.tar.gz.enc' 2>/dev/null"
check ".sha256 shifrlangan fayl uchun" test "$(cut -d' ' -f1 <"$OUTB/abdusoft-blog-$C4.tar.gz.enc.sha256")" = "$(sha256f "$OUTB/abdusoft-blog-$C4.tar.gz.enc")"
openssl enc -d "${ENCOPTS[@]}" -pass "file:$SIM/bundle.key" -in "$OUTB/abdusoft-blog-$C4.tar.gz.enc" -out "$SIM/dec.tgz"
check "to'g'ri kalit bilan ochiladi; .next/cache yo'q; manifest format 2" bash -c "tar -tzf '$SIM/dec.tgz' | grep -q MANIFEST.json && ! tar -tzf '$SIM/dec.tgz' | grep -q 'next/cache' && [ \"\$(tar -xzOf '$SIM/dec.tgz' MANIFEST.json | node -p 'JSON.parse(require(\"fs\").readFileSync(0,\"utf8\")).format')\" = 2 ]"
check "manifestda public_env va xesh bor" bash -c "tar -xzOf '$SIM/dec.tgz' MANIFEST.json | grep -q public_env_sha256"
check "noto'g'ri kalit bilan ochilmaydi" bash -c "! openssl enc -d ${ENCOPTS[*]} -pass 'file:$SIM/wrong.key' -in '$OUTB/abdusoft-blog-$C4.tar.gz.enc' -out '$SIM/dec2.tgz' 2>/dev/null"
rm -f "$SIM/dec.tgz" "$SIM/dec2.tgz"
check "kalit chiqishda yo'q" bash -c "! printf '%s' \"\$1\" | grep -qF \"\$(head -c 20 '$SIM/bundle.key')\"" _ "$OUT"
# runner'da yig'ilgan haqiqiy bundle serverda deploy bo'ladi
cp "$OUTB/abdusoft-blog-$C4.tar.gz.enc" "$OUTB/abdusoft-blog-$C4.tar.gz.enc.sha256" "$REL/"
reset_ctl
manual --force "$(req "$C4")"
check "runner'da yig'ilgan bundle serverda deploy bo'ldi (kod 0)" test "$RC" -eq 0 -a "$(live_build)" = build-real
# kalit yo'q -> yuklashdan oldin to'xtaydi
OUT="$(cd "$FR" && env -u BUNDLE_KEY_FILE bash scripts/make-deploy-bundle.sh "$C4" "$SIM/outc" 2>&1)"
RC=$?
check "BUNDLE_KEY_FILE yo'q: bundle yig'ilmaydi" test "$RC" -ne 0 -a ! -e "$SIM/outc"
# sir tekshiruvi ochiq matnda (shifrlashdan oldin)
echo "SECRET=x" >"$FR/apps/api/dist/.env.production"
OUT="$(cd "$FR" && BUNDLE_KEY_FILE="$SIM/bundle.key" bash scripts/make-deploy-bundle.sh "$C4" "$SIM/outd" 2>&1)"
RC=$?
check ".env fayli bundle'da: rad etildi, hech narsa chiqmadi" test "$RC" -ne 0 -a ! -e "$SIM/outd/abdusoft-blog-$C4.tar.gz.enc"
rm -f "$FR/apps/api/dist/.env.production"
echo "const u='postgres://blog:hunter2pw@db.internal:5432/blog'" >"$FR/apps/api/dist/src/leak.js"
OUT="$(cd "$FR" && BUNDLE_KEY_FILE="$SIM/bundle.key" bash scripts/make-deploy-bundle.sh "$C4" "$SIM/oute" 2>&1)"
RC=$?
check "parolli DB URL bundle'da: rad etildi" test "$RC" -ne 0 -a ! -e "$SIM/oute/abdusoft-blog-$C4.tar.gz.enc"
check "sir qiymatining o'zi logga chiqmadi" bash -c "! printf '%s' \"\$1\" | grep -q hunter2pw" _ "$OUT"
rm -f "$FR/apps/api/dist/src/leak.js"

# ======================================================================
section "22. backup-native.sh --db-only (cron default'i o'zgarmagan)"
BK="$SIM/backups"
mkdir -p "$SIM/pgshim" "$SIM/uploads/x" "$BK"
cat >"$SIM/pgshim/pg_dump" <<'EOF'
#!/bin/bash
[ -e "${PGFAIL:-/nonexistent}" ] && exit 1
echo "-- dump"
EOF
chmod +x "$SIM/pgshim/pg_dump"
echo f >"$SIM/uploads/x/a.jpg"
runbk() { PATH="$SIM/pgshim:$PATH" ENV_FILE=/nonexistent BACKUP_DIR="$BK" UPLOADS_DIR="$SIM/uploads" UMAMI_ENV_FILE=/nonexistent bash "$REPO_ROOT/scripts/backup-native.sh" "$@" 2>&1; }
OUT="$(runbk)"
check "default (cron): blog_db + uploads arxivi (o'zgarmagan)" bash -c "ls '$BK' | grep -q '^blog_db_.*sql.gz$' && ls '$BK' | grep -q '^blog_uploads_.*tar.gz$' && ! ls '$BK' | grep -q predeploy"
rm -f "$BK"/*
for n in 1 2 3 4 5 6 7; do touch -t "20200101000$n" "$BK/blog_predeploy_2020010100000$n.sql.gz"; done
OUT="$(runbk --db-only)"
check "--db-only: faqat predeploy dump, uploads/umami yo'q" bash -c "ls '$BK' | grep -q '^blog_predeploy_2026.*sql.gz$' && ! ls '$BK' | grep -q 'blog_uploads\|blog_db_\|umami'"
check "--db-only: saqlash oxirgi 5 ta" test "$(find "$BK" -name 'blog_predeploy_*' | wc -l | tr -d ' ')" -eq 5
OUT="$(PGFAIL=/etc/hosts runbk --db-only)"
check "--db-only: pg_dump yiqilsa noldan farqli kod, yarim fayl qolmaydi" bash -c "! ls '$BK' | grep -q '\.tmp$'"
OUT="$(runbk --nope)"
check "noma'lum argument rad etiladi" contains "$OUT" "Noma'lum argument"

echo
echo "Natija: $PASS o'tdi, $FAIL muvaffaqiyatsiz"
[ "$FAIL" -eq 0 ]

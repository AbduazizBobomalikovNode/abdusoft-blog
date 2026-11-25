#!/bin/bash
# scripts/server-deploy-entry.sh + scripts/server-deploy.sh uchun lokal
# simulyatsiya: vaqtinchalik papkalar live/source o'rniga, lokal bare git repo
# "GitHub" o'rniga, PATH shim'lar sudo/systemctl/pnpm/curl/flock/backup o'rniga.
# Haqiqiy server, tarmoq va systemd KERAK EMAS.
#
#   ./scripts/tests/server-deploy-sim.sh
#
# Chiqish kodi 0 — hamma tekshiruv o'tdi.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export COPYFILE_DISABLE=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=sim GIT_AUTHOR_EMAIL=sim@example.invalid GIT_COMMITTER_NAME=sim GIT_COMMITTER_EMAIL=sim@example.invalid

SIM="$(mktemp -d "${TMPDIR:-/tmp}/blog-deploy-sim.XXXXXX")"
trap 'rm -rf "$SIM"' EXIT
LIVE="$SIM/live" SRC="$SIM/src" STATE="$SIM/state" SHIMS="$SIM/shims" CTL="$SIM/ctl" REL="$SIM/release"
CALLS="$SIM/calls.log"
mkdir -p "$LIVE" "$STATE" "$SHIMS" "$CTL" "$REL"
: >"$CALLS"

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
    [ -e "$CTL/fail_restart" ] && exit 1
    exit 0 ;;
esac
EOF
cat >"$SHIMS/pnpm" <<EOF
#!/bin/bash
case "\$1" in
  install)
    echo "pnpm install lock=\$(cat pnpm-lock.yaml | cksum | cut -d' ' -f1)" >>"$CALLS"
    [ -e "$CTL/fail_install" ] && { echo "ERR_PNPM_FAKE install failed"; exit 1; }
    mkdir -p apps/web/node_modules/next node_modules
    printf '{"version":"%s"}' "\$(cat "$CTL/next_version" 2>/dev/null || echo 16.4.5)" >apps/web/node_modules/next/package.json
    exit 0 ;;
  api:migrate)
    echo "migrate" >>"$CALLS"
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
case "\$url" in
  https://dl.test/*)
    echo "download \${url##*/}" >>"$CALLS"
    [ -e "$CTL/dl_fail" ] && exit 22
    [ -f "$REL/\${url##*/}" ] || exit 22
    cp "$REL/\${url##*/}" "\$out" ;;
  http://127.0.0.1:4000/health|http://127.0.0.1:3100/)
    [ -e "$CTL/health_always_fail" ] && exit 22
    if [ -f "$CTL/bad_build" ] && [ "\$(cat "$CTL/bad_build")" = "\$(cat "$LIVE/apps/web/.next/BUILD_ID" 2>/dev/null)" ]; then exit 22; fi
    exit 0 ;;
  *) echo "kutilmagan curl URL: \$url" >&2; exit 99 ;;
esac
EOF
cat >"$SHIMS/fake-backup.sh" <<EOF
#!/bin/bash
echo "backup" >>"$CALLS"
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
ln -sf "$(command -v node)" "$SHIMS/node"
chmod +x "$SHIMS"/*

# ---------------------------------------------------- wrapper + conf (SSH tomoni)
ENTRY="$SIM/bin/abdusoft-blog-deploy-entry"
mkdir -p "$SIM/bin"
cp "$REPO_ROOT/scripts/server-deploy-entry.sh" "$ENTRY"
cat >"$SIM/bin/abdusoft-blog-deploy-entry.conf" <<EOF
BLOGDEPLOY_LIVE_DIR="$LIVE"
BLOGDEPLOY_SRC_DIR="$SRC"
BLOGDEPLOY_STATE_DIR="$STATE"
BLOGDEPLOY_NODE_BIN="$SHIMS"
BLOGDEPLOY_REPO_URL="file://$SIM/remote.git"
BLOGDEPLOY_RELEASE_BASE_URL="https://dl.test"
BLOGDEPLOY_BACKUP_SCRIPT="$SHIMS/fake-backup.sh"
BLOGDEPLOY_HEALTH_TRIES=2
BLOGDEPLOY_HEALTH_INTERVAL=0
EOF
# wrapper conf'ni o'z yonidagi `abdusoft-blog-deploy.conf` nomidan o'qiydi
mv "$SIM/bin/abdusoft-blog-deploy-entry.conf" "$SIM/bin/abdusoft-blog-deploy.conf"

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
# main'da OLMAGAN commit
(cd "$SIM/work" && git checkout -q -b feature && echo x >feature.txt && git add feature.txt && git commit -q -m feature)
CX="$(cd "$SIM/work" && git rev-parse HEAD)"
(cd "$SIM/work" && git push -q origin feature && git checkout -q main)

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1
}
lockhash() { (cd "$SIM/work" && git show "$1:pnpm-lock.yaml" | sha256_stdin); }
sha256f() { sha256_stdin <"$1"; }

# make_bundle <sha> <build-id> [manifest-commit] [lock-hash] [next-version] [node-major]
make_bundle() {
  local sha="$1" bid="$2" mc="${3:-$1}" lh="${4:-$(lockhash "$1")}" nv="${5:-16.4.5}" nm="${6:-$(node -p 'process.versions.node.split(".")[0]')}"
  local st="$SIM/stage.$sha.$bid"
  rm -rf "$st"
  mkdir -p "$st/apps/web/.next/server" "$st/apps/api/dist/src" "$st/packages/shared/dist"
  echo "$bid" >"$st/apps/web/.next/BUILD_ID"
  echo "web-$bid" >"$st/apps/web/.next/server/app.js"
  echo "api-$bid" >"$st/apps/api/dist/src/index.js"
  echo "shared-$bid" >"$st/packages/shared/dist/index.js"
  printf '{"format":1,"commit":"%s","node_major":"%s","next_version":"%s","lockfile_sha256":"%s","built_at":"x"}\n' "$mc" "$nm" "$nv" "$lh" >"$st/MANIFEST.json"
  tar -czf "$REL/abdusoft-blog-$sha.tar.gz" -C "$st" MANIFEST.json apps packages
  echo "$(sha256f "$REL/abdusoft-blog-$sha.tar.gz")  abdusoft-blog-$sha.tar.gz" >"$REL/abdusoft-blog-$sha.tar.gz.sha256"
  rm -rf "$st"
}
bundle_hash() { cut -d' ' -f1 <"$REL/abdusoft-blog-$1.tar.gz.sha256"; }

reset_ctl() { rm -f "$CTL"/*; }
calls() { cat "$CALLS"; }
reset_calls() { : >"$CALLS"; }
live_build() { cat "$LIVE/apps/web/.next/BUILD_ID" 2>/dev/null; }
state_get() { grep -m1 "^$1=" "$STATE/state" 2>/dev/null | cut -d= -f2-; }
live_rev() { node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).rev' "$LIVE/package.json" 2>/dev/null; }

# -------------------------------------------------- "live" boshlang'ich holat
mkdir -p "$LIVE/apps/web/.next" "$LIVE/apps/api/dist/src" "$LIVE/packages/shared/dist" "$LIVE/apps/api/.data/uploads" "$LIVE/node_modules/keep" "$LIVE/scripts"
echo manual-old >"$LIVE/apps/web/.next/BUILD_ID"
echo old >"$LIVE/apps/api/dist/src/index.js"
echo old >"$LIVE/packages/shared/dist/index.js"
echo "SECRET=do-not-touch" >"$LIVE/apps/api/.env"
echo "NEXT_PUBLIC_X=do-not-touch" >"$LIVE/apps/web/.env.production"
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
bad_inputs=(
  "" "foo" "deploy $C1" "status; touch $PWN" "status extra"
  "${C1:0:39}" "${C1}0" "$(echo "$C1" | tr a-f A-F)" "${C1:0:39}g"
  "$C1; touch $PWN" "$C1 && touch $PWN" "$C1 | touch $PWN" "$C1 \`touch $PWN\`" "\`touch $PWN\`" "\$(touch $PWN)"
  "$C1 \$(touch $PWN)" "$C1; rm -rf $LIVE" "$C1
touch $PWN" "$C1
" "
$C1" "$C1  $(bundle_hash "$C1")" "$C1 ${C1}" "$C1 $(bundle_hash "$C1");touch $PWN" "$C1 $(bundle_hash "$C1")
touch $PWN" "rollback" "--help" "-x" "../../etc/passwd"
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

# ======================================================================
section "2. status (hech narsani o'zgartirmaydi)"
forced "status"
check "status kod 0" test "$RC" -eq 0
check "status xizmat holatini ko'rsatadi" contains "$OUT" "abdusoft-blog-api: active"
check "status 'hali deploy qilinmagan' deydi" contains "$OUT" "holat fayli hali yo'q"
check "status holat fayli yaratmadi" test ! -e "$STATE/state"
check "status log yozmadi" test ! -e "$STATE/deploy.log"

# ======================================================================
section "3. SHA main'da emas / mavjud emas"
forced "$CX"
check "feature commit rad etildi (kod 1)" test "$RC" -eq 1
check "sabab ko'rsatildi" contains "$OUT" "origin/main tarkibida emas"
forced "0000000000000000000000000000000000000000"
check "mavjud bo'lmagan SHA rad etildi" test "$RC" -eq 1
check "live tegilmadi" test "$(live_build)" = manual-old
check "xizmat qayta ishga tushirilmadi" bash -c "! grep -q restart '$CALLS'"
check "bundle yuklanmadi" bash -c "! grep -q download '$CALLS'"

# ======================================================================
section "4. Muvaffaqiyatli deploy (C1, sha256 bilan) — forced yo'l"
reset_ctl
forced "$C1 $(bundle_hash "$C1")"
check "kod 0" test "$RC" -eq 0
check "web build almashtirildi" test "$(live_build)" = build-c1
check "eski build .prev sifatida saqlandi" test "$(cat "$LIVE/apps/web/.next.prev/BUILD_ID")" = manual-old
check "api dist almashtirildi" test "$(cat "$LIVE/apps/api/dist/src/index.js")" = api-build-c1
check "shared dist almashtirildi" test "$(cat "$LIVE/packages/shared/dist/index.js")" = shared-build-c1
check ".env tegilmadi" test "$(cat "$LIVE/apps/api/.env")" = "SECRET=do-not-touch"
check ".env.production tegilmadi" test "$(cat "$LIVE/apps/web/.env.production")" = "NEXT_PUBLIC_X=do-not-touch"
check ".data tegilmadi" test "$(cat "$LIVE/apps/api/.data/uploads/a.jpg")" = upload
check "node_modules tegilmadi" test -d "$LIVE/node_modules/keep"
check ".git live'ga tushmadi" test ! -e "$LIVE/.git"
check "manba commit'ga sinxronlandi (rsync --delete)" test "$(live_rev)" = 1 -a ! -e "$LIVE/stray.txt"
check "staging qoldiqlari tozalandi" bash -c "test ! -e '$LIVE/.deploy-stage' && test ! -e '$LIVE/apps/web/.next.new'"
check "tartib: install < backup < migrate < restart" bash -c "calls=\$(grep -o '^pnpm install\|^backup\|^migrate\|^restart' '$CALLS' | tr '\n' ,); [ \"\$calls\" = 'pnpm install,backup,migrate,restart,' ]"
check "restart yangi build bilan" bash -c "grep -q 'restart abdusoft-blog-api abdusoft-blog-web build=build-c1' '$CALLS'"
check "holat: current_sha" test "$(state_get current_sha)" = "$C1"
check "holat: last_result=ok" test "$(state_get last_result)" = ok
check "log fayli yozilgan" test -s "$STATE/deploy.log"
check "chiqishda sirlar yo'q" bash -c "! printf '%s' \"\$1\" | grep -q 'do-not-touch'" _ "$OUT"
check "chiqishda qadamlar ko'rinadi" contains "$OUT" "[9/9] Health check"

# ======================================================================
section "5. Bir xil commit qayta (idempotent)"
reset_calls
forced "$C1"
check "kod 0" test "$RC" -eq 0
check "build o'sha" test "$(live_build)" = build-c1
check "holat current_sha o'sha" test "$(state_get current_sha)" = "$C1"

# ======================================================================
section "6. Yangi commit C2, status"
forced "$C2 $(bundle_hash "$C2")"
check "kod 0" test "$RC" -eq 0
check "build C2" test "$(live_build)" = build-c2
check "previous_sha = C1" test "$(state_get previous_sha)" = "$C1"
manual status
check "status C2 ni ko'rsatadi" contains "$OUT" "$C2"

# ======================================================================
section "7. Yuklab olish xatosi"
reset_calls
touch "$CTL/dl_fail"
forced "$C3"
check "kod 1" test "$RC" -eq 1
check "sayt tegilmadi: build C2" test "$(live_build)" = build-c2
check "sayt tegilmadi: manba C2" test "$(live_rev)" = 2
check "install chaqirilmadi" bash -c "! grep -q '^pnpm install' '$CALLS'"
check "restart chaqirilmadi" bash -c "! grep -q restart '$CALLS'"
check "holat: current_sha C2 qoldi" test "$(state_get current_sha)" = "$C2"
check "holat: last_result=failed" test "$(state_get last_result)" = failed
reset_ctl

# ======================================================================
section "8. Checksum mos kelmasligi"
reset_calls
cp "$REL/abdusoft-blog-$C3.tar.gz" "$SIM/c3.good"
echo "tamper" >>"$REL/abdusoft-blog-$C3.tar.gz"
forced "$C3"
check "buzilgan fayl: kod 1" test "$RC" -eq 1
check "buzilgan fayl: sabab Checksum" contains "$OUT" "Checksum mos kelmadi"
check "buzilgan fayl: sayt tegilmadi" test "$(live_build)" = build-c2
check "buzilgan fayl: install yo'q" bash -c "! grep -q '^pnpm install' '$CALLS'"
cp "$SIM/c3.good" "$REL/abdusoft-blog-$C3.tar.gz"
forced "$C3 $(printf '%064d' 0)"
check "workflow yuborgan sha256 mos emas: kod 1" test "$RC" -eq 1
check "workflow sha256: sayt tegilmadi" test "$(live_build)" = build-c2
echo "zzzz" >"$REL/abdusoft-blog-$C3.tar.gz.sha256"
forced "$C3"
check "noto'g'ri .sha256 formati: kod 1" test "$RC" -eq 1
echo "$(sha256f "$REL/abdusoft-blog-$C3.tar.gz")  x" >"$REL/abdusoft-blog-$C3.tar.gz.sha256"

# ======================================================================
section "9. Manifest / SHA / lockfile / Node / Next mos kelmasligi"
reset_calls
make_bundle "$C3" "build-c3-badcommit" "$C2"
forced "$C3"
check "manifest commit boshqa: kod 1" test "$RC" -eq 1
check "manifest commit boshqa: sabab" contains "$OUT" "Manifest commit"
check "manifest commit boshqa: tegilmadi" test "$(live_build)" = build-c2
make_bundle "$C3" "build-c3-badlock" "$C3" "$(printf '%064d' 1)"
forced "$C3"
check "lockfile xeshi mos emas: kod 1" test "$RC" -eq 1
check "lockfile xeshi: sabab" contains "$OUT" "lock"
check "lockfile xeshi: tegilmadi" test "$(live_build)" = build-c2
check "lockfile xeshi: install chaqirilmadi (manba tegilmadi)" bash -c "! grep -q '^pnpm install' '$CALLS'"
make_bundle "$C3" "build-c3-badnode" "$C3" "$(lockhash "$C3")" 16.4.5 1
forced "$C3"
check "Node major mos emas: kod 1" test "$RC" -eq 1
check "Node major: sabab" contains "$OUT" "Node major"
check "Node major: tegilmadi" test "$(live_build)" = build-c2
# Next versiyasi: install'dan KEYIN tekshiriladi — manba restore qilinishi kerak
make_bundle "$C3" "build-c3-badnext" "$C3" "$(lockhash "$C3")" 99.0.0
reset_calls
forced "$C3"
check "Next versiyasi mos emas: kod 1" test "$RC" -eq 1
check "Next versiyasi: sabab" contains "$OUT" "Next.js versiyasi mos emas"
check "Next versiyasi: build C2 qoldi" test "$(live_build)" = build-c2
check "Next versiyasi: manba C2 ga qaytarildi" test "$(live_rev)" = 2
check "Next versiyasi: restart yo'q" bash -c "! grep -q restart '$CALLS'"
check "Next versiyasi: .new qoldig'i yo'q" test ! -e "$LIVE/apps/web/.next.new"
check "Next versiyasi: lock farq qilgani uchun qayta install" bash -c "[ \$(grep -c '^pnpm install' '$CALLS') -eq 2 ]"

# ======================================================================
section "10. Arxiv xavfsizligi (path traversal, symlink, ruxsatsiz yo'l)"
mk_evil() { # mk_evil <tur>
  local d="$SIM/evil.$1"
  rm -rf "$d"
  mkdir -p "$d/apps/web/.next" "$d/apps/api/dist/src" "$d/packages/shared/dist"
  echo b >"$d/apps/web/.next/BUILD_ID"
  echo x >"$d/apps/api/dist/src/index.js"
  echo x >"$d/packages/shared/dist/index.js"
  printf '{"format":1,"commit":"%s","node_major":"24","next_version":"16.4.5","lockfile_sha256":"%s"}' "$C3" "$(lockhash "$C3")" >"$d/MANIFEST.json"
  python3 - "$1" "$d" "$REL/abdusoft-blog-$C3.tar.gz" <<'PY'
import sys, tarfile, os
kind, d, out = sys.argv[1:4]
with tarfile.open(out, "w:gz") as t:
    t.add(d + "/MANIFEST.json", "MANIFEST.json")
    t.add(d + "/apps", "apps")
    t.add(d + "/packages", "packages")
    if kind == "traversal":
        t.add(d + "/MANIFEST.json", "../evil.txt")
    elif kind == "absolute":
        t.add(d + "/MANIFEST.json", "/tmp/evil-abs.txt")
    elif kind == "extra":
        t.add(d + "/MANIFEST.json", "etc/cron.d/evil")
    elif kind == "symlink":
        ti = tarfile.TarInfo("apps/web/.next/link")
        ti.type = tarfile.SYMTYPE
        ti.linkname = "/etc/passwd"
        t.addfile(ti)
PY
  echo "$(sha256f "$REL/abdusoft-blog-$C3.tar.gz")  x" >"$REL/abdusoft-blog-$C3.tar.gz.sha256"
}
for kind in traversal absolute extra symlink; do
  mk_evil "$kind"
  forced "$C3"
  check "arxiv '$kind': rad etildi (kod 1)" test "$RC" -eq 1
  check "arxiv '$kind': sayt tegilmadi" test "$(live_build)" = build-c2
done
check "tashqariga hech narsa yozilmadi" bash -c "test ! -e '$SIM/evil.txt' && test ! -e /tmp/evil-abs.txt"
make_bundle "$C3" "build-c3"

# ======================================================================
section "11. Install xatosi (yangi lockfile) — eski build joyida, xizmatlar qayta ishga tushmaydi"
reset_calls
touch "$CTL/fail_install"
forced "$C3"
check "kod 1" test "$RC" -eq 1
check "build C2 qoldi" test "$(live_build)" = build-c2
check "manba C2 ga qaytarildi" test "$(live_rev)" = 2
check "restart chaqirilmadi" bash -c "! grep -q restart '$CALLS'"
check "backup/migrate chaqirilmadi" bash -c "! grep -q '^backup\|^migrate' '$CALLS'"
check "holat: current_sha C2" test "$(state_get current_sha)" = "$C2"
reset_ctl

# ======================================================================
section "12. Backup / migratsiya xatosi — build almashtirilmaydi"
reset_calls
touch "$CTL/fail_backup"
forced "$C3"
check "backup xatosi: kod 1" test "$RC" -eq 1
check "backup xatosi: migratsiya chaqirilmadi" bash -c "! grep -q '^migrate' '$CALLS'"
check "backup xatosi: build C2" test "$(live_build)" = build-c2
rm -f "$CTL/fail_backup"
reset_calls
touch "$CTL/fail_migrate"
forced "$C3"
check "migratsiya xatosi: kod 1" test "$RC" -eq 1
check "migratsiya xatosi: build C2 qoldi" test "$(live_build)" = build-c2
check "migratsiya xatosi: restart yo'q" bash -c "! grep -q restart '$CALLS'"
check "migratsiya xatosi: manba C2" test "$(live_rev)" = 2
check "migratsiya xatosi: eslatma (additive)" contains "$OUT" "additive"
reset_ctl

# ======================================================================
section "13. Health check xatosi -> avtomatik orqaga qaytarish"
reset_calls
echo build-c3 >"$CTL/bad_build"
forced "$C3"
check "kod 1" test "$RC" -eq 1
check "avtomatik orqaga qaytarish xabari" contains "$OUT" "ORQAGA QAYTARISH"
check "migratsiya qaytarilmasligi aytildi" contains "$OUT" "orqaga qaytarilmaydi"
check "build C2 ga qaytdi" test "$(live_build)" = build-c2
check "api dist C2" test "$(cat "$LIVE/apps/api/dist/src/index.js")" = api-build-c2
check "manba C2 ga qaytdi" test "$(live_rev)" = 2
check "restart aynan 2 marta (yangi, so'ng rollback) — sikl yo'q" bash -c "[ \$(grep -c '^restart' '$CALLS') -eq 2 ]"
check "holat: current_sha C2" test "$(state_get current_sha)" = "$C2"
check "holat: last_result=rolled_back" test "$(state_get last_result)" = rolled_back
check "holat: last_attempt_sha C3" test "$(state_get last_attempt_sha)" = "$C3"
reset_ctl

# ======================================================================
section "14. Rollback ham muvaffaqiyatsiz -> kod 2"
reset_calls
touch "$CTL/health_always_fail"
forced "$C3"
check "kod 2" test "$RC" -eq 2
check "qo'lda aralashuv xabari" contains "$OUT" "QO'LDA ARALASHING"
check "holat: rollback_failed" test "$(state_get last_result)" = rollback_failed
reset_ctl
# tiklash uchun toza C2
forced "$C2"
check "tiklash: C2 qayta deploy ok" test "$RC" -eq 0

# ======================================================================
section "15. Bir vaqtda ikkinchi deploy lock bilan to'sildi"
reset_calls
mkdir -p "$STATE"
(
  PATH="$SHIMS:$PATH"
  exec 9>"$STATE/deploy.lock"
  flock -n 9 || exit 1
  sleep 6
) &
HOLDER=$!
sleep 1
forced "$C3"
check "kod 3 (lock band)" test "$RC" -eq 3
check "aniq xabar" contains "$OUT" "boshqa deploy hozir ishlayapti"
check "lock ostida hech narsa o'zgarmadi" test "$(live_build)" = build-c2
check "lock paytida yuklab olish yo'q" bash -c "! grep -q download '$CALLS'"
wait "$HOLDER" 2>/dev/null
forced "$C3"
check "lock bo'shagach deploy ishlaydi" test "$RC" -eq 0

# ======================================================================
section "16. Qo'lda zudlik bilan rollback va eski commit'ni qayta deploy"
reset_calls
manual rollback
check "rollback kod 0" test "$RC" -eq 0
check "build C2 ga qaytdi" test "$(live_build)" = build-c2
check "rollback bundle yuklamadi (zudlik)" bash -c "! grep -q download '$CALLS'"
check "rollback restart qildi" bash -c "grep -q 'restart .* build=build-c2' '$CALLS'"
check "holat current_sha C2" test "$(state_get current_sha)" = "$C2"
manual rollback
check "ikkinchi rollback (prev yo'q, kod 1)" test "$RC" -eq 1
check "ikkinchi rollback: build o'zgarmadi" test "$(live_build)" = build-c2
forced "$C1"
check "eski commit (C1) qayta deploy: kod 0" test "$RC" -eq 0
check "eski commit: build C1" test "$(live_build)" = build-c1
check "eski commit: manba C1" test "$(live_rev)" = 1

# ======================================================================
section "17. Forced yo'lda faqat SHA/status ishlaydi; muhit o'zgaruvchilari e'tiborsiz"
OUT="$(BLOGDEPLOY_RELEASE_BASE_URL=https://evil.test BLOGDEPLOY_BACKUP_SCRIPT=/bin/false SSH_ORIGINAL_COMMAND="$C2" bash "$ENTRY" 2>&1)"
RC=$?
check "chaqiruvchi muhiti e'tiborsiz (kod 0)" test "$RC" -eq 0
check "evil.test'ga murojaat bo'lmadi" bash -c "! grep -q evil '$CALLS'"

echo
echo "Natija: $PASS o'tdi, $FAIL muvaffaqiyatsiz"
[ "$FAIL" -eq 0 ]

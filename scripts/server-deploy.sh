#!/bin/bash
# SERVER tomonidagi deploy skripti (GitHub Actions'dan, cheklangan SSH kalit
# orqali chaqiriladi). Serverda HECH NARSA build qilinmaydi: tayyor build
# GitHub'dagi runner'da yig'iladi va `deploy-builds` pre-release'ga yuklanadi;
# bu skript uni yuklab oladi, tekshiradi va almashtiradi.
#
# Odatda to'g'ridan-to'g'ri chaqirilmaydi — `abdusoft-blog-deploy-entry`
# (scripts/server-deploy-entry.sh, live papkadan TASHQARIDA o'rnatiladi) uni
# origin/main'dan olib ishga tushiradi. Batafsil: docs/deploy.md
#
# Ishlatilishi:
#   server-deploy.sh deploy <40-belgili-sha> [<bundle-sha256>]
#   server-deploy.sh rollback        # oldingi build'ga zudlik bilan qaytish (qo'lda)
#
# Chiqish kodlari: 0 — muvaffaqiyat; 1 — xato (sayt tegilmagan yoki avtomatik
# orqaga qaytarilgan); 2 — orqaga qaytarish ham muvaffaqiyatsiz (qo'lda
# aralashuv kerak); 3 — boshqa deploy ishlayapti (lock); 64 — noto'g'ri argument.
set -Eeuo pipefail
trap '' HUP PIPE # SSH ulanishi uzilsa ham deploy yarim yo'lda to'xtamasligi kerak
export LC_ALL=C GIT_TERMINAL_PROMPT=0

LIVE_DIR="${BLOGDEPLOY_LIVE_DIR:-/home/abdusoft/abdusoft-blog}"
SRC_DIR="${BLOGDEPLOY_SRC_DIR:-/home/abdusoft/abdusoft-blog-src}"
STATE_DIR="${BLOGDEPLOY_STATE_DIR:-/home/abdusoft/abdusoft-blog-deploy}"
NODE_BIN="${BLOGDEPLOY_NODE_BIN:-/opt/node-v24/bin}"
RELEASE_BASE_URL="${BLOGDEPLOY_RELEASE_BASE_URL:-https://github.com/AbduazizBobomalikovNode/abdusoft-blog/releases/download/deploy-builds}"
BACKUP_SCRIPT="${BLOGDEPLOY_BACKUP_SCRIPT:-$LIVE_DIR/scripts/backup-native.sh}"
SERVICES="${BLOGDEPLOY_SERVICES:-abdusoft-blog-api abdusoft-blog-web}"
API_HEALTH_URL="${BLOGDEPLOY_API_HEALTH_URL:-http://127.0.0.1:4000/health}"
WEB_HEALTH_URL="${BLOGDEPLOY_WEB_HEALTH_URL:-http://127.0.0.1:3100/}"
HEALTH_TRIES="${BLOGDEPLOY_HEALTH_TRIES:-30}"
HEALTH_INTERVAL="${BLOGDEPLOY_HEALTH_INTERVAL:-2}"
MAX_BUNDLE_BYTES="${BLOGDEPLOY_MAX_BUNDLE_BYTES:-314572800}" # 300 MB

export PATH="$NODE_BIN:/usr/local/bin:/usr/bin:/bin"

# live daraxt ichidagi build natijalari (bundle shularni almashtiradi)
OUTS="apps/web/.next apps/api/dist packages/shared/dist"
STAGE_DIR="$LIVE_DIR/.deploy-stage"
STATE_FILE="$STATE_DIR/state"
LOG_FILE="$STATE_DIR/deploy.log"
LOCK_FILE="$STATE_DIR/deploy.lock"

# rsync istisnolari deploy-vds.sh bilan BIR XIL (+ .env* kengaytirilgan va
# build almashtirish uchun vaqtinchalik papkalar).
RSYNC_EXCLUDES=(
  --exclude node_modules --exclude .next --exclude dist --exclude .data
  --exclude '.env*' --exclude .git --exclude .turbo --exclude coverage
  --exclude .next.new --exclude .next.prev --exclude .next.failed
  --exclude dist.new --exclude dist.prev --exclude dist.failed
  --exclude .deploy-stage
)

MODE=""
SHA=""
EXPECT_SHA256=""
PHASE="boshlanish" # boshlanish -> tayyorgarlik -> manba -> almashtirildi -> qayta-ishga-tushdi
PREV_SHA=""        # hozir xizmat qilayotgan (deploy boshida) commit; noma'lum bo'lishi mumkin
NEW_LOCK_HASH=""
WANT_NEXT=""
SWAPPED=""

usage() {
  echo "Ishlatilishi: server-deploy.sh deploy <sha> [<bundle-sha256>] | rollback" >&2
  exit 64
}

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
step() { echo "==> $*"; }
info() { echo "    $*"; }
warn() { echo "!!  $*" >&2; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

is_hex() { # is_hex <uzunlik> <qiymat>
  [ "${#2}" -eq "$1" ] && [[ "$2" != *[!0-9a-f]* ]]
}

# ---- holat fayli -----------------------------------------------------------
state_get() {
  [ -f "$STATE_FILE" ] || return 0
  grep -m1 "^$1=" "$STATE_FILE" 2>/dev/null | cut -d= -f2- || true
}

# write_state <kalit=qiymat>... — berilganlarni yangilaydi, qolganlarini saqlaydi.
write_state() {
  local tmp="$STATE_FILE.tmp.$$" keys="current_sha current_at previous_sha last_attempt_sha last_attempt_at last_result"
  local k kv v found
  : >"$tmp"
  for k in $keys; do
    v="$(state_get "$k")"
    for kv in "$@"; do
      if [ "${kv%%=*}" = "$k" ]; then v="${kv#*=}"; fi
    done
    found="$v"
    printf '%s=%s\n' "$k" "$found" >>"$tmp"
  done
  mv "$tmp" "$STATE_FILE"
}

# ---- build almashtirish (faqat rename) ------------------------------------
# swap_in: <out>.new -> <out>, eskisi -> <out>.prev
swap_in() {
  local rel
  SWAPPED=""
  for rel in $OUTS; do
    if [ -e "$LIVE_DIR/$rel" ]; then
      rm -rf "${LIVE_DIR:?}/$rel.prev"
      mv "$LIVE_DIR/$rel" "$LIVE_DIR/$rel.prev"
    fi
    mv "$LIVE_DIR/$rel.new" "$LIVE_DIR/$rel"
    SWAPPED="$SWAPPED $rel"
  done
}

# swap_back: SWAPPED ichidagilar uchun <out>.prev -> <out> (almashgan -> .failed)
swap_back() {
  local rel
  for rel in $SWAPPED; do
    if [ -e "$LIVE_DIR/$rel.prev" ]; then
      rm -rf "${LIVE_DIR:?}/$rel.failed"
      [ -e "$LIVE_DIR/$rel" ] && mv "$LIVE_DIR/$rel" "$LIVE_DIR/$rel.failed"
      mv "$LIVE_DIR/$rel.prev" "$LIVE_DIR/$rel"
    else
      warn "$rel.prev yo'q — $rel qaytarilmadi"
    fi
  done
  SWAPPED=""
}

# ---- manba daraxti ---------------------------------------------------------
checkout_and_sync() { # <sha>
  git -C "$SRC_DIR" checkout --quiet --force --detach "$1"
  git -C "$SRC_DIR" clean -fdxq
  # --checksum: git checkout mtime'ni yangilaydi; bir soniyada o'zgargan, o'lchami bir xil fayl o'tkazib yuborilmasin
  rsync -a --checksum --delete "${RSYNC_EXCLUDES[@]}" "$SRC_DIR/" "$LIVE_DIR/"
}

# restore_source: avvalgi commit manbasini qaytaradi (best-effort).
restore_source() {
  if [ -z "$PREV_SHA" ] || ! git -C "$SRC_DIR" cat-file -e "$PREV_SHA^{commit}" 2>/dev/null; then
    warn "Oldingi commit noma'lum — live manba daraxti qaytarilmadi (keyingi deploy to'liq qayta sinxronlaydi)."
    return 0
  fi
  step "Manba daraxti oldingi commit'ga qaytarilmoqda (${PREV_SHA:0:12})"
  if ! checkout_and_sync "$PREV_SHA"; then
    warn "Manbani qaytarib bo'lmadi — qo'lda tekshiring."
    return 1
  fi
  local lock_now
  lock_now="$(sha256_of "$LIVE_DIR/pnpm-lock.yaml")"
  if [ -n "$NEW_LOCK_HASH" ] && [ "$lock_now" != "$NEW_LOCK_HASH" ]; then
    info "pnpm-lock.yaml farq qildi — bog'liqliklar qayta o'rnatilmoqda"
    (cd "$LIVE_DIR" && pnpm install --frozen-lockfile) || warn "Qayta install muvaffaqiyatsiz — node_modules'ni qo'lda tekshiring."
  fi
}

# ---- xizmatlar -------------------------------------------------------------
restart_services() {
  # SERVICES bo'sh joy bilan ajratilgan, shuning uchun ataylab so'zlarga bo'linadi.
  # shellcheck disable=SC2086
  sudo -n systemctl restart $SERVICES
}

wait_http() { # <nom> <url>
  local i=1
  while [ "$i" -le "$HEALTH_TRIES" ]; do
    if curl -fsS -o /dev/null --max-time 5 "$2" 2>/dev/null; then
      info "$1: OK (urinish $i)"
      return 0
    fi
    sleep "$HEALTH_INTERVAL"
    i=$((i + 1))
  done
  warn "$1: javob yo'q ($HEALTH_TRIES urinishdan keyin)"
  return 1
}

health_check() {
  local ok=0
  wait_http "api /health" "$API_HEALTH_URL" || ok=1
  wait_http "web /" "$WEB_HEALTH_URL" || ok=1
  return "$ok"
}

# ---- yakuniy holatlar ------------------------------------------------------
cleanup_stage() {
  rm -rf "${STAGE_DIR:?}"
  local rel
  for rel in $OUTS; do rm -rf "${LIVE_DIR:?}/$rel.new"; done
}

on_error() {
  local line="$1"
  trap - ERR
  set +e
  warn "Xato (skript qatori $line, bosqich: $PHASE)."
  case "$PHASE" in
    boshlanish | tayyorgarlik)
      cleanup_stage
      warn "Sayt tegilmadi — ishlayotgan versiya o'zgarishsiz."
      write_state "last_attempt_sha=$SHA" "last_attempt_at=$(now)" "last_result=failed"
      ;;
    manba)
      cleanup_stage
      restore_source
      warn "Build almashtirilmadi, xizmatlar qayta ishga tushirilmadi — ishlayotgan versiya o'zgarishsiz."
      warn "Eslatma: migratsiya boshlangan bo'lsa, u additive (faqat qo'shuvchi) siyosat bo'yicha orqaga qaytarilmaydi."
      write_state "last_attempt_sha=$SHA" "last_attempt_at=$(now)" "last_result=failed"
      ;;
    almashtirildi)
      warn "Build almashtirilgan, lekin xizmatlar hali qayta ishga tushirilmagan — orqaga qaytarilmoqda."
      swap_back
      restore_source
      write_state "last_attempt_sha=$SHA" "last_attempt_at=$(now)" "last_result=failed"
      ;;
    *)
      warn "Kutilmagan holat ($PHASE) — qo'lda tekshiring: ./scripts/server-deploy.sh status / journalctl."
      write_state "last_attempt_sha=$SHA" "last_attempt_at=$(now)" "last_result=failed"
      ;;
  esac
  exit 1
}

# do_rollback <sabab>: swap_back + manba + restart + health. 0 — tiklandi.
do_rollback() {
  step "ORQAGA QAYTARISH: $1"
  warn "Eslatma: DB migratsiyalari additive siyosat bo'yicha orqaga qaytarilmaydi (eski kod yangi sxema bilan ishlaydi)."
  swap_back
  restore_source || true
  restart_services || { warn "Xizmatlarni qayta ishga tushirib bo'lmadi"; return 1; }
  sleep 1
  if health_check; then
    info "Orqaga qaytarish muvaffaqiyatli — oldingi build ishlayapti."
    return 0
  fi
  return 1
}

# ---- asosiy oqim -----------------------------------------------------------
setup_logging_and_lock() {
  mkdir -p "$STATE_DIR"
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    echo "XATO: boshqa deploy hozir ishlayapti (lock band). Tugashini kuting va qayta urinib ko'ring." >&2
    exit 3
  fi
  _logger() {
    local line
    while IFS= read -r line; do
      printf '%s %s\n' "$(now)" "$line" >>"$LOG_FILE" 2>/dev/null || true
      printf '%s\n' "$line" 2>/dev/null || true
    done
  }
  exec > >(_logger) 2>&1
}

deploy() {
  PHASE="boshlanish"
  PREV_SHA="$(state_get current_sha)"
  step "[1/9] Deploy so'rovi: ${SHA:0:12} (hozirgi: ${PREV_SHA:0:12})"
  info "Boshlandi: $(now)"

  [ -d "$LIVE_DIR/apps" ] || { warn "Live papka topilmadi: $LIVE_DIR"; return 1; }
  [ -d "$SRC_DIR/.git" ] || { warn "Manba clone topilmadi: $SRC_DIR (docs/deploy.md — bir martalik sozlash)"; return 1; }

  step "[2/9] Manba olinmoqda va commit tekshirilmoqda"
  git -C "$SRC_DIR" fetch --quiet --prune origin '+refs/heads/main:refs/remotes/origin/main'
  git -C "$SRC_DIR" cat-file -e "$SHA^{commit}" 2>/dev/null || { warn "Commit topilmadi: $SHA"; return 1; }
  if ! git -C "$SRC_DIR" merge-base --is-ancestor "$SHA" refs/remotes/origin/main; then
    warn "RAD ETILDI: $SHA origin/main tarkibida emas."
    return 1
  fi
  info "Commit origin/main tarkibida"

  PHASE="tayyorgarlik"
  step "[3/9] Build bundle yuklanmoqda"
  local name="abdusoft-blog-$SHA.tar.gz" dl="$STATE_DIR/download.$$"
  mkdir -p "$dl"
  # shellcheck disable=SC2064
  trap "rm -rf '$dl'" EXIT
  curl -fsSL --proto '=https' --retry 3 --retry-delay 3 --connect-timeout 20 --max-time 600 \
    -o "$dl/bundle.tar.gz" "$RELEASE_BASE_URL/$name"
  curl -fsSL --proto '=https' --retry 3 --retry-delay 3 --connect-timeout 20 --max-time 60 \
    -o "$dl/bundle.sha256" "$RELEASE_BASE_URL/$name.sha256"

  step "[4/9] Bundle tekshirilmoqda"
  local size actual declared
  size="$(wc -c <"$dl/bundle.tar.gz" | tr -d ' ')"
  [ "$size" -gt 0 ] && [ "$size" -le "$MAX_BUNDLE_BYTES" ] || { warn "Bundle hajmi mos emas: $size bayt"; return 1; }
  actual="$(sha256_of "$dl/bundle.tar.gz")"
  declared="$(cut -d' ' -f1 <"$dl/bundle.sha256" | head -n1)"
  is_hex 64 "$declared" || { warn ".sha256 fayli noto'g'ri formatda"; return 1; }
  [ "$actual" = "$declared" ] || { warn "Checksum mos kelmadi (yuklangan fayl .sha256 bilan farq qiladi)."; return 1; }
  if [ -n "$EXPECT_SHA256" ] && [ "$actual" != "$EXPECT_SHA256" ]; then
    warn "Checksum mos kelmadi: bundle workflow yuborgan sha256 bilan farq qiladi."
    return 1
  fi
  info "sha256 OK (${actual:0:16}…, $size bayt)"

  # Arxiv tarkibi: faqat ruxsat etilgan yo'llar; mutlaq yo'l, '..' va maxsus fayllar rad etiladi.
  local entry
  while IFS= read -r entry; do
    case "$entry" in
      /* | ../* | */../* | */.. | ..) warn "Xavfli yo'l arxivda: rad etildi"; return 1 ;;
      MANIFEST.json | apps | apps/ | apps/web | apps/web/ | apps/api | apps/api/ | packages | packages/ | packages/shared | packages/shared/) ;;
      apps/web/.next | apps/web/.next/* | apps/api/dist | apps/api/dist/* | packages/shared/dist | packages/shared/dist/*) ;;
      *) warn "Arxivda ruxsat etilmagan yo'l: rad etildi"; return 1 ;;
    esac
  done < <(tar -tzf "$dl/bundle.tar.gz")
  rm -rf "${STAGE_DIR:?}"
  mkdir -p "$STAGE_DIR"
  tar -xzf "$dl/bundle.tar.gz" -C "$STAGE_DIR"
  if [ -n "$(find "$STAGE_DIR" ! -type f ! -type d -print -quit)" ]; then
    warn "Arxivda oddiy bo'lmagan fayl (symlink/maxsus): rad etildi"
    return 1
  fi

  # Manifest
  local m="$STAGE_DIR/MANIFEST.json"
  [ -f "$m" ] || { warn "MANIFEST.json yo'q"; return 1; }
  get() { node -p 'const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]; v === undefined ? "" : String(v)' "$m" "$1"; }
  [ "$(get commit)" = "$SHA" ] || { warn "Manifest commit'i so'ralgan SHA'ga mos emas"; return 1; }
  [ "$(get format)" = "1" ] || { warn "Manifest formati qo'llab-quvvatlanmaydi"; return 1; }
  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$(get node_major)" = "$node_major" ] || { warn "Node major versiyasi mos emas (bundle: $(get node_major), server: $node_major)"; return 1; }
  NEW_LOCK_HASH="$(git -C "$SRC_DIR" show "$SHA:pnpm-lock.yaml" | { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; } | cut -d' ' -f1)"
  [ "$(get lockfile_sha256)" = "$NEW_LOCK_HASH" ] || { warn "pnpm-lock.yaml xeshi manifestdagi bilan mos emas"; return 1; }
  [ -f "$STAGE_DIR/apps/web/.next/BUILD_ID" ] || { warn "apps/web/.next/BUILD_ID yo'q"; return 1; }
  [ -f "$STAGE_DIR/apps/api/dist/src/index.js" ] || { warn "apps/api/dist/src/index.js yo'q"; return 1; }
  [ -f "$STAGE_DIR/packages/shared/dist/index.js" ] || { warn "packages/shared/dist/index.js yo'q"; return 1; }
  WANT_NEXT="$(get next_version)"
  info "Manifest OK: commit, Node $node_major, lockfile xeshi mos"

  local rel
  for rel in $OUTS; do
    rm -rf "${LIVE_DIR:?}/$rel.new"
    mv "$STAGE_DIR/$rel" "$LIVE_DIR/$rel.new"
  done
  rm -rf "${STAGE_DIR:?}"

  PHASE="manba"
  step "[5/9] Manba live papkaga sinxronlanmoqda va bog'liqliklar o'rnatilmoqda"
  checkout_and_sync "$SHA"
  (cd "$LIVE_DIR" && pnpm install --frozen-lockfile)
  local want="$WANT_NEXT" have
  have="$(cd "$LIVE_DIR/apps/web" && node -p 'require("next/package.json").version')"
  [ "$want" = "$have" ] || { warn "Next.js versiyasi mos emas (bundle: $want, serverda o'rnatilgan: $have)"; return 1; }
  info "Next.js $have — bundle bilan bir xil"

  step "[6/9] DB zaxirasi"
  bash "$BACKUP_SCRIPT"

  step "[7/9] Migratsiya"
  (cd "$LIVE_DIR" && pnpm api:migrate)

  step "[8/9] Build almashtirilmoqda va xizmatlar qayta ishga tushirilmoqda"
  PHASE="almashtirildi"
  swap_in
  info "Almashtirildi (eskisi *.prev sifatida saqlandi)"
  PHASE="qayta-ishga-tushdi"
  local restarted=1
  restart_services || restarted=0

  step "[9/9] Health check"
  sleep 1
  if [ "$restarted" -eq 0 ] || ! health_check; then
    trap - ERR
    if do_rollback "yangi build health check'dan o'tmadi"; then
      write_state "current_sha=$PREV_SHA" "current_at=$(now)" "previous_sha=" \
        "last_attempt_sha=$SHA" "last_attempt_at=$(now)" "last_result=rolled_back"
      warn "DEPLOY MUVAFFAQIYATSIZ: ${SHA:0:12} qaytarildi, ishlayotgan versiya: ${PREV_SHA:0:12}"
      exit 1
    fi
    write_state "last_attempt_sha=$SHA" "last_attempt_at=$(now)" "last_result=rollback_failed"
    warn "ORQAGA QAYTARISH HAM MUVAFFAQIYATSIZ — QO'LDA ARALASHING (journalctl -u abdusoft-blog-api -u abdusoft-blog-web; zaxira: ./scripts/deploy-vds.sh)."
    exit 2
  fi

  write_state "current_sha=$SHA" "current_at=$(now)" "previous_sha=$PREV_SHA" \
    "last_attempt_sha=$SHA" "last_attempt_at=$(now)" "last_result=ok"
  for rel in $OUTS; do rm -rf "${LIVE_DIR:?}/$rel.failed"; done
  step "Deploy tugadi: ${SHA:0:12} ishlayapti ($(now))"
}

rollback_cmd() {
  PHASE="boshlanish"
  PREV_SHA="$(state_get previous_sha)"
  local cur
  cur="$(state_get current_sha)"
  step "Qo'lda orqaga qaytarish (hozirgi: ${cur:0:12}, qaytariladigan: ${PREV_SHA:0:12})"
  local rel
  for rel in $OUTS; do
    [ -e "$LIVE_DIR/$rel.prev" ] || { warn "$rel.prev yo'q — qaytariladigan oldingi build mavjud emas"; return 1; }
  done
  SWAPPED="$OUTS"
  NEW_LOCK_HASH="$(sha256_of "$LIVE_DIR/pnpm-lock.yaml")"
  if do_rollback "qo'lda so'raldi"; then
    write_state "current_sha=$PREV_SHA" "current_at=$(now)" "previous_sha=" \
      "last_attempt_sha=$PREV_SHA" "last_attempt_at=$(now)" "last_result=ok"
    step "Orqaga qaytarildi."
    return 0
  fi
  write_state "last_attempt_at=$(now)" "last_result=rollback_failed"
  warn "ORQAGA QAYTARISH MUVAFFAQIYATSIZ — qo'lda aralashing."
  exit 2
}

# ---- kirish nuqtasi --------------------------------------------------------
[ $# -ge 1 ] || usage
MODE="$1"
case "$MODE" in
  deploy)
    [ $# -ge 2 ] && [ $# -le 3 ] || usage
    SHA="$2"
    is_hex 40 "$SHA" || usage
    if [ $# -eq 3 ]; then
      EXPECT_SHA256="$3"
      is_hex 64 "$EXPECT_SHA256" || usage
    fi
    ;;
  rollback)
    [ $# -eq 1 ] || usage
    ;;
  *) usage ;;
esac

setup_logging_and_lock
trap 'on_error $LINENO' ERR
if [ "$MODE" = deploy ]; then deploy; else rollback_cmd; fi

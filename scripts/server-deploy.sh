#!/bin/bash
# SERVER tomonidagi deploy skripti (GitHub Actions'dan, cheklangan SSH kalit
# orqali chaqiriladi). Serverda HECH NARSA build qilinmaydi: tayyor build
# GitHub'dagi runner'da yig'iladi, SHIFRLANADI va `deploy-builds` pre-release'ga
# yuklanadi; bu skript uni yuklab oladi, tekshiradi, shifrdan chiqaradi va
# almashtiradi.
#
# Odatda to'g'ridan-to'g'ri chaqirilmaydi — `abdusoft-blog-deploy-entry`
# (scripts/server-deploy-entry.sh, live papkadan TASHQARIDA o'rnatiladi) uni
# origin/main'dan olib ishga tushiradi. Batafsil: docs/deploy.md
#
# Ishlatilishi:
#   server-deploy.sh deploy [--force] <40-belgili-sha> <64-belgili-bundle-sha256>
#   server-deploy.sh rollback        # oldingi build'ga zudlik bilan qaytish (qo'lda)
#
# Chiqish kodlari: 0 — muvaffaqiyat; 1 — xato (sayt tegilmagan yoki avtomatik
# orqaga qaytarilgan); 2 — orqaga qaytarish ham muvaffaqiyatsiz (qo'lda
# aralashuv kerak); 3 — boshqa deploy ishlayapti (lock); 64 — noto'g'ri argument.
# Dekodlangan bundle, yuklamalar, snapshot, holat va zaxira fayllari boshqa foydalanuvchilarga o'qilmasin
# (umumiy server). Live daraxtga tushadigan narsalar (git checkout, tar, pnpm) `umask 022` ichida
# yaratiladi — ya'ni live daraxt rejimlari qo'lda deploy-vds.sh/rsync bergan bilan bir xil qoladi.
umask 077
set -Eeuo pipefail
trap '' HUP PIPE # SSH ulanishi uzilsa ham deploy yarim yo'lda to'xtamasligi kerak
export LC_ALL=C GIT_TERMINAL_PROMPT=0

LIVE_DIR="${BLOGDEPLOY_LIVE_DIR:-/home/abdusoft/abdusoft-blog}"
SRC_DIR="${BLOGDEPLOY_SRC_DIR:-/home/abdusoft/abdusoft-blog-src}"
STATE_DIR="${BLOGDEPLOY_STATE_DIR:-/home/abdusoft/abdusoft-blog-deploy}"
NODE_BIN="${BLOGDEPLOY_NODE_BIN:-/opt/node-v24/bin}"
RELEASE_BASE_URL="${BLOGDEPLOY_RELEASE_BASE_URL:-https://github.com/AbduazizBobomalikovNode/abdusoft-blog/releases/download/deploy-builds}"
BUNDLE_KEY_FILE="${BLOGDEPLOY_BUNDLE_KEY_FILE:-/home/abdusoft/.config/abdusoft-blog-deploy/bundle.key}"
BACKUP_SCRIPT="${BLOGDEPLOY_BACKUP_SCRIPT:-$LIVE_DIR/scripts/backup-native.sh}"
SERVICES="${BLOGDEPLOY_SERVICES:-abdusoft-blog-api abdusoft-blog-web}"
API_HEALTH_URL="${BLOGDEPLOY_API_HEALTH_URL:-http://127.0.0.1:4000/health}"
API_DB_URL="${BLOGDEPLOY_API_DB_URL:-http://127.0.0.1:4000/tags}" # bazaga haqiqatan so'rov yuboradigan endpoint
WEB_BASE_URL="${BLOGDEPLOY_WEB_BASE_URL:-http://127.0.0.1:3100}"
HEALTH_TRIES="${BLOGDEPLOY_HEALTH_TRIES:-30}"
HEALTH_INTERVAL="${BLOGDEPLOY_HEALTH_INTERVAL:-2}"
MAX_BUNDLE_BYTES="${BLOGDEPLOY_MAX_BUNDLE_BYTES:-314572800}"                # shifrlangan fayl, 300 MB
MAX_UNCOMPRESSED_BYTES="${BLOGDEPLOY_MAX_UNCOMPRESSED_BYTES:-1073741824}"    # 1 GB
MAX_ENTRIES="${BLOGDEPLOY_MAX_ENTRIES:-50000}"
MIN_FREE_MB="${BLOGDEPLOY_MIN_FREE_MB:-1024}"
LOG_MAX_BYTES="${BLOGDEPLOY_LOG_MAX_BYTES:-2097152}"
# Har bir bosqich uchun chegara (soniya) — osilib qolgan qadam lock'ni abadiy ushlab turmasin.
T_GIT="${BLOGDEPLOY_TIMEOUT_GIT:-120}"
T_FETCH="${BLOGDEPLOY_TIMEOUT_PNPM_FETCH:-600}"
T_INSTALL="${BLOGDEPLOY_TIMEOUT_INSTALL:-900}"
T_BACKUP="${BLOGDEPLOY_TIMEOUT_BACKUP:-600}"
T_MIGRATE="${BLOGDEPLOY_TIMEOUT_MIGRATE:-300}"
T_RESTART="${BLOGDEPLOY_TIMEOUT_RESTART:-120}"
T_DOWNLOAD="${BLOGDEPLOY_TIMEOUT_DOWNLOAD:-600}"

export PATH="$NODE_BIN:/usr/local/bin:/usr/bin:/bin"

# live daraxt ichidagi build natijalari (bundle shularni almashtiradi)
OUTS="apps/web/.next apps/api/dist packages/shared/dist"
STAGE_DIR="$LIVE_DIR/.deploy-stage"
STATE_FILE="$STATE_DIR/state"
LOG_FILE="$STATE_DIR/deploy.log"
LOCK_FILE="$STATE_DIR/deploy.lock"
SNAP_CUR="$STATE_DIR/src.cur"   # deploy boshlanishidagi live manba nusxasi (xatoda shundan tiklanadi)
SNAP_PREV="$STATE_DIR/src.prev" # oxirgi muvaffaqiyatli deploy'dan oldingi manba (*.prev build'ga mos)

# rsync istisnolari deploy-vds.sh bilan BIR XIL (+ .env* kengaytirilgan va
# build almashtirish uchun vaqtinchalik papkalar).
RSYNC_EXCLUDES=(
  --exclude node_modules --exclude .next --exclude dist --exclude .data
  --exclude '.env*' --exclude .git --exclude .turbo --exclude coverage
  --exclude .next.new --exclude .next.prev --exclude .next.failed
  --exclude dist.new --exclude dist.prev --exclude dist.failed
  --exclude .deploy-stage
)

UNK="noma'lum"
MODE=""
SHA=""
EXPECT_SHA256=""
FORCE=0
PHASE="boshlanish" # boshlanish -> tayyorgarlik -> manba -> almashtirildi -> qayta-ishga-tushdi
PREV_SHA=""        # hozir xizmat qilayotgan commit; live build qo'lda o'zgargan bo'lsa — noma'lum ("")
NEW_LOCK_HASH=""
WANT_NEXT=""
SWAPPED=""

usage() {
  echo "Ishlatilishi: server-deploy.sh deploy [--force] <sha> <bundle-sha256> | rollback" >&2
  exit 64
}

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
step() { echo "==> $*"; }
info() { echo "    $*"; }
warn() { echo "!!  $*" >&2; }

# run_to <soniya> <buyruq...> — vaqt chegarasi bilan (timeout normal xato yo'lidan o'tadi, kod 124).
run_to() {
  local secs="$1"
  shift
  timeout -k 10 "$secs" "$@"
}

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

# is_out <yo'l>: faqat uchta ma'lum build chiqish yo'lidan biriga AYNAN teng bo'lsa 0.
is_out() {
  local o
  for o in $OUTS; do
    if [ "$1" = "$o" ]; then return 0; fi
  done
  return 1
}

# clean_out_list <qiymat>: holat faylidan o'qilgan ro'yxatdan faqat ma'lum yo'llarni qoldiradi.
clean_out_list() {
  local arr=() w res=""
  IFS=' ' read -r -a arr <<<"$1" || true
  for w in ${arr[@]+"${arr[@]}"}; do
    if is_out "$w"; then
      res="${res:+$res }$w"
    else
      warn "Holat faylidagi noma'lum yo'l e'tiborsiz qoldirildi (build chiqish yo'llariga mos emas)."
    fi
  done
  printf '%s' "$res"
}

live_build_id() { cat "$LIVE_DIR/apps/web/.next/BUILD_ID" 2>/dev/null || true; }

# ---- holat fayli -----------------------------------------------------------
state_get() {
  [ -f "$STATE_FILE" ] || return 0
  grep -m1 "^$1=" "$STATE_FILE" 2>/dev/null | cut -d= -f2- || true
}

# write_state <kalit=qiymat>... — berilganlarni yangilaydi, qolganlarini saqlaydi.
write_state() {
  local tmp="$STATE_FILE.tmp.$$"
  local keys="current_sha current_at previous_sha last_attempt_sha last_attempt_at last_result live_build_id bundle_sha256 phase swap_cur swap_done"
  local k kv v
  : >"$tmp"
  for k in $keys; do
    v="$(state_get "$k")"
    for kv in "$@"; do
      if [ "${kv%%=*}" = "$k" ]; then v="${kv#*=}"; fi
    done
    printf '%s=%s\n' "$k" "$v" >>"$tmp"
  done
  mv "$tmp" "$STATE_FILE"
}

# ---- build almashtirish (faqat rename) ------------------------------------
# swap_in: <out>.new -> <out>, eskisi -> <out>.prev. Jarayon holat fayliga
# yoziladi (swap_cur/swap_done) — skript o'rtada o'ldirilsa, recover() bilishi uchun.
# Rename o'rtada yiqilsa, shu papka darrov tiklanadi.
swap_in() {
  local rel sdone=""
  SWAPPED=""
  for rel in $OUTS; do
    write_state "swap_cur=$rel" "swap_done=$sdone"
    if [ -e "$LIVE_DIR/$rel" ]; then
      rm -rf "${LIVE_DIR:?}/$rel.prev"
      mv "$LIVE_DIR/$rel" "$LIVE_DIR/$rel.prev"
      if ! mv "$LIVE_DIR/$rel.new" "$LIVE_DIR/$rel"; then
        warn "$rel.new ni joyiga qo'yib bo'lmadi — eskisi qaytarilmoqda"
        mv "$LIVE_DIR/$rel.prev" "$LIVE_DIR/$rel"
        return 1
      fi
    else
      mv "$LIVE_DIR/$rel.new" "$LIVE_DIR/$rel"
    fi
    sdone="${sdone:+$sdone }$rel"
    SWAPPED="$sdone"
    write_state "swap_cur=" "swap_done=$sdone"
  done
}

# swap_back: SWAPPED ichidagilar uchun <out>.prev -> <out> (almashgan -> .failed)
swap_back() {
  local rel
  for rel in $SWAPPED; do
    if [ -e "$LIVE_DIR/$rel.prev" ]; then
      rm -rf "${LIVE_DIR:?}/$rel.failed"
      if [ -e "$LIVE_DIR/$rel" ]; then mv "$LIVE_DIR/$rel" "$LIVE_DIR/$rel.failed"; fi
      mv "$LIVE_DIR/$rel.prev" "$LIVE_DIR/$rel"
    else
      info "$rel.prev yo'q — $rel allaqachon qaytarilgan deb hisoblandi"
    fi
  done
  SWAPPED=""
}

# ---- manba daraxti ---------------------------------------------------------
sync_source() {
  # --checksum: git checkout mtime'ni yangilaydi; bir soniyada o'zgargan, o'lchami bir xil fayl o'tkazib yuborilmasin
  rsync -a --checksum --delete "${RSYNC_EXCLUDES[@]}" "$SRC_DIR/" "$LIVE_DIR/"
}

# snapshot_source: deploy boshlanishidagi live manbaning nusxasi. Git commit'ga
# tayanmaymiz: live qo'lda (deploy-vds.sh) o'zgargan bo'lsa ham aynan o'sha holat tiklanadi.
snapshot_source() {
  rm -rf "${SNAP_CUR:?}" "${SNAP_CUR:?}.tmp"
  mkdir -p "$SNAP_CUR.tmp"
  rsync -a --delete "${RSYNC_EXCLUDES[@]}" "$LIVE_DIR/" "$SNAP_CUR.tmp/"
  chmod 700 "$SNAP_CUR.tmp"
  mv "$SNAP_CUR.tmp" "$SNAP_CUR" # to'liq nusxa bo'lgandagina tiklash uchun yaroqli
}

# restore_source <snapshot-papka>: live manbani snapshot'dan qaytaradi (best-effort).
restore_source() {
  local snap="$1"
  if [ ! -d "$snap" ]; then
    warn "Manba nusxasi ($snap) yo'q — live manba daraxti qaytarilmadi (keyingi deploy to'liq sinxronlaydi)."
    return 0
  fi
  step "Manba daraxti avvalgi holatiga qaytarilmoqda"
  if ! rsync -a --checksum --delete "${RSYNC_EXCLUDES[@]}" "$snap/" "$LIVE_DIR/"; then
    warn "Manbani qaytarib bo'lmadi — qo'lda tekshiring."
    return 1
  fi
  if [ -f "$snap/pnpm-lock.yaml" ] && [ -n "$NEW_LOCK_HASH" ] && [ "$(sha256_of "$snap/pnpm-lock.yaml")" != "$NEW_LOCK_HASH" ]; then
    info "pnpm-lock.yaml farq qildi — bog'liqliklar qayta o'rnatilmoqda (avval oflayn)"
    (umask 022; run_to "$T_INSTALL" pnpm install --frozen-lockfile --offline) ||
      (umask 022; run_to "$T_INSTALL" pnpm install --frozen-lockfile) ||
      warn "Qayta install muvaffaqiyatsiz — node_modules'ni qo'lda tekshiring."
  fi
  rm -rf "${snap:?}"
}

# ---- xizmatlar -------------------------------------------------------------
service_pids() {
  local svc
  for svc in $SERVICES; do
    systemctl show -p MainPID --value "$svc" 2>/dev/null || echo unknown
  done | tr '\n' ' '
}

# Haqiqatan qayta ishga tushganini isbotlaydi: `systemctl restart` natijasi VA har xizmatning MainPID'i o'zgargan.
restart_services() {
  local before after
  before="$(service_pids)"
  # SERVICES bo'sh joy bilan ajratilgan, shuning uchun ataylab so'zlarga bo'linadi.
  # shellcheck disable=SC2086
  run_to "$T_RESTART" sudo -n systemctl restart $SERVICES || return 1
  after="$(service_pids)"
  if [ "$before" = "$after" ] && [[ "$before" != *unknown* ]]; then
    warn "Xizmatlar MainPID'i o'zgarmadi ($SERVICES) — qayta ishga tushmagan ko'rinadi."
    return 1
  fi
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

# Yangi build'ni VA bazani isbotlaydi: web — joriy BUILD_ID'ning statik fayli
# (eski jarayon javob bermaydi) va "/"; API — /health va bazaga so'rov yuboradigan endpoint.
health_check() {
  local ok=0 bid
  bid="$(live_build_id)"
  wait_http "api /health" "$API_HEALTH_URL" || ok=1
  wait_http "api (baza)" "$API_DB_URL" || ok=1
  wait_http "web /" "$WEB_BASE_URL/" || ok=1
  if [ -n "$bid" ]; then
    wait_http "web build $bid" "$WEB_BASE_URL/_next/static/$bid/_buildManifest.js" || ok=1
  else
    warn "BUILD_ID o'qib bo'lmadi"
    ok=1
  fi
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
    boshlanish | tayyorgarlik | tiklash)
      cleanup_stage
      warn "Sayt tegilmadi — ishlayotgan versiya o'zgarishsiz."
      ;;
    manba)
      cleanup_stage
      restore_source "$SNAP_CUR"
      warn "Build almashtirilmadi, xizmatlar qayta ishga tushirilmadi — ishlayotgan versiya o'zgarishsiz."
      warn "Eslatma: migratsiya boshlangan bo'lsa, u additive (faqat qo'shuvchi) siyosat bo'yicha orqaga qaytarilmaydi."
      ;;
    *)
      warn "Build almashtirilgan edi — orqaga qaytarilmoqda."
      swap_back
      cleanup_stage
      restore_source "$SNAP_CUR"
      if [ "$PHASE" = "qayta-ishga-tushdi" ]; then
        restart_services || warn "Xizmatlarni qayta ishga tushirib bo'lmadi — qo'lda tekshiring."
      fi
      ;;
  esac
  write_state "phase=idle" "swap_cur=" "swap_done=" \
    "last_attempt_sha=$SHA" "last_attempt_at=$(now)" "last_result=failed"
  exit 1
}

# do_rollback <sabab> <snapshot>: swap_back + manba + restart + health. 0 — tiklandi.
do_rollback() {
  step "ORQAGA QAYTARISH: $1"
  warn "Eslatma: DB migratsiyalari additive siyosat bo'yicha orqaga qaytarilmaydi (eski kod yangi sxema bilan ishlaydi)."
  swap_back
  restore_source "$2" || true
  restart_services || { warn "Xizmatlarni qayta ishga tushirib bo'lmadi"; return 1; }
  sleep 1
  if health_check; then
    info "Orqaga qaytarish muvaffaqiyatli — oldingi build ishlayapti."
    return 0
  fi
  return 1
}

# recover_interrupted: oldingi deploy o'ldirilgan (SIGKILL, elektr o'chishi) bo'lsa — yarim holatdan tiklaydi.
# Hech qachon *.prev'ni allaqachon almashgan build bilan ustiga yozmaydi.
recover_interrupted() {
  local ph
  # Holat fayli bor-u, o'qib bo'lmasa (bo'sh/buzilgan): sukut bilan o'tkazib yubormaymiz.
  if [ -f "$STATE_FILE" ] && { [ ! -s "$STATE_FILE" ] || ! grep -q '^phase=' "$STATE_FILE" || grep -qv '^[a-z0-9_]*=' "$STATE_FILE"; }; then
    warn "Holat fayli ($STATE_FILE) bo'sh yoki o'qib bo'lmaydi — oldingi holat NOMA'LUM. Yarim qolgan deploy izlari (*.prev, src.cur) tekshiriladi."
    NEW_LOCK_HASH="$(sha256_of "$LIVE_DIR/pnpm-lock.yaml" 2>/dev/null || true)"
    cleanup_stage
    if [ -d "$SNAP_CUR" ]; then
      info "Yarim qolgan snapshot topildi — manba shundan tiklanadi"
      restore_source "$SNAP_CUR" || true
    fi
    : >"$STATE_FILE"
    write_state "phase=idle"
    return 0
  fi
  ph="$(state_get phase)"
  case "$ph" in
    "" | idle) return 0 ;;
  esac
  step "OGOHLANTIRISH: oldingi deploy yarim qolgan (bosqich: $ph) — avtomatik tiklanmoqda"
  PHASE="tiklash"
  NEW_LOCK_HASH="$(sha256_of "$LIVE_DIR/pnpm-lock.yaml" 2>/dev/null || true)"
  local rel cur sdone
  case "$ph" in
    source)
      cleanup_stage
      restore_source "$SNAP_CUR" || true
      write_state "phase=idle" "swap_cur=" "swap_done=" "live_build_id=$(live_build_id)" "bundle_sha256=" "last_result=recovered"
      warn "Manba tiklandi, build o'zgarmagan. So'rovingizni qayta yuboring."
      exit 1
      ;;
    swapping | restarting)
      cur="$(state_get swap_cur)"
      if [ -n "$cur" ] && ! is_out "$cur"; then
        warn "Holat faylidagi swap_cur noma'lum yo'l — e'tiborsiz qoldirildi."
        cur=""
      fi
      sdone="$(clean_out_list "$(state_get swap_done)")"
      SWAPPED="$sdone"
      if [ -n "$cur" ]; then
        # Almashtirish o'rtasida o'ldirilgan papka
        if [ ! -e "$LIVE_DIR/$cur" ] && [ -e "$LIVE_DIR/$cur.prev" ]; then
          mv "$LIVE_DIR/$cur.prev" "$LIVE_DIR/$cur"
          info "$cur: yarim almashtirish tiklandi"
        elif [ -e "$LIVE_DIR/$cur" ] && [ ! -e "$LIVE_DIR/$cur.new" ] && [ -e "$LIVE_DIR/$cur.prev" ]; then
          SWAPPED="${SWAPPED:+$SWAPPED }$cur"
        fi
      fi
      for rel in $SWAPPED; do
        # .prev yo'q-u, live papka bor: oldingi (o'ldirilgan) rollback uni allaqachon qaytargan. Ikkalasi ham yo'q — rad etamiz.
        if [ ! -e "$LIVE_DIR/$rel.prev" ] && [ ! -e "$LIVE_DIR/$rel" ]; then
          warn "$rel ham, $rel.prev ham yo'q — avtomatik tiklab bo'lmaydi. Qo'lda: ./scripts/deploy-vds.sh"
          write_state "last_result=rollback_failed"
          exit 2
        fi
      done
      cleanup_stage
      if do_rollback "yarim qolgan deploy tiklanmoqda" "$SNAP_CUR"; then
        write_state "phase=idle" "swap_cur=" "swap_done=" "current_sha=" "previous_sha=" \
          "live_build_id=$(live_build_id)" "bundle_sha256=" "last_result=recovered"
        warn "Oldingi deploy yarim qolgan edi; sayt oldingi build'ga qaytarildi. So'rovingizni qayta yuboring."
        exit 1
      fi
      write_state "phase=idle" "swap_cur=" "swap_done=" "live_build_id=$(live_build_id)" "bundle_sha256=" "last_result=rollback_failed"
      warn "TIKLASH MUVAFFAQIYATSIZ — QO'LDA ARALASHING (journalctl -u abdusoft-blog-api -u abdusoft-blog-web; zaxira: ./scripts/deploy-vds.sh)."
      exit 2
      ;;
    *)
      warn "Noma'lum holat bosqichi '$ph' — qo'lda tekshiring: $STATE_FILE"
      exit 2
      ;;
  esac
}

# ---- boshlang'ich tayyorgarlik ---------------------------------------------
setup_logging_and_lock() {
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR" # holat, log, yuklamalar va snapshot'lar shu yerda — boshqalarga yopiq
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    echo "XATO: boshqa deploy hozir ishlayapti (lock band). Tugashini kuting va qayta urinib ko'ring." >&2
    exit 3
  fi
  # log aylantirish: katta bo'lsa — deploy.log.1'ga
  if [ -f "$LOG_FILE" ] && [ "$(wc -c <"$LOG_FILE" | tr -d ' ')" -gt "$LOG_MAX_BYTES" ]; then
    mv -f "$LOG_FILE" "$LOG_FILE.1"
  fi
  _logger() {
    local line
    while IFS= read -r line; do
      printf '%s %s\n' "$(now)" "$line" >>"$LOG_FILE" 2>/dev/null || true
      printf '%s\n' "$line" 2>/dev/null || true
    done
  }
  exec > >(_logger) 2>&1
  # eski yuklamalar va *.failed qoldiqlari (lock bizda — hech kim ishlatmayapti)
  rm -rf "${STATE_DIR:?}"/download.* 2>/dev/null || true
}

cleanup_leftovers() {
  # Tiklash bosqichidan keyin phase=idle: qolgan snapshot'lar yetim (to'liq bo'lmagan yoki eskirgan).
  rm -rf "${SNAP_CUR:?}" "${SNAP_CUR:?}.tmp"
  local rel
  for rel in $OUTS; do rm -rf "${LIVE_DIR:?}/$rel.failed"; done
  cleanup_stage
}

check_key_file() {
  local mode
  if [ ! -f "$BUNDLE_KEY_FILE" ] || [ "$(tr -d '[:space:]' <"$BUNDLE_KEY_FILE" | wc -c | tr -d ' ')" -lt 32 ]; then
    warn "Bundle shifrlash kaliti topilmadi, bo'sh yoki juda qisqa (kamida 32 belgi): $BUNDLE_KEY_FILE (docs/deploy.md). Hech narsa o'zgartirilmadi."
    return 1
  fi
  mode="$(stat -c %a "$BUNDLE_KEY_FILE" 2>/dev/null || stat -f %Lp "$BUNDLE_KEY_FILE" 2>/dev/null || echo unknown)"
  case "$mode" in
    600 | 400) ;;
    *) warn "Kalit fayli ruxsati $mode — faqat 600 bo'lishi kerak (chmod 600). Hech narsa o'zgartirilmadi."; return 1 ;;
  esac
}

check_free_space() {
  local kb
  kb="$(df -Pk "$STATE_DIR" | awk 'NR==2 {print $4}')"
  if [ "$kb" -lt $((MIN_FREE_MB * 1024)) ]; then
    warn "Diskda bo'sh joy yetarli emas: $((kb / 1024)) MB < $MIN_FREE_MB MB. Hech narsa o'zgartirilmadi."
    return 1
  fi
}

# NEXT_PUBLIC_* qiymatlari bundle'dagi bilan serverdagi .env.production'da farq qilsa — ogohlantirish (xato emas).
warn_public_env_drift() { # <manifest>
  local envfile="$LIVE_DIR/apps/web/.env.production"
  [ -f "$envfile" ] || return 0
  # shellcheck disable=SC2016
  node -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).public_env || {};
    const diff = [];
    for (const raw of fs.readFileSync(process.argv[2], "utf8").split("\n")) {
      const g = /^\s*(NEXT_PUBLIC_[A-Z0-9_]+)\s*=(.*)$/.exec(raw);
      if (!g) continue;
      const v = g[2].trim().replace(/^(["\x27])(.*)\1$/, "$2");
      if ((m[g[1]] ?? "") !== v) diff.push(g[1]);
    }
    if (diff.length) {
      console.error("!!  DIQQAT: bundle (runner) va serverdagi apps/web/.env.production NEXT_PUBLIC_* qiymatlari FARQ QILADI: " + diff.join(", "));
      console.error("!!  Build runner qiymatlari bilan yig\x27ilgan (GitHub environment variables). Kerak bo\x27lsa ularni yangilang. Deploy davom etadi.");
    }
  ' "$1" "$envfile" || true
}

# ---- asosiy oqim -----------------------------------------------------------
deploy() {
  PHASE="boshlanish"
  local actual
  actual="$(live_build_id)"
  if [ -n "$actual" ] && [ "$(state_get live_build_id)" = "$actual" ]; then
    PREV_SHA="$(state_get current_sha)"
  else
    PREV_SHA=""
    warn "Live build oxirgi pipeline deploy'idagi bilan mos emas (birinchi ishga tushirish yoki qo'lda deploy-vds.sh). Oldingi commit NOMA'LUM deb olinadi; build rollback ishlayveradi."
  fi
  step "[1/9] Deploy so'rovi: ${SHA:0:12} (hozirgi: ${PREV_SHA:0:12})"
  info "Boshlandi: $(now)"

  [ -d "$LIVE_DIR/apps" ] || { warn "Live papka topilmadi: $LIVE_DIR"; return 1; }
  [ -d "$SRC_DIR/.git" ] || { warn "Manba clone topilmadi: $SRC_DIR (docs/deploy.md — bir martalik sozlash)"; return 1; }
  cd "$LIVE_DIR"
  check_key_file || return 1
  check_free_space || return 1
  cleanup_leftovers

  step "[2/9] Manba olinmoqda va commit tekshirilmoqda"
  run_to "$T_GIT" git -C "$SRC_DIR" fetch --quiet --prune origin '+refs/heads/main:refs/remotes/origin/main'
  git -C "$SRC_DIR" cat-file -e "$SHA^{commit}" 2>/dev/null || { warn "Commit topilmadi: $SHA"; return 1; }
  if ! git -C "$SRC_DIR" merge-base --is-ancestor "$SHA" refs/remotes/origin/main; then
    warn "RAD ETILDI: $SHA origin/main tarkibida emas."
    return 1
  fi
  info "Commit origin/main tarkibida"

  PHASE="tayyorgarlik"
  step "[3/9] Shifrlangan bundle yuklanmoqda"
  local name="abdusoft-blog-$SHA.tar.gz.enc" dl="$STATE_DIR/download.$$"
  mkdir -p "$dl"
  # shellcheck disable=SC2064
  trap "rm -rf '$dl'" EXIT
  curl -fsSL --proto '=https' --retry 3 --retry-delay 3 --connect-timeout 20 --max-time "$T_DOWNLOAD" \
    -o "$dl/bundle.enc" "$RELEASE_BASE_URL/$name"
  curl -fsSL --proto '=https' --retry 3 --retry-delay 3 --connect-timeout 20 --max-time 60 \
    -o "$dl/bundle.sha256" "$RELEASE_BASE_URL/$name.sha256"

  step "[4/9] Bundle tekshirilmoqda, shifrdan chiqarilmoqda va ochilmoqda"
  local size actual_sum declared
  size="$(wc -c <"$dl/bundle.enc" | tr -d ' ')"
  [ "$size" -gt 0 ] && [ "$size" -le "$MAX_BUNDLE_BYTES" ] || { warn "Bundle hajmi mos emas: $size bayt"; return 1; }
  actual_sum="$(sha256_of "$dl/bundle.enc")"
  declared="$(cut -d' ' -f1 <"$dl/bundle.sha256" | head -n1)"
  is_hex 64 "$declared" || { warn ".sha256 fayli noto'g'ri formatda"; return 1; }
  [ "$actual_sum" = "$declared" ] || { warn "Checksum mos kelmadi (yuklangan fayl .sha256 bilan farq qiladi)."; return 1; }
  # Asosiy ishonch: hash SSH kanalidan keladi (release'dan emas).
  [ "$actual_sum" = "$EXPECT_SHA256" ] || { warn "Checksum mos kelmadi: bundle workflow SSH orqali yuborgan sha256 bilan farq qiladi."; return 1; }
  info "sha256 OK (${actual_sum:0:16}…, $size bayt)"

  # Kalit nafaqat buyruq qatoriga — umuman ekranga ham chiqmaydi (-pass file:).
  if ! openssl enc -d -aes-256-cbc -pbkdf2 -md sha256 -iter 200000 -pass "file:$BUNDLE_KEY_FILE" \
    -in "$dl/bundle.enc" -out "$dl/bundle.tar.gz" 2>/dev/null; then
    warn "Shifrdan chiqarib bo'lmadi — kalit noto'g'ri yoki bundle buzilgan (DEPLOY_BUNDLE_KEY va serverdagi kalit fayli bir xilmi?). Sayt tegilmadi."
    return 1
  fi
  gzip -t "$dl/bundle.tar.gz" 2>/dev/null || { warn "Shifrdan chiqqan fayl gzip emas — kalit noto'g'ri bo'lishi mumkin. Sayt tegilmadi."; return 1; }

  # Arxiv xavfsizligi: hajm/soni chegarasi, faqat oddiy fayl va papka, ruxsat etilgan yo'llar.
  local unc entries
  unc="$({ gzip -dc "$dl/bundle.tar.gz" 2>/dev/null | head -c "$((MAX_UNCOMPRESSED_BYTES + 1))" | wc -c; } || true)"
  unc="$(echo "$unc" | tr -d ' ')"
  [ "${unc:-0}" -le "$MAX_UNCOMPRESSED_BYTES" ] || { warn "Arxiv ochilgach juda katta (> $MAX_UNCOMPRESSED_BYTES bayt): rad etildi"; return 1; }
  entries="$(tar -tzf "$dl/bundle.tar.gz" | wc -l | tr -d ' ')"
  [ "$entries" -gt 0 ] && [ "$entries" -le "$MAX_ENTRIES" ] || { warn "Arxivdagi yozuvlar soni mos emas: $entries"; return 1; }
  local tline
  while IFS= read -r tline; do
    case "${tline:0:1}" in
      - | d) ;;
      *) warn "Arxivda oddiy bo'lmagan yozuv (symlink/hardlink/qurilma/FIFO): rad etildi"; return 1 ;;
    esac
  done < <(tar -tvzf "$dl/bundle.tar.gz")
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
  (umask 022; tar -xzf "$dl/bundle.tar.gz" -C "$STAGE_DIR" --no-same-owner --no-same-permissions)
  if [ -n "$(find "$STAGE_DIR" ! -type f ! -type d -print -quit)" ]; then
    warn "Arxivda oddiy bo'lmagan fayl (symlink/maxsus): rad etildi"
    return 1
  fi

  # Manifest
  local m="$STAGE_DIR/MANIFEST.json"
  [ -f "$m" ] || { warn "MANIFEST.json yo'q"; return 1; }
  get() { node -p 'const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]; v === undefined ? "" : String(v)' "$m" "$1"; }
  [ "$(get commit)" = "$SHA" ] || { warn "Manifest commit'i so'ralgan SHA'ga mos emas"; return 1; }
  [ "$(get format)" = "2" ] || { warn "Manifest formati qo'llab-quvvatlanmaydi"; return 1; }
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
  warn_public_env_drift "$m"

  # Bog'liqliklarni OLDINDAN yuklab olamiz (tarmoq xavfli lahzadan oldin; live daraxt hali tegilmagan).
  (umask 022; git -C "$SRC_DIR" checkout --quiet --force --detach "$SHA" && git -C "$SRC_DIR" clean -fdxq)
  info "pnpm fetch (bog'liqliklar do'konga)"
  (umask 022; cd "$SRC_DIR" && run_to "$T_FETCH" pnpm fetch)

  local rel
  for rel in $OUTS; do
    rm -rf "${LIVE_DIR:?}/$rel.new"
    mv "$STAGE_DIR/$rel" "$LIVE_DIR/$rel.new"
  done
  rm -rf "${STAGE_DIR:?}"

  PHASE="manba"
  step "[5/9] Manba live papkaga sinxronlanmoqda va bog'liqliklar o'rnatilmoqda (oflayn)"
  snapshot_source
  write_state "phase=source"
  sync_source
  (umask 022; run_to "$T_INSTALL" pnpm install --frozen-lockfile --offline)
  local want="$WANT_NEXT" have
  have="$(cd "$LIVE_DIR/apps/web" && node -p 'require("next/package.json").version')"
  [ "$want" = "$have" ] || { warn "Next.js versiyasi mos emas (bundle: $want, serverda o'rnatilgan: $have)"; return 1; }
  info "Next.js $have — bundle bilan bir xil"

  step "[6/9] DB zaxirasi (faqat baza)"
  run_to "$T_BACKUP" bash "$BACKUP_SCRIPT" --db-only

  step "[7/9] Migratsiya"
  (umask 022; run_to "$T_MIGRATE" pnpm api:migrate)

  step "[8/9] Build almashtirilmoqda va xizmatlar qayta ishga tushirilmoqda"
  PHASE="almashtirildi"
  write_state "phase=swapping" "swap_cur=" "swap_done="
  swap_in
  write_state "phase=restarting"
  info "Almashtirildi (eskisi *.prev sifatida saqlandi)"
  PHASE="qayta-ishga-tushdi"
  local restarted=1
  restart_services || restarted=0

  step "[9/9] Health check"
  sleep 1
  if [ "$restarted" -eq 0 ] || ! health_check; then
    trap - ERR
    if do_rollback "yangi build health check'dan o'tmadi" "$SNAP_CUR"; then
      write_state "phase=idle" "swap_cur=" "swap_done=" "current_sha=$PREV_SHA" "current_at=$(now)" "previous_sha=" \
        "live_build_id=$(live_build_id)" "bundle_sha256=" "last_attempt_sha=$SHA" "last_attempt_at=$(now)" "last_result=rolled_back"
      warn "DEPLOY MUVAFFAQIYATSIZ: ${SHA:0:12} qaytarildi, ishlayotgan versiya: ${PREV_SHA:-$UNK}"
      exit 1
    fi
    # builds allaqachon qaytarilgan (faqat health o'tmadi) — keyingi so'rov yarim holat deb tiklashga urinmasin
    write_state "phase=idle" "swap_cur=" "swap_done=" "current_sha=$PREV_SHA" "previous_sha=" "live_build_id=$(live_build_id)" "bundle_sha256=" \
      "last_attempt_sha=$SHA" "last_attempt_at=$(now)" "last_result=rollback_failed"
    warn "ORQAGA QAYTARISH HAM MUVAFFAQIYATSIZ — QO'LDA ARALASHING (journalctl -u abdusoft-blog-api -u abdusoft-blog-web; zaxira: ./scripts/deploy-vds.sh)."
    exit 2
  fi

  write_state "phase=idle" "swap_cur=" "swap_done=" "current_sha=$SHA" "current_at=$(now)" "previous_sha=$PREV_SHA" \
    "live_build_id=$(live_build_id)" "bundle_sha256=$EXPECT_SHA256" "last_attempt_sha=$SHA" "last_attempt_at=$(now)" "last_result=ok"
  rm -rf "${SNAP_PREV:?}"
  mv "$SNAP_CUR" "$SNAP_PREV"
  for rel in $OUTS; do rm -rf "${LIVE_DIR:?}/$rel.failed"; done
  step "Deploy tugadi: ${SHA:0:12} ishlayapti ($(now))"
}

rollback_cmd() {
  PHASE="boshlanish"
  PREV_SHA="$(state_get previous_sha)"
  local cur
  cur="$(state_get current_sha)"
  step "Qo'lda orqaga qaytarish (hozirgi: ${cur:0:12}, qaytariladigan: ${PREV_SHA:-$UNK})"
  cd "$LIVE_DIR"
  local rel
  for rel in $OUTS; do
    [ -e "$LIVE_DIR/$rel.prev" ] || { warn "$rel.prev yo'q — qaytariladigan oldingi build mavjud emas"; return 1; }
  done
  SWAPPED="$OUTS"
  NEW_LOCK_HASH="$(sha256_of "$LIVE_DIR/pnpm-lock.yaml")"
  if do_rollback "qo'lda so'raldi" "$SNAP_PREV"; then
    write_state "phase=idle" "current_sha=$PREV_SHA" "current_at=$(now)" "previous_sha=" \
      "live_build_id=$(live_build_id)" "bundle_sha256=" "last_attempt_sha=$PREV_SHA" "last_attempt_at=$(now)" "last_result=ok"
    step "Orqaga qaytarildi."
    return 0
  fi
  write_state "phase=idle" "current_sha=$PREV_SHA" "previous_sha=" "live_build_id=$(live_build_id)" "bundle_sha256=" \
    "last_attempt_at=$(now)" "last_result=rollback_failed"
  warn "ORQAGA QAYTARISH MUVAFFAQIYATSIZ — qo'lda aralashing."
  exit 2
}

# Xuddi shu commit VA xuddi shu bundle allaqachon ishlayotgan bo'lsa — arzon no-op (restart/backup
# sikli bo'lmasin), lekin faqat health check o'tsagina. Bundle hashi boshqa bo'lsa (qayta build qilingan:
# ochiq o'zgaruvchi yoki kalit o'zgargan) — haqiqiy deploy. Xizmatlar ishlamayotgan bo'lsa — jim muvaffaqiyat
# emas: qayta ishga tushirish va health check, natija aniq aytiladi.
noop_if_current() {
  [ "$FORCE" -eq 0 ] || return 0
  local actual
  actual="$(live_build_id)"
  if [ "$(state_get current_sha)" = "$SHA" ] && [ "$(state_get last_result)" = ok ] &&
    [ "$(state_get bundle_sha256)" = "$EXPECT_SHA256" ] &&
    [ -n "$actual" ] && [ "$(state_get live_build_id)" = "$actual" ]; then
    step "Commit ${SHA:0:12} va shu bundle allaqachon deploy qilingan — health tekshirilmoqda"
    if (HEALTH_TRIES=2; health_check); then
      step "Hech narsa qilinmadi: xuddi shu bundle ishlayapti va sog'lom."
      info "Majburan qayta deploy: serverda qo'lda 'abdusoft-blog-deploy-entry --force <sha> <sha256>'."
      exit 0
    fi
    warn "Xuddi shu bundle deploy qilingan, lekin health check o'tmadi — xizmatlar qayta ishga tushirilmoqda."
    if restart_services && sleep 1 && health_check; then
      warn "Xizmatlar qayta ishga tushirilib tiklandi (build o'zgarmagan)."
      exit 0
    fi
    warn "Xizmatlar qayta ishga tushirilgandan keyin ham sog'lom emas — qo'lda tekshiring (journalctl -u abdusoft-blog-api -u abdusoft-blog-web; zaxira: ./scripts/deploy-vds.sh)."
    exit 1
  fi
}

# ---- kirish nuqtasi --------------------------------------------------------
[ $# -ge 1 ] || usage
MODE="$1"
shift
case "$MODE" in
  deploy)
    if [ "${1:-}" = "--force" ]; then
      FORCE=1
      shift
    fi
    [ $# -eq 2 ] || usage
    SHA="$1"
    EXPECT_SHA256="$2"
    is_hex 40 "$SHA" || usage
    is_hex 64 "$EXPECT_SHA256" || usage
    ;;
  rollback)
    [ $# -eq 0 ] || usage
    ;;
  *) usage ;;
esac

setup_logging_and_lock
trap 'on_error $LINENO' ERR
if [ -d "$LIVE_DIR" ]; then cd "$LIVE_DIR"; fi
recover_interrupted
if [ "$MODE" = deploy ]; then
  noop_if_current
  deploy
else
  rollback_cmd
fi

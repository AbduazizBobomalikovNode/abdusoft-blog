#!/bin/bash
# Kirish wrapper'i — serverda live daraxtdan TASHQARIDA o'rnatiladi, masalan
# /home/abdusoft/bin/abdusoft-blog-deploy-entry. authorized_keys'da shu fayl
# deploy kalitining YAGONA ruxsat etilgan buyrug'i qilib belgilanadi:
#   restrict,command="/home/abdusoft/bin/abdusoft-blog-deploy-entry" ssh-ed25519 AAAA...
#
# Qabul qilinadigan so'rovlar (SSH_ORIGINAL_COMMAND yoki qo'lda 1-argument):
#   <40 belgili kichik hex SHA> <64 belgili kichik hex sha256>   — deploy (hash MAJBURIY)
#   status                                                        — hech narsani o'zgartirmaydi
#   rollback                                                      — FAQAT qo'lda (SSH orqali emas)
#   --force <sha> <sha256>                                        — FAQAT qo'lda: shu commit allaqachon ishlayotgan bo'lsa ham qayta deploy
# Boshqa har qanday narsa shell'ga umuman berilmaydi — rad etiladi (kod 64).
#
# Wrapper o'zi deyarli hech narsa qilmaydi: origin/main'ni fetch qiladi va
# scripts/server-deploy.sh'ning origin/main'dagi nusxasini vaqtinchalik faylga
# chiqarib, TOZA muhitda (env -i) ishga tushiradi. Shuning uchun deploy paytida
# ishlayotgan skript hech qachon qayta yozilmaydi.
set -euo pipefail
trap '' HUP PIPE
export LC_ALL=C

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Chaqiruvchi muhitidan hech qanday sozlama olinmaydi: avval hammasini tozalaymiz,
# so'ng faqat wrapper yonidagi (egasi boshqaradigan) conf faylidan o'qiymiz.
CONF_NAMES="LIVE_DIR SRC_DIR STATE_DIR NODE_BIN REPO_URL RELEASE_BASE_URL BUNDLE_KEY_FILE BACKUP_SCRIPT SERVICES API_HEALTH_URL API_DB_URL WEB_BASE_URL HEALTH_TRIES HEALTH_INTERVAL MAX_BUNDLE_BYTES MAX_UNCOMPRESSED_BYTES MAX_ENTRIES MIN_FREE_MB LOG_MAX_BYTES TIMEOUT_GIT TIMEOUT_PNPM_FETCH TIMEOUT_INSTALL TIMEOUT_BACKUP TIMEOUT_MIGRATE TIMEOUT_RESTART TIMEOUT_DOWNLOAD"
for n in $CONF_NAMES; do unset "BLOGDEPLOY_$n"; done
CONF="$HERE/abdusoft-blog-deploy.conf"
if [ -f "$CONF" ]; then
  # shellcheck disable=SC1090
  . "$CONF"
fi
SRC_DIR="${BLOGDEPLOY_SRC_DIR:-/home/abdusoft/abdusoft-blog-src}"
STATE_DIR="${BLOGDEPLOY_STATE_DIR:-/home/abdusoft/abdusoft-blog-deploy}"
NODE_BIN="${BLOGDEPLOY_NODE_BIN:-/opt/node-v24/bin}"
REPO_URL="${BLOGDEPLOY_REPO_URL:-https://github.com/AbduazizBobomalikovNode/abdusoft-blog.git}"
export PATH="$NODE_BIN:/usr/local/bin:/usr/bin:/bin"

reject() {
  echo "Rad etildi: faqat '<40-belgili-sha> <64-belgili-sha256>' yoki 'status' qabul qilinadi." >&2
  exit 64
}

is_hex() { [ "${#2}" -eq "$1" ] && [[ "$2" != *[!0-9a-f]* ]]; }

# ---- so'rovni olish va qat'iy tekshirish ----------------------------------
FORCED=0
if [ -n "${SSH_ORIGINAL_COMMAND-}" ]; then
  FORCED=1
  REQ="$SSH_ORIGINAL_COMMAND"
else
  REQ="$*"
fi

MODE=""
SHA=""
HASH=""
FORCE=0
# --force faqat qo'lda (SSH_ORIGINAL_COMMAND yo'q): forced-command yo'lida u oddiy noto'g'ri argument.
if [ "$FORCED" -eq 0 ] && [ "${REQ:0:8}" = "--force " ]; then
  FORCE=1
  REQ="${REQ:8}"
fi
if [ "$REQ" = "status" ] && [ "$FORCE" -eq 0 ]; then
  MODE=status
elif [ "$REQ" = "rollback" ] && [ "$FORCED" -eq 0 ] && [ "$FORCE" -eq 0 ]; then
  MODE=rollback
else
  SHA="${REQ%% *}"
  is_hex 40 "$SHA" || reject
  REST="${REQ#"$SHA"}"
  [ "${REST:0:1}" = " " ] || reject
  HASH="${REST:1}"
  is_hex 64 "$HASH" || reject
  MODE=deploy
fi

# ---- status: faqat o'qiydi -------------------------------------------------
if [ "$MODE" = status ]; then
  STATE_FILE="$STATE_DIR/state"
  get() { { grep -m1 "^$1=" "$STATE_FILE" 2>/dev/null || true; } | cut -d= -f2-; }
  echo "Hozir ishlayotgan commit : $( [ -f "$STATE_FILE" ] && get current_sha || true )"
  echo "Deploy qilingan vaqt     : $( [ -f "$STATE_FILE" ] && get current_at || true )"
  echo "Oldingi commit (*.prev)  : $( [ -f "$STATE_FILE" ] && get previous_sha || true )"
  echo "Oxirgi urinish           : $( [ -f "$STATE_FILE" ] && get last_attempt_sha || true ) @ $( [ -f "$STATE_FILE" ] && get last_attempt_at || true )"
  echo "Oxirgi natija            : $( [ -f "$STATE_FILE" ] && get last_result || true )"
  [ -f "$STATE_FILE" ] || echo "(holat fayli hali yo'q — pipeline hali deploy qilmagan)"
  for svc in abdusoft-blog-api abdusoft-blog-web; do
    echo "Xizmat $svc: $(systemctl is-active "$svc" 2>/dev/null || true)"
  done
  exit 0
fi

# ---- skriptni origin/main'dan olish ---------------------------------------
export GIT_TERMINAL_PROMPT=0
T_GIT="${BLOGDEPLOY_TIMEOUT_GIT:-120}"
if [ ! -d "$SRC_DIR/.git" ]; then
  timeout -k 10 "$T_GIT" git clone --quiet "$REPO_URL" "$SRC_DIR"
fi
if ! timeout -k 10 "$T_GIT" git -C "$SRC_DIR" fetch --quiet --prune origin '+refs/heads/main:refs/remotes/origin/main'; then
  if [ "$MODE" = rollback ]; then
    echo "Ogohlantirish: fetch muvaffaqiyatsiz — oxirgi olingan origin/main skriptidan foydalaniladi." >&2
  else
    echo "XATO: GitHub'dan fetch qilib bo'lmadi." >&2
    exit 1
  fi
fi
TMP="$(mktemp "${TMPDIR:-/tmp}/abdusoft-blog-deploy.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
git -C "$SRC_DIR" show "refs/remotes/origin/main:scripts/server-deploy.sh" >"$TMP" ||
  { echo "XATO: origin/main'da scripts/server-deploy.sh topilmadi." >&2; exit 1; }

ENVARGS=("HOME=${HOME:-/home/abdusoft}" "PATH=$PATH" "LC_ALL=C" "GIT_TERMINAL_PROMPT=0")
for n in $CONF_NAMES; do
  v="BLOGDEPLOY_$n"
  if [ -n "${!v-}" ]; then ENVARGS+=("$v=${!v}"); fi
done

set +e
if [ "$MODE" = rollback ]; then
  env -i "${ENVARGS[@]}" /bin/bash "$TMP" rollback
elif [ "$FORCE" -eq 1 ]; then
  env -i "${ENVARGS[@]}" /bin/bash "$TMP" deploy --force "$SHA" "$HASH"
else
  env -i "${ENVARGS[@]}" /bin/bash "$TMP" deploy "$SHA" "$HASH"
fi
exit $?

#!/usr/bin/env bash
# Prod env fayllarini (apps/api/.env.production, apps/web/.env.production)
# interaktiv yoki --yes bilan avtomatik yaratadi. Sirlarni `openssl rand -hex`
# bilan generatsiya qiladi, Coolify/Vercel'ga kiritish uchun tayyor qiladi.
#
# Foydalanish:
#   bash scripts/init-prod-env.sh                      # interaktiv, so'raydi
#   bash scripts/init-prod-env.sh --yes                 # barcha default'lar
#   bash scripts/init-prod-env.sh --yes --domain abdusoft.uz
#   bash scripts/init-prod-env.sh --force                # mavjud fayllarni qayta yozadi
#   bash scripts/init-prod-env.sh --print-coolify        # Coolify uchun KEY=VALUE bloki
#   bash scripts/init-prod-env.sh --vercel               # apps/web env'larini Vercel'ga yuboradi
#   bash scripts/init-prod-env.sh --out-dir /tmp/x        # repo'ga yozmasdan sinash (api.env/web.env)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
  cat <<'USAGE'
init-prod-env.sh — prod .env fayllarini yaratadi (apps/api, apps/web)

Flaglar:
  --yes                    Barcha savollarga default javob (interaktiv so'ramaydi)
  --domain DOMAIN           Asosiy domen (default: abdusoft.uz)
  --admin-email EMAIL       Admin email (default: admin@<domain>)
  --admin-password PASS     Admin parol (default: openssl rand -hex 8, 16 belgi)
  --db-name NAME             Postgres baza nomi (default: blog)
  --db-user USER              Postgres user (default: blog)
  --db-password PASS         Postgres parol (default: generatsiya qilinadi)
  --site-name NAME            Sayt nomi (default: abdusoft)
  --out-dir DIR                apps/* ga yozmasdan shu papkaga api.env/web.env yozadi
  --force                       Mavjud fayllarni qayta yozadi
  --vercel                      apps/web env'larini Vercel production'ga yuboradi
  --print-coolify                API env blokini Coolify uchun KEY=VALUE holda chiqaradi
  -h, --help                     Shu yordam matni

Eslatma: apps/api/docker-compose.yml POSTGRES_USER/POSTGRES_DB ni "blog" deb
hardcode qilgan — --db-name/--db-user'ni o'zgartirsangiz, docker-compose.yml'ni
ham mos ravishda tahrirlashingiz kerak bo'ladi (aks holda konteyner "blog"
bazasi/foydalanuvchisi bilan ishga tushadi va DATABASE_URL mos kelmay qoladi).
USAGE
}

DOMAIN=""
ADMIN_EMAIL=""
ADMIN_PASSWORD=""
DB_NAME=""
DB_USER=""
DB_PASSWORD=""
SITE_NAME=""
OUT_DIR=""
FORCE=false
ASSUME_YES=false
DO_VERCEL=false
DO_PRINT_COOLIFY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) ASSUME_YES=true; shift ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="${2:-}"; shift 2 ;;
    --admin-password) ADMIN_PASSWORD="${2:-}"; shift 2 ;;
    --db-name) DB_NAME="${2:-}"; shift 2 ;;
    --db-user) DB_USER="${2:-}"; shift 2 ;;
    --db-password) DB_PASSWORD="${2:-}"; shift 2 ;;
    --site-name) SITE_NAME="${2:-}"; shift 2 ;;
    --out-dir) OUT_DIR="${2:-}"; shift 2 ;;
    --force) FORCE=true; shift ;;
    --vercel) DO_VERCEL=true; shift ;;
    --print-coolify) DO_PRINT_COOLIFY=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Noma'lum flag: $1" >&2; usage; exit 1 ;;
  esac
done

command -v openssl >/dev/null 2>&1 || { echo "Xato: 'openssl' topilmadi." >&2; exit 1; }

# --- yordamchi funksiyalar ---------------------------------------------------

rand_hex() { openssl rand -hex "$1"; }

# $1=varnom $2=savol $3=default — flag orqali allaqachon berilgan bo'lsa yoki
# --yes bo'lsa so'ramaydi, aks holda interaktiv so'raydi (bo'sh javob = default).
prompt() {
  local __var="$1" __question="$2" __default="$3"
  local __current="${!__var}"
  if [[ -n "$__current" ]]; then
    return 0
  fi
  if [[ "$ASSUME_YES" == "true" ]]; then
    printf -v "$__var" '%s' "$__default"
    return 0
  fi
  local __input=""
  read -r -p "$__question [$__default]: " __input || true
  if [[ -z "$__input" ]]; then
    printf -v "$__var" '%s' "$__default"
  else
    printf -v "$__var" '%s' "$__input"
  fi
}

# .env faylini buzadigan belgilarni (yangi qator, boshidagi '#') rad etadi.
assert_env_safe() {
  local name="$1" value="$2"
  if [[ "$value" == *$'\n'* ]]; then
    echo "Xato: $name qiymatida yangi qator belgisi bo'lishi mumkin emas." >&2
    exit 1
  fi
  if [[ "$value" == \#* ]]; then
    echo "Xato: $name qiymati '#' bilan boshlana olmaydi (.env faylda izohga aylanadi)." >&2
    exit 1
  fi
}

mask() {
  local v="$1"
  if [[ -z "$v" ]]; then
    echo "(bo'sh)"
  elif [[ ${#v} -le 8 ]]; then
    echo "****"
  else
    echo "${v:0:4}…${v: -4} (${#v} belgi)"
  fi
}

# --- so'rovlar / default'lar --------------------------------------------------

prompt DOMAIN "Asosiy domen" "abdusoft.uz"
API_ORIGIN="https://api.${DOMAIN}"
WEB_ORIGIN="https://blog.${DOMAIN}"
COOKIE_DOMAIN=".${DOMAIN}"

prompt ADMIN_EMAIL "Admin email" "admin@${DOMAIN}"

DEFAULT_ADMIN_PASSWORD="$(rand_hex 8)"
prompt ADMIN_PASSWORD "Admin parol (bo'sh — avtomatik generatsiya)" "$DEFAULT_ADMIN_PASSWORD"

prompt DB_NAME "Postgres baza nomi" "blog"
prompt DB_USER "Postgres user" "blog"

if [[ -z "$DB_PASSWORD" ]]; then
  DB_PASSWORD="$(rand_hex 20)"
fi

prompt SITE_NAME "Sayt nomi" "abdusoft"

for pair in "DOMAIN:$DOMAIN" "ADMIN_EMAIL:$ADMIN_EMAIL" "ADMIN_PASSWORD:$ADMIN_PASSWORD" \
            "DB_NAME:$DB_NAME" "DB_USER:$DB_USER" "DB_PASSWORD:$DB_PASSWORD" "SITE_NAME:$SITE_NAME"; do
  assert_env_safe "${pair%%:*}" "${pair#*:}"
done

if [[ "$DB_NAME" != "blog" || "$DB_USER" != "blog" ]]; then
  echo "OGOHLANTIRISH: apps/api/docker-compose.yml POSTGRES_USER/POSTGRES_DB'ni" >&2
  echo "\"blog\" deb hardcode qiladi — DATABASE_URL ${DB_USER}/${DB_NAME} bilan" >&2
  echo "mos ishlashi uchun docker-compose.yml'ni ham tahrirlashingiz kerak." >&2
fi

# --- sirlarni generatsiya qilish ---------------------------------------------

BETTER_AUTH_SECRET="$(rand_hex 32)"
DEVICE_SECRET="$(rand_hex 32)"
REVALIDATE_SECRET="$(rand_hex 32)"
TELEGRAM_WEBHOOK_SECRET="$(rand_hex 32)"
UMAMI_APP_SECRET="$(rand_hex 32)"

# --- chiqish fayllari ---------------------------------------------------------

if [[ -n "$OUT_DIR" ]]; then
  mkdir -p "$OUT_DIR"
  API_ENV_FILE="$OUT_DIR/api.env"
  WEB_ENV_FILE="$OUT_DIR/web.env"
else
  API_ENV_FILE="$REPO_ROOT/apps/api/.env.production"
  WEB_ENV_FILE="$REPO_ROOT/apps/web/.env.production"
fi

for f in "$API_ENV_FILE" "$WEB_ENV_FILE"; do
  if [[ -e "$f" && "$FORCE" != "true" ]]; then
    echo "Xato: $f allaqachon mavjud. Qayta yozish uchun --force qo'shing." >&2
    exit 1
  fi
done

GENERATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat > "$API_ENV_FILE" <<ENVEOF
# Avtomatik yaratildi: scripts/init-prod-env.sh (${GENERATED_AT})
# Minimal prod to'plam — qolgan integratsiyalar (Telegram bot, GitHub OAuth,
# Cloudflare R2, Turnstile, Umami stats proxy) admin panelda
# /admin/sozlamalar orqali sozlanadi.

NODE_ENV=production
PORT=4000

# Ushbu API qaysi domenda turadi (webhook/callback URL'lar shundan tuziladi).
API_ORIGIN=${API_ORIGIN}
# Frontend (Vercel) domeni — CORS shu qiymatga ruxsat beradi.
WEB_ORIGIN=${WEB_ORIGIN}
# Ikkala subdomen ustidan umumiy cookie — boshida nuqta shart.
COOKIE_DOMAIN=${COOKIE_DOMAIN}

# docker-compose.yml'dagi postgres xizmatiga ulanish (compose network ichida
# host nomi "postgres").
DATABASE_URL=postgres://${DB_USER}:${DB_PASSWORD}@postgres:5432/${DB_NAME}
# docker-compose.yml postgres konteynerini shu qiymatlar bilan ishga tushiradi.
POSTGRES_DB=${DB_NAME}
POSTGRES_USER=${DB_USER}
POSTGRES_PASSWORD=${DB_PASSWORD}

# Better Auth session/cookie imzolash kaliti.
BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}
# Qurilma cookie'sini imzolash uchun alohida kalit.
DEVICE_SECRET=${DEVICE_SECRET}
# apps/web dagi REVALIDATE_SECRET bilan AYNI BIR XIL bo'lishi shart.
REVALIDATE_SECRET=${REVALIDATE_SECRET}

# Coolify/Traefik orqasida VDS'da SHART true — aks holda mijoz IP'i noto'g'ri aniqlanadi.
TRUST_PROXY=true
# Telegraph ko'zgulash prod'da yoqiladi.
TELEGRAPH_ENABLED=true
# Turnstile hali sozlanmagan (admin panelda kiritiladi) — hozircha fail-open.
REQUIRE_TURNSTILE=false

# Birinchi admin (seed skripti orqali yaratiladi) — deploy'dan keyin parolni almashtiring.
ADMIN_EMAIL=${ADMIN_EMAIL}
ADMIN_PASSWORD=${ADMIN_PASSWORD}

SITE_NAME=${SITE_NAME}

# Oldindan generatsiya qilingan — TELEGRAM_BOT_TOKEN admin panelda
# (/admin/sozlamalar) sozlansa, webhook so'rovlari shu secret bilan tasdiqlanadi.
TELEGRAM_WEBHOOK_SECRET=${TELEGRAM_WEBHOOK_SECRET}

# docker-compose.yml'dagi umami xizmati uchun (compose shu qiymatni
# \${UMAMI_APP_SECRET} orqali o'qiydi).
UMAMI_APP_SECRET=${UMAMI_APP_SECRET}
ENVEOF
chmod 600 "$API_ENV_FILE"

cat > "$WEB_ENV_FILE" <<ENVEOF
# Avtomatik yaratildi: scripts/init-prod-env.sh (${GENERATED_AT})
NEXT_PUBLIC_API_URL=${API_ORIGIN}
NEXT_PUBLIC_SITE_URL=${WEB_ORIGIN}
NEXT_PUBLIC_SITE_NAME=${SITE_NAME}
# apps/api dagi REVALIDATE_SECRET bilan AYNI BIR XIL bo'lishi shart.
REVALIDATE_SECRET=${REVALIDATE_SECRET}
ENVEOF
chmod 600 "$WEB_ENV_FILE"

# --- xulosa --------------------------------------------------------------------

echo
echo "== Yaratildi =="
echo "  $API_ENV_FILE"
echo "  $WEB_ENV_FILE"
echo
echo "== Sozlamalar =="
echo "Domen:          $DOMAIN"
echo "API_ORIGIN:      $API_ORIGIN"
echo "WEB_ORIGIN:       $WEB_ORIGIN"
echo "COOKIE_DOMAIN:    $COOKIE_DOMAIN"
echo "Admin email:      $ADMIN_EMAIL"
echo "Admin parol:      $ADMIN_PASSWORD   (FAQAT SHU YERDA ko'rsatiladi — xavfsiz joyga saqlang!)"
echo "Postgres:         ${DB_USER}/${DB_NAME}, parol: $(mask "$DB_PASSWORD")"
echo "Sayt nomi:        $SITE_NAME"
echo "BETTER_AUTH_SECRET:      $(mask "$BETTER_AUTH_SECRET")"
echo "DEVICE_SECRET:            $(mask "$DEVICE_SECRET")"
echo "REVALIDATE_SECRET:        $(mask "$REVALIDATE_SECRET")"
echo "TELEGRAM_WEBHOOK_SECRET:  $(mask "$TELEGRAM_WEBHOOK_SECRET")"
echo "UMAMI_APP_SECRET:         $(mask "$UMAMI_APP_SECRET")"
echo
echo "== Keyingi qadamlar =="
echo "  1) apps/api/.env.production qiymatlarini Coolify'ning \"Environment"
echo "     Variables\" bo'limiga kiriting (yoki: bash scripts/init-prod-env.sh --print-coolify)."
echo "  2) apps/web/.env.production qiymatlarini Vercel Production muhitiga kiriting"
echo "     (yoki: bash scripts/vercel-env-push.sh)."
echo "  3) Admin parolni xavfsiz joyga yozib qo'ying — qayta ko'rsatilmaydi."

if [[ "$DO_PRINT_COOLIFY" == "true" ]]; then
  echo
  echo "== Coolify uchun (Environment Variables bo'limiga joylashtiring) =="
  cat "$API_ENV_FILE"
fi

if [[ "$DO_VERCEL" == "true" ]]; then
  echo
  echo "== Vercel =="
  if command -v vercel >/dev/null 2>&1 && [[ -f "$REPO_ROOT/apps/web/.vercel/project.json" ]]; then
    echo "vercel CLI topildi, loyiha ulangan — production env'larni yuboryapman..."
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ -z "$line" ]] && continue
      case "$line" in \#*) continue ;; esac
      key="${line%%=*}"
      value="${line#*=}"
      [[ -z "$key" ]] && continue
      echo "  -> $key"
      printf '%s' "$value" | vercel env add "$key" production --cwd "$REPO_ROOT/apps/web" --force
    done < "$WEB_ENV_FILE"
  else
    echo "vercel CLI topilmadi yoki apps/web loyihasi ulanmagan. Qo'lda bajaring:"
    echo "  vercel link --cwd apps/web"
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ -z "$line" ]] && continue
      case "$line" in \#*) continue ;; esac
      key="${line%%=*}"
      value="${line#*=}"
      [[ -z "$key" ]] && continue
      echo "  printf '%s' \"$value\" | vercel env add $key production --cwd apps/web --force"
    done < "$WEB_ENV_FILE"
  fi
fi

#!/usr/bin/env bash
# apps/web/.env.production (yoki --file bilan boshqa fayl) ichidagi barcha
# o'zgaruvchilarni Vercel loyihasining berilgan muhitiga (default: production)
# bitta-bitta yuboradi. init-prod-env.sh'dan mustaqil ishlaydi.
#
# Foydalanish:
#   bash scripts/vercel-env-push.sh
#   bash scripts/vercel-env-push.sh --env preview
#   bash scripts/vercel-env-push.sh --file apps/web/.env.production --dry-run
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
  cat <<'USAGE'
vercel-env-push.sh — .env faylidagi qiymatlarni Vercel'ga yuboradi

Flaglar:
  --file PATH        Manba env fayli (default: apps/web/.env.production)
  --env ENVIRONMENT    production | preview (default: production)
  --dry-run             Hech narsa yubormaydi, faqat qaysi kalitlar yuborilishini ko'rsatadi
  -h, --help             Shu yordam matni

Talab: vercel CLI o'rnatilgan va loyiha ulangan bo'lishi kerak
(avval: vercel link --cwd apps/web).
USAGE
}

FILE="$REPO_ROOT/apps/web/.env.production"
ENVIRONMENT="production"
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --file) FILE="${2:-}"; shift 2 ;;
    --env) ENVIRONMENT="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Noma'lum flag: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ "$ENVIRONMENT" != "production" && "$ENVIRONMENT" != "preview" ]]; then
  echo "Xato: --env faqat 'production' yoki 'preview' bo'lishi mumkin." >&2
  exit 1
fi

if [[ ! -f "$FILE" ]]; then
  echo "Xato: $FILE topilmadi." >&2
  exit 1
fi

if [[ "$DRY_RUN" != "true" ]]; then
  command -v vercel >/dev/null 2>&1 || {
    echo "Xato: 'vercel' CLI topilmadi. O'rnating: pnpm add -g vercel" >&2
    exit 1
  }
  if [[ ! -f "$REPO_ROOT/apps/web/.vercel/project.json" ]]; then
    echo "Xato: apps/web loyihasi Vercel'ga ulanmagan. Avval bajaring:" >&2
    echo "  vercel link --cwd apps/web" >&2
    exit 1
  fi
fi

echo "Manba fayl: $FILE"
echo "Muhit:      $ENVIRONMENT"
echo

while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" ]] && continue
  case "$line" in \#*) continue ;; esac
  key="${line%%=*}"
  value="${line#*=}"
  [[ -z "$key" ]] && continue
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry-run] $key -> $ENVIRONMENT"
    continue
  fi
  echo "Yuborilmoqda: $key"
  printf '%s' "$value" | vercel env add "$key" "$ENVIRONMENT" --cwd "$REPO_ROOT/apps/web" --force
done < "$FILE"

echo
echo "Tayyor."

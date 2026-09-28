#!/bin/bash
# Native (Docker'siz) VDS'ga qayta deploy skripti.
# apps/api (Hono, systemd: abdusoft-blog-api) va apps/web (Next.js, systemd:
# abdusoft-blog-web) uchun — Mac'dan rsync qiladi, serverda build va
# migratsiya ishga tushiradi, so'ng ikkala systemd xizmatini qayta ishga
# tushiradi.
#
# Ishlatilishi:
#   ./scripts/deploy-vds.sh [--host user@host] [--skip-build] [--api-only] [--web-only]
#
# Flags:
#   --host HOST      SSH manzili (default: abdusoft@185.196.213.8)
#   --skip-build      pnpm install/build bosqichini o'tkazib yuborish (faqat restart)
#   --api-only        faqat apps/api'ni deploy qilish (build + migratsiya + restart)
#   --web-only        faqat apps/web'ni deploy qilish (build + restart)
set -euo pipefail

HOST="abdusoft@185.196.213.8"
REMOTE_DIR="/home/abdusoft/abdusoft-blog"
SKIP_BUILD=false
API_ONLY=false
WEB_ONLY=false
NODE_BIN="/opt/node-v24/bin"

while [ $# -gt 0 ]; do
  case "$1" in
    --host)
      HOST="$2"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    --api-only)
      API_ONLY=true
      shift
      ;;
    --web-only)
      WEB_ONLY=true
      shift
      ;;
    *)
      echo "Noma'lum flag: $1" >&2
      exit 1
      ;;
  esac
done

if [ "$API_ONLY" = true ] && [ "$WEB_ONLY" = true ]; then
  echo "--api-only va --web-only birga ishlatilmaydi" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> [1/4] Kod rsync qilinmoqda ($REPO_DIR -> $HOST:$REMOTE_DIR)"
rsync -az --delete \
  --exclude 'node_modules' --exclude '.next' --exclude 'dist' --exclude '.data' \
  --exclude '.env' --exclude '.env.local' --exclude '.env.production' \
  --exclude '.git' --exclude '.turbo' --exclude 'coverage' \
  -e ssh \
  "$REPO_DIR/" "$HOST:$REMOTE_DIR/"

if [ "$SKIP_BUILD" = false ]; then
  echo "==> [2/4] Serverda install + build"
  ssh -o BatchMode=yes "$HOST" "
    set -e
    export PATH=$NODE_BIN:\$PATH
    export NODE_OPTIONS=--max-old-space-size=2048
    cd $REMOTE_DIR
    pnpm install --frozen-lockfile
    pnpm --filter @blog/shared build
    if [ '$WEB_ONLY' = false ]; then pnpm --filter @blog/api build; fi
    if [ '$API_ONLY' = false ]; then pnpm --filter @blog/web build; fi
  "
else
  echo "==> [2/4] --skip-build berilgan, build o'tkazib yuborildi"
fi

if [ "$WEB_ONLY" = false ]; then
  echo "==> [3/4] Migratsiya ishga tushirilmoqda"
  ssh -o BatchMode=yes "$HOST" "
    set -e
    export PATH=$NODE_BIN:\$PATH
    cd $REMOTE_DIR
    pnpm api:migrate
  "
else
  echo "==> [3/4] --web-only berilgan, migratsiya o'tkazib yuborildi"
fi

echo "==> [4/4] systemd xizmatlari qayta ishga tushirilmoqda"
if [ "$WEB_ONLY" = true ]; then
  ssh -o BatchMode=yes "$HOST" "sudo systemctl restart abdusoft-blog-web"
elif [ "$API_ONLY" = true ]; then
  ssh -o BatchMode=yes "$HOST" "sudo systemctl restart abdusoft-blog-api"
else
  ssh -o BatchMode=yes "$HOST" "sudo systemctl restart abdusoft-blog-api abdusoft-blog-web"
fi

echo "==> Health check"
ssh -o BatchMode=yes "$HOST" "
  sleep 2
  echo -n 'api /health: '; ok=; for i in \$(seq 1 20); do curl -sf http://127.0.0.1:4000/health && ok=1 && break; sleep 1; done; [ -n "\$ok" ] || echo FAIL
  echo
  echo -n 'web /: '; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/ || echo FAIL
  sudo systemctl is-active abdusoft-blog-api abdusoft-blog-web
"

echo "==> Deploy tugadi."

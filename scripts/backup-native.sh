#!/bin/bash
# Kunlik zaxira: Postgres (pg_dump) + mahalliy uploads papkasi (agar R2
# sozlanmagan bo'lsa, media shu yerda saqlanadi). Native (Docker'siz) VDS
# deploy uchun — apps/api/docker/backup.sh'ning mantig'i shu yerga
# `docker compose exec` siz ko'chirilgan.
#
# Ishlatilishi (repo joylashgan joyda, masalan
# /home/abdusoft/abdusoft-blog):
#   ./scripts/backup-native.sh
#
# Cron bilan rejalashtirish (har kuni soat 03:00'da):
#   0 3 * * * /home/abdusoft/abdusoft-blog/scripts/backup-native.sh >> /home/abdusoft/backups/abdusoft-blog/backup.log 2>&1
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_DIR/apps/api/.env}"
BACKUP_DIR="${BACKUP_DIR:-/home/abdusoft/backups/abdusoft-blog}"
KEEP_DAYS="${KEEP_DAYS:-14}"
UPLOADS_DIR="${UPLOADS_DIR:-$REPO_DIR/apps/api/.data/uploads}"

if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a
  source "$ENV_FILE"
  set +a
fi

DB_USER="${POSTGRES_USER:-blog}"
DB_NAME="${POSTGRES_DB:-blog}"
DB_HOST="${PGHOST:-127.0.0.1}"
DB_PORT="${PGPORT:-5432}"
DATE="$(date +%Y-%m-%d_%H%M%S)"
DB_FILE="$BACKUP_DIR/blog_db_${DATE}.sql.gz"
UPLOADS_FILE="$BACKUP_DIR/blog_uploads_${DATE}.tar.gz"

mkdir -p "$BACKUP_DIR"

echo "[backup] $DB_NAME bazasi $DB_FILE fayliga zaxiralanmoqda..."
PGPASSWORD="${POSTGRES_PASSWORD:-}" pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$DB_NAME" | gzip > "$DB_FILE"
echo "[backup] Tayyor: $DB_FILE ($(du -h "$DB_FILE" | cut -f1))"

if [ -d "$UPLOADS_DIR" ] && [ -n "$(ls -A "$UPLOADS_DIR" 2>/dev/null)" ]; then
  echo "[backup] uploads papkasi $UPLOADS_FILE fayliga arxivlanmoqda..."
  tar czf "$UPLOADS_FILE" -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")"
  echo "[backup] Tayyor: $UPLOADS_FILE ($(du -h "$UPLOADS_FILE" | cut -f1))"
else
  echo "[backup] uploads papkasi bo'sh yoki mavjud emas — o'tkazib yuborildi (R2 ishlatilayotgan bo'lishi mumkin)."
fi

echo "[backup] $KEEP_DAYS kundan eski nusxalar o'chirilmoqda..."
find "$BACKUP_DIR" -name "blog_db_*.sql.gz" -mtime "+$KEEP_DAYS" -print -delete
find "$BACKUP_DIR" -name "blog_uploads_*.tar.gz" -mtime "+$KEEP_DAYS" -print -delete

echo "[backup] Yakunlandi."

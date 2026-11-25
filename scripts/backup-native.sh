#!/bin/bash
# Kunlik zaxira: Postgres (pg_dump) + mahalliy uploads papkasi (agar R2
# sozlanmagan bo'lsa, media shu yerda saqlanadi) + Umami analytics bazasi.
# Native (Docker'siz) VDS deploy uchun — apps/api/docker/backup.sh'ning
# mantig'i shu yerga `docker compose exec` siz ko'chirilgan.
#
# Ishlatilishi (repo joylashgan joyda, masalan
# /home/abdusoft/abdusoft-blog):
#   ./scripts/backup-native.sh
#
# Cron bilan rejalashtirish (har kuni soat 03:00'da):
#   0 3 * * * /home/abdusoft/abdusoft-blog/scripts/backup-native.sh >> /home/abdusoft/backups/abdusoft-blog/backup.log 2>&1
#
# Ixtiyoriy flag (cron'dagi default xatti-harakat O'ZGARMAGAN):
#   --db-only   faqat blog bazasining dumpi (uploads arxivi va umami'siz), alohida
#               nom (blog_predeploy_*) va alohida qisqa saqlash (oxirgi PREDEPLOY_KEEP
#               ta, default 5). Deploy pipeline migratsiyadan oldin shuni ishlatadi,
#               shunda har deploy diskni to'ldirmaydi.
set -euo pipefail

DB_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --db-only) DB_ONLY=true ;;
    *)
      echo "Noma'lum argument: $arg" >&2
      exit 64
      ;;
  esac
done

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_DIR/apps/api/.env}"
BACKUP_DIR="${BACKUP_DIR:-/home/abdusoft/backups/abdusoft-blog}"
KEEP_DAYS="${KEEP_DAYS:-14}"
UPLOADS_DIR="${UPLOADS_DIR:-$REPO_DIR/apps/api/.data/uploads}"
UMAMI_ENV_FILE="${UMAMI_ENV_FILE:-/home/abdusoft/umami/.env}"

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

if [ "$DB_ONLY" = true ]; then
  PRE_FILE="$BACKUP_DIR/blog_predeploy_${DATE}.sql.gz"
  PREDEPLOY_KEEP="${PREDEPLOY_KEEP:-5}"
  echo "[backup] (--db-only) $DB_NAME bazasi $PRE_FILE fayliga zaxiralanmoqda..."
  if ! PGPASSWORD="${POSTGRES_PASSWORD:-}" pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$DB_NAME" | gzip > "$PRE_FILE.tmp"; then
    rm -f "$PRE_FILE.tmp"
    echo "[backup] XATO: pg_dump muvaffaqiyatsiz." >&2
    exit 1
  fi
  mv "$PRE_FILE.tmp" "$PRE_FILE"
  echo "[backup] Tayyor: $PRE_FILE ($(du -h "$PRE_FILE" | cut -f1))"
  # Eng yangi PREDEPLOY_KEEP tasidan boshqasini o'chirish
  # shellcheck disable=SC2012
  ls -1t "$BACKUP_DIR"/blog_predeploy_*.sql.gz 2>/dev/null | tail -n "+$((PREDEPLOY_KEEP + 1))" | while IFS= read -r old; do
    echo "[backup] eskisi o'chirilmoqda: $old"
    rm -f "$old"
  done
  exit 0
fi

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

if [ -f "$UMAMI_ENV_FILE" ]; then
  # Umami o'z DATABASE_URL'ini alohida .env faylida saqlaydi (blog bazasidan
  # mustaqil) — parolni skriptga yozmaslik uchun shu yerdan o'qib olamiz.
  UMAMI_DATABASE_URL="$(grep -m1 '^DATABASE_URL=' "$UMAMI_ENV_FILE" | cut -d= -f2-)"
  if [ -n "${UMAMI_DATABASE_URL:-}" ] && [[ "$UMAMI_DATABASE_URL" =~ ^postgresql://([^:]+):([^@]+)@([^:/]+):([0-9]+)/([A-Za-z0-9_]+) ]]; then
    UMAMI_DB_USER="${BASH_REMATCH[1]}"
    UMAMI_DB_PASSWORD="${BASH_REMATCH[2]}"
    UMAMI_DB_HOST="${BASH_REMATCH[3]}"
    UMAMI_DB_PORT="${BASH_REMATCH[4]}"
    UMAMI_DB_NAME="${BASH_REMATCH[5]}"
    UMAMI_DB_FILE="$BACKUP_DIR/umami_db_${DATE}.sql.gz"

    echo "[backup] $UMAMI_DB_NAME (umami) bazasi $UMAMI_DB_FILE fayliga zaxiralanmoqda..."
    PGPASSWORD="$UMAMI_DB_PASSWORD" pg_dump -h "$UMAMI_DB_HOST" -p "$UMAMI_DB_PORT" -U "$UMAMI_DB_USER" "$UMAMI_DB_NAME" | gzip > "$UMAMI_DB_FILE"
    echo "[backup] Tayyor: $UMAMI_DB_FILE ($(du -h "$UMAMI_DB_FILE" | cut -f1))"
  else
    echo "[backup] Ogohlantirish: $UMAMI_ENV_FILE ichida DATABASE_URL topilmadi yoki formati noto'g'ri — umami zaxirasi o'tkazib yuborildi."
  fi
else
  echo "[backup] Umami .env fayli topilmadi ($UMAMI_ENV_FILE) — umami zaxirasi o'tkazib yuborildi."
fi

echo "[backup] $KEEP_DAYS kundan eski nusxalar o'chirilmoqda..."
find "$BACKUP_DIR" -name "blog_db_*.sql.gz" -mtime "+$KEEP_DAYS" -print -delete
find "$BACKUP_DIR" -name "blog_uploads_*.tar.gz" -mtime "+$KEEP_DAYS" -print -delete
find "$BACKUP_DIR" -name "umami_db_*.sql.gz" -mtime "+$KEEP_DAYS" -print -delete

echo "[backup] Yakunlandi."

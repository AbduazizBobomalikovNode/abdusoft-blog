#!/bin/sh
# Postgres bazasining kunlik zaxira nusxasini (pg_dump) sanalangan faylga
# oladi va oxirgi 14 tasidan boshqasini o'chiradi.
#
# Ishlatilishi (VDS'da, docker-compose.yml bilan bir joyda):
#   ./docker/backup.sh
#
# Cron bilan rejalashtirish (masalan har kuni soat 03:00'da):
#   0 3 * * * cd /path/to/repo/apps/api && ./docker/backup.sh >> /var/log/blog-backup.log 2>&1
#
# Yoki Coolify'da: loyihaning "Scheduled Tasks" bo'limidan shu skriptni
# konteyner ichida ishga tushiradigan cron job sifatida qo'shish mumkin
# (`docker compose exec postgres sh -c '...'` yoki alohida backup xizmati).
set -e

BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
DB_USER="${POSTGRES_USER:-blog}"
DB_NAME="${POSTGRES_DB:-blog}"
DATE="$(date +%Y-%m-%d_%H%M%S)"
FILE="$BACKUP_DIR/blog_${DATE}.sql.gz"

mkdir -p "$BACKUP_DIR"

echo "[backup] $DB_NAME bazasi $FILE fayliga zaxiralanmoqda..."
docker compose exec -T postgres pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$FILE"
echo "[backup] Tayyor: $FILE ($(du -h "$FILE" | cut -f1))"

echo "[backup] $KEEP_DAYS kundan eski nusxalar o'chirilmoqda..."
find "$BACKUP_DIR" -name "blog_*.sql.gz" -mtime "+$KEEP_DAYS" -print -delete

echo "[backup] Yakunlandi."

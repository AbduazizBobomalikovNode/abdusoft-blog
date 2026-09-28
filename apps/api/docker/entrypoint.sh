#!/bin/sh
# Konteyner ishga tushganda avval migratsiyalarni qo'llaydi (compiled
# `dist/scripts/migrate.js` — prod image'da `tsx` yo'q), so'ng asosiy
# buyruqni (`node dist/src/index.js`) ishga tushiradi. Migratsiya muvaffaqiyatsiz
# bo'lsa, konteyner ishga tushmaydi (fail-fast — noto'g'ri sxema bilan
# ishlashdan yaxshiroq).
set -e

echo "[entrypoint] Migratsiyalar qo'llanmoqda..."
node dist/scripts/migrate.js
echo "[entrypoint] Migratsiya tayyor. Server ishga tushmoqda..."

exec "$@"

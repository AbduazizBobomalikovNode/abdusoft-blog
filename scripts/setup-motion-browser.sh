#!/bin/bash
# Video render xizmati uchun headless brauzerni (Chrome Headless Shell) serverga BIR MARTA o'rnatadi. Idempotent: qayta ishga tushirish zararsiz.
# Render ishchisi brauzerni HECH QACHON o'zi yuklamaydi — yo'q bo'lsa ish "browser_missing" bilan yiqiladi; shu skript yagona joy.
#
#   bash scripts/setup-motion-browser.sh            # tizim kutubxonalarini TEKSHIRADI va brauzerni yuklaydi
#   bash scripts/setup-motion-browser.sh --check    # faqat tekshiradi (hech narsa yuklamaydi/o'rnatmaydi)
#   sudo bash scripts/setup-motion-browser.sh --install-deps   # Ubuntu/Debian: yetishmayotgan kutubxonalarni apt bilan o'rnatadi
#
# Faqat VIDEO_RUNNER=local uchun kerak (tavsiya etilgan `github` backendda serverda brauzer ham, bu skript ham KERAK EMAS).
# Oxirida PREFLIGHT ishlaydi: glibc >= 2.35, compositor binari ishga tushishi va bitta kichik kadr render qilinishi tekshiriladi;
# muvaffaqiyatli bo'lsa belgi fayl yoziladi (API'ning mahalliy backendi shu faylsiz hech qanday ishni boshlamaydi).
# Muhit: VIDEO_DATA_DIR (belgi fayl shu yerda; bo'sh bo'lsa apps/api/.data/video), VIDEO_BROWSER_PATH (ixtiyoriy brauzer).
# Hujjat: docs/video.md. Brauzer papkasi: packages/motion/node_modules/.remotion (git'da yo'q).
set -Eeuo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOTION="$ROOT/packages/motion"
NODE_BIN="${NODE_BIN:-node}"

MODE=install
INSTALL_DEPS=0
for arg in "$@"; do
  case "$arg" in
    --check) MODE=check ;;
    --install-deps) INSTALL_DEPS=1 ;;
    -h | --help)
      sed -n '2,9p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "XATO: noma'lum argument: $arg" >&2
      exit 64
      ;;
  esac
done

# Ubuntu 20.04 (focal) uchun headless Chromium kutubxonalari (apt paket nomlari).
APT_PACKAGES=(
  ca-certificates fonts-liberation
  libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1
  libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1
  libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2
)
# Tekshirish uchun ldconfig'dagi nomlar (har bir paket uchun asosiy .so).
SO_NAMES=(libnss3.so libnspr4.so libatk-1.0.so libatk-bridge-2.0.so libcups.so libdrm.so.2 libgbm.so.1 libxkbcommon.so.0 libXcomposite.so.1 libXdamage.so.1 libXfixes.so.3 libXrandr.so.2 libasound.so.2 libpango-1.0.so.0 libcairo.so.2 libdbus-1.so.3 libexpat.so.1 libX11.so.6 libxcb.so.1 libXext.so.6)

missing_libs() {
  command -v ldconfig >/dev/null 2>&1 || return 0
  local cache
  cache="$(ldconfig -p 2>/dev/null || true)"
  local so
  for so in "${SO_NAMES[@]}"; do
    grep -q "$so" <<<"$cache" || echo "$so"
  done
}

if [ "$(uname -s)" = "Linux" ]; then
  if [ "$INSTALL_DEPS" = 1 ]; then
    if ! command -v apt-get >/dev/null 2>&1; then
      echo "XATO: apt-get topilmadi; kutubxonalarni qo'lda o'rnating (docs/video.md)." >&2
      exit 1
    fi
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${APT_PACKAGES[@]}"
  fi
  MISSING="$(missing_libs | tr '\n' ' ')"
  if [ -n "${MISSING// /}" ]; then
    echo "OGOHLANTIRISH: quyidagi tizim kutubxonalari topilmadi: $MISSING" >&2
    echo "Ubuntu/Debian: sudo apt-get install -y --no-install-recommends ${APT_PACKAGES[*]}" >&2
    echo "(yoki: sudo bash scripts/setup-motion-browser.sh --install-deps)" >&2
    [ "$MODE" = check ] && exit 1
  else
    echo "Tizim kutubxonalari: joyida."
  fi
fi

command -v "$NODE_BIN" >/dev/null 2>&1 || {
  echo "XATO: node topilmadi (Node >= 24 kerak)." >&2
  exit 1
}
[ -f "$MOTION/src/cli.ts" ] || {
  echo "XATO: $MOTION/src/cli.ts yo'q." >&2
  exit 1
}
[ -d "$MOTION/node_modules/@remotion" ] || {
  echo "XATO: bog'liqliklar o'rnatilmagan: repo ildizida 'pnpm install --frozen-lockfile' ishga tushiring." >&2
  exit 1
}

DATA_DIR="${VIDEO_DATA_DIR:-$ROOT/apps/api/.data/video}"
BROWSER_ARGS=()
[ -n "${VIDEO_BROWSER_PATH:-}" ] && BROWSER_ARGS=(--browser "$VIDEO_BROWSER_PATH")

cd "$MOTION"
if [ "$MODE" = check ]; then
  "$NODE_BIN" --disable-warning=ExperimentalWarning src/cli.ts browser status ${BROWSER_ARGS[@]+"${BROWSER_ARGS[@]}"}
  exec "$NODE_BIN" --disable-warning=ExperimentalWarning src/cli.ts preflight ${BROWSER_ARGS[@]+"${BROWSER_ARGS[@]}"}
fi
if "$NODE_BIN" --disable-warning=ExperimentalWarning src/cli.ts browser status >/dev/null 2>&1; then
  echo "Brauzer allaqachon o'rnatilgan (qayta yuklanmadi)."
else
  "$NODE_BIN" --disable-warning=ExperimentalWarning src/cli.ts browser install
fi
"$NODE_BIN" --disable-warning=ExperimentalWarning src/cli.ts browser status ${BROWSER_ARGS[@]+"${BROWSER_ARGS[@]}"}
# Haqiqiy tekshiruv: bu mashinada render ishlaydimi (glibc, compositor, bitta kichik kadr). Yiqilsa — aniq xabar va 1 bilan chiqadi.
if ! "$NODE_BIN" --disable-warning=ExperimentalWarning src/cli.ts preflight --out "$DATA_DIR/local-preflight.json" ${BROWSER_ARGS[@]+"${BROWSER_ARGS[@]}"}; then
  echo "XATO: bu mashina mahalliy renderga yaramaydi (yuqoridagi xabarga qarang). Tavsiya: VIDEO_RUNNER=github (docs/video.md)." >&2
  exit 1
fi
echo "Tayyor. API'da VIDEO_ENABLED=true va VIDEO_RUNNER=local qilib qayta ishga tushiring (docs/video.md)."

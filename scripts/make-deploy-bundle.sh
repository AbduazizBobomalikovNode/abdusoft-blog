#!/bin/bash
# GitHub runner'da (deploy workflow'ida) ishlatiladi: allaqachon build qilingan
# natijalardan (apps/web/.next, apps/api/dist, packages/shared/dist) deploy
# bundle yig'adi. Serverda hech narsa build qilinmaydi — server shu bundle'ni
# yuklab oladi (scripts/server-deploy.sh).
#
# Ishlatilishi (repo ildizidan, build'dan KEYIN):
#   ./scripts/make-deploy-bundle.sh <40-belgili-sha> <chiqish-papkasi>
#
# Natija: <chiqish>/abdusoft-blog-<sha>.tar.gz va .tar.gz.sha256
set -euo pipefail
export LC_ALL=C COPYFILE_DISABLE=1

SHA="${1:-}"
OUT_DIR="${2:-}"
if [ "${#SHA}" -ne 40 ] || [[ "$SHA" == *[!0-9a-f]* ]] || [ -z "$OUT_DIR" ]; then
  echo "Ishlatilishi: $0 <40-belgili-sha> <chiqish-papkasi>" >&2
  exit 64
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

for d in apps/web/.next apps/api/dist packages/shared/dist; do
  [ -d "$d" ] || { echo "XATO: $d topilmadi — avval build qiling." >&2; exit 1; }
done
[ -f apps/web/.next/BUILD_ID ] || { echo "XATO: apps/web/.next/BUILD_ID yo'q." >&2; exit 1; }
[ -f apps/api/dist/src/index.js ] || { echo "XATO: apps/api/dist/src/index.js yo'q." >&2; exit 1; }
[ -f packages/shared/dist/index.js ] || { echo "XATO: packages/shared/dist/index.js yo'q." >&2; exit 1; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/abdusoft-bundle.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/apps/web" "$STAGE/apps/api" "$STAGE/packages/shared" "$OUT_DIR"

# .next/cache bundle'ga kirmaydi (build keshi, serverga kerak emas).
(cd apps/web && tar -cf - --exclude='.next/cache' .next) | tar -xf - -C "$STAGE/apps/web"
cp -R apps/api/dist "$STAGE/apps/api/dist"
cp -R packages/shared/dist "$STAGE/packages/shared/dist"

# ---- sirlar bundle'ga tushmaganini tekshirish ------------------------------
if [ -n "$(find "$STAGE" -name '.env*' -print -quit)" ]; then
  echo "XATO: bundle ichida .env* fayli bor:" >&2
  find "$STAGE" -name '.env*' >&2
  exit 1
fi
# Ma'lum sir shakllari (maxfiy kalit, bazaga parol bilan ulanish satri, GitHub tokenlari).
if grep -rIlE -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' \
  -e 'postgres(ql)?://[^[:space:]"'"'"'/:@]+:[^[:space:]"'"'"'/@]+@' \
  -e 'gh[pousr]_[A-Za-z0-9]{36,}' -e 'github_pat_[A-Za-z0-9_]{40,}' "$STAGE" >"$STAGE/.hits" 2>/dev/null; then
  echo "XATO: bundle ichida sirga o'xshash qiymat topildi (fayllar):" >&2
  sed "s|^$STAGE/||" "$STAGE/.hits" >&2
  exit 1
fi
rm -f "$STAGE/.hits"

NEXT_VERSION="$(cd apps/web && node -p 'require("next/package.json").version')"
node -e '
  const [commit, nextVersion, lock, out] = process.argv.slice(1);
  require("fs").writeFileSync(out, JSON.stringify({
    format: 1,
    commit,
    node_major: process.versions.node.split(".")[0],
    node_version: process.versions.node,
    next_version: nextVersion,
    lockfile_sha256: lock,
    built_at: new Date().toISOString(),
  }, null, 2) + "\n");
' "$SHA" "$NEXT_VERSION" "$(sha256_of pnpm-lock.yaml)" "$STAGE/MANIFEST.json"

NAME="abdusoft-blog-$SHA.tar.gz"
tar -czf "$OUT_DIR/$NAME" -C "$STAGE" MANIFEST.json apps packages
echo "$(sha256_of "$OUT_DIR/$NAME")  $NAME" >"$OUT_DIR/$NAME.sha256"
echo "Bundle tayyor: $OUT_DIR/$NAME ($(du -h "$OUT_DIR/$NAME" | cut -f1)), Next $NEXT_VERSION, Node $(node -p 'process.versions.node')"

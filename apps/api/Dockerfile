# syntax=docker/dockerfile:1
#
# Ko'p bosqichli build — pnpm workspace'dan faqat @blog/api (va uning
# workspace bog'liqligi @blog/shared) uchun kerakli fayllarni ishlab chiqaradi.
# Build kontekst REPO ILDIZI bo'lishi kerak (Coolify'da: dockerfile
# `apps/api/Dockerfile`, build context `.` — repo root).

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# ---------------------------------------------------------------------------
# 1) fetch — faqat lockfile asosida barcha bog'liqliklarni pnpm mahalliy
#    do'koniga yuklab oladi (source kod o'zgarganda ham qayta ishlatiladigan
#    Docker layer keshi uchun alohida bosqich).
# ---------------------------------------------------------------------------
FROM base AS fetch
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

# ---------------------------------------------------------------------------
# 2) build — to'liq source nusxalanadi, faqat @blog/api va uning workspace
#    bog'liqliklari (@blog/shared) o'rnatiladi (--offline — 1-bosqichdagi
#    do'kondan), TypeScript build qilinadi, so'ng `pnpm deploy` orqali
#    ishlab chiqarish uchun mustaqil (self-contained) papka yig'iladi.
# ---------------------------------------------------------------------------
FROM base AS build
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --offline --filter @blog/api...
RUN pnpm --filter @blog/shared... --filter @blog/api build
RUN pnpm deploy --filter @blog/api --prod /out

# ---------------------------------------------------------------------------
# 3) runtime — faqat kerakli fayllar: kichik, non-root, HEALTHCHECK bilan.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN groupadd --system --gid 1001 blogapi \
  && useradd --system --uid 1001 --gid blogapi --home-dir /app blogapi

COPY --from=build /out/dist ./dist
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
# E'tibor bering: `dist/drizzle`, `./drizzle` emas — `dist/scripts/migrate.js`
# (compiled) papkasidan bir daraja yuqoriga (`../drizzle`) qaraydi, ya'ni
# `dist/drizzle`ni kutadi (dev'dagi `apps/api/scripts` -> `apps/api/drizzle`
# joylashuviga mos keladigan compiled ekvivalenti).
COPY --from=build /repo/apps/api/drizzle ./dist/drizzle
COPY apps/api/docker/entrypoint.sh ./entrypoint.sh

# Mahalliy fayl saqlash (R2 sozlanmagan holatda) — docker-compose'da named
# volume shu yerga mount qilinadi.
RUN mkdir -p .data/uploads \
  && chmod +x ./entrypoint.sh \
  && chown -R blogapi:blogapi /app

USER blogapi
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./entrypoint.sh"]
# `tsc` src/ va scripts/ ikkalasini ham kompilyatsiya qilgani uchun ildiz
# apps/api/'ga mos ravishda dist/src/... va dist/scripts/... saqlanadi
# (dist/index.js EMAS — dist/src/index.js).
CMD ["node", "dist/src/index.js"]

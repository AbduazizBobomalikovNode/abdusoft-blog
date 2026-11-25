/** `MIGRATE_LOCK_TIMEOUT_MS` standarti: band jadvalda `ALTER TABLE` navbat bo'lib turmasligi uchun 15 soniya. */
export const DEFAULT_MIGRATE_LOCK_TIMEOUT_MS = 15_000;

/**
 * Migratsiya sessiyasi uchun `lock_timeout` (millisekund). Bo'sh/yo'q — standart; `0` — o'chirilgan (cheksiz kutish);
 * noto'g'ri qiymat (manfiy, son emas) — standart.
 */
export function resolveMigrateLockTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_MIGRATE_LOCK_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return DEFAULT_MIGRATE_LOCK_TIMEOUT_MS;
  return value;
}

/** libpq startup parametri (`-c lock_timeout=...`); o'chirilgan bo'lsa `undefined`. */
export function lockTimeoutStartupOption(ms: number): string | undefined {
  return ms > 0 ? `-c lock_timeout=${ms}` : undefined;
}

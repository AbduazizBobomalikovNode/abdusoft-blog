/**
 * Xotiradagi (in-memory) TTL asosidagi oddiy rate-limiter. Bitta instansiya
 * uchun ishlaydi — bir nechta API instansiyasi orqasida load-balancer bilan
 * ishlatilsa, har bir instansiya o'z hisobini yuritadi (Phase 4 doirasida bu
 * yetarli, VDS'da bitta process ishlaydi).
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

const CLEANUP_INTERVAL_MS = 60_000;
/** Xotira o'sishini cheklash uchun — juda ko'p noyob kalit (masalan spoof qilingan IP/qurilma) xaritani cheksiz kattalashtirmasin. */
const MAX_BUCKETS = 50_000;

function evictOldestIfOverCapacity(): void {
  if (buckets.size <= MAX_BUCKETS) return;
  const oldestKey = buckets.keys().next().value;
  if (oldestKey !== undefined) buckets.delete(oldestKey);
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();

export interface RateLimitResult {
  allowed: boolean;
  /** `allowed === false` bo'lsa — oyna tugashigacha qolgan soniyalar (kamida 1). */
  retryAfterSeconds: number;
}

/** `checkRateLimit` bilan bir xil hisob, lekin 429 uchun `Retry-After` qiymatini ham qaytaradi. */
export function consumeRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    evictOldestIfOverCapacity();
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (bucket.count >= limit) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }

  bucket.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

/** `true` — ruxsat berilgan, `false` — limitga yetgan. */
export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  return consumeRateLimit(key, limit, windowMs).allowed;
}

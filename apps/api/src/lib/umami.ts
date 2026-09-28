import type { AdminUmamiStats, StatsRange, UmamiMetricRow } from "@blog/shared";
import { getSettings, onSettingsChange, type MergedSettings } from "./settings.js";
import { resolveRange, type RangeWindow } from "./stats.js";

const METRIC_ROW_LIMIT = 10;
const CACHE_TTL_MS = 60_000;
const TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1000;
/** Umami login token odatda 1 soatga amal qiladi — kesh shundan bir oz kamroq muddatga saqlanadi. */
const TOKEN_TTL_MS = 55 * 60 * 1000;
/** `range=all` — Umami tomon uchun cheklangan (1 yillik) oyna, cheksiz so'rovlarning oldini olish uchun. */
const ALL_RANGE_LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000;

interface TokenCache {
  token: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

interface CacheEntry {
  data: AdminUmamiStats;
  expiresAt: number;
}

const responseCache = new Map<string, CacheEntry>();

// Umami sozlamalari (admin panelda) o'zgarganda eski login token va javob keshi
// endi noto'g'ri bo'lishi mumkin — shu sabab tozalanadi.
onSettingsChange(() => {
  tokenCache = null;
  responseCache.clear();
});

export function umamiConfigured(umami: MergedSettings["umami"]): boolean {
  const hasAuth = Boolean(umami.apiKey) || Boolean(umami.username && umami.password);
  return Boolean(umami.apiUrl && umami.websiteId && hasAuth);
}

async function authHeaders(umami: MergedSettings["umami"]): Promise<Record<string, string>> {
  if (umami.apiKey) {
    return { "x-umami-api-key": umami.apiKey };
  }

  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt - TOKEN_SAFETY_MARGIN_MS > now) {
    return { Authorization: `Bearer ${tokenCache.token}` };
  }

  const res = await fetch(`${umami.apiUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: umami.username, password: umami.password }),
  });

  if (!res.ok) {
    throw new Error(`Umami login xatosi: ${res.status}`);
  }

  const data = (await res.json()) as { token: string };
  tokenCache = { token: data.token, expiresAt: now + TOKEN_TTL_MS };
  return { Authorization: `Bearer ${data.token}` };
}

async function umamiFetch<T>(umami: MergedSettings["umami"], path: string, params: Record<string, string>): Promise<T> {
  const headers = await authHeaders(umami);
  const url = new URL(`${umami.apiUrl}/api/websites/${umami.websiteId}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Umami API xatosi (${path}): ${res.status}`);
  }
  return (await res.json()) as T;
}

function epochRange(window: RangeWindow): { startAt: number; endAt: number } {
  const endAt = Date.now();
  const startAt = window.days ? endAt - window.days * 24 * 60 * 60 * 1000 : endAt - ALL_RANGE_LOOKBACK_MS;
  return { startAt, endAt };
}

interface UmamiStatMetric {
  value: number;
  prev: number;
}

type UmamiStatKey = "pageviews" | "visitors" | "visits" | "bounces" | "totaltime";

/**
 * Umami v2: `{ pageviews: { value, prev }, ... }`.
 * Umami v3: `{ pageviews: number, ..., comparison: { pageviews: number, ... } }`.
 * Ikkalasi ham qo'llab-quvvatlanadi.
 */
type UmamiStatsRaw = Partial<Record<UmamiStatKey, UmamiStatMetric | number>> & {
  comparison?: Partial<Record<UmamiStatKey, number>>;
};

function statPair(raw: UmamiStatsRaw, key: UmamiStatKey): UmamiStatMetric {
  const field = raw[key];
  if (typeof field === "number") return { value: field, prev: raw.comparison?.[key] ?? 0 };
  return { value: field?.value ?? 0, prev: field?.prev ?? 0 };
}

interface UmamiPageviewsRaw {
  pageviews: { x: string; y: number }[];
}

type UmamiMetricRaw = { x: string; y: number }[];

function toMetricRows(raw: UmamiMetricRaw, fallbackLabel: string): UmamiMetricRow[] {
  return raw.slice(0, METRIC_ROW_LIMIT).map((row) => ({
    label: row.x || fallbackLabel,
    count: row.y,
  }));
}

/** `POST /admin/settings/test/umami` uchun — login/kichik statistika so'rovi orqali ulanishni tekshiradi. */
export async function testUmamiConnection(): Promise<{ ok: boolean; message: string }> {
  const settings = await getSettings();
  if (!umamiConfigured(settings.umami)) {
    return { ok: false, message: "Umami to'liq sozlanmagan (apiUrl, websiteId va autentifikatsiya — apiKey yoki username+password — kerak)" };
  }

  try {
    const now = Date.now();
    await umamiFetch<UmamiStatsRaw>(settings.umami, "/stats", {
      startAt: String(now - 24 * 60 * 60 * 1000),
      endAt: String(now),
    });
    return { ok: true, message: "Umami ulanish muvaffaqiyatli" };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Umami ulanish xatosi" };
  }
}

/**
 * `GET /admin/stats/umami` uchun asosiy funksiya — Umami sozlanmagan bo'lsa
 * `{ configured: false }`, xatolik bo'lsa hech qachon throw qilmaydi (
 * `{ configured: true, error }` qaytaradi), 60s xotirada keshlanadi. Sozlamalar
 * (env yoki DB) har chaqiriqda `getSettings()` orqali JORIY holatda o'qiladi.
 */
export async function fetchUmamiStats(range: StatsRange): Promise<AdminUmamiStats> {
  const settings = await getSettings();
  if (!umamiConfigured(settings.umami)) return { configured: false };

  const cached = responseCache.get(range);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  try {
    const window = resolveRange(range);
    const { startAt, endAt } = epochRange(window);
    const umami = settings.umami;

    const [statsRaw, pageviewsRaw, referrersRaw, countriesRaw, browsersRaw, devicesRaw, pagesRaw] = await Promise.all(
      [
        umamiFetch<UmamiStatsRaw>(umami, "/stats", { startAt: String(startAt), endAt: String(endAt) }),
        umamiFetch<UmamiPageviewsRaw>(umami, "/pageviews", {
          startAt: String(startAt),
          endAt: String(endAt),
          unit: "day",
          timezone: "UTC",
        }),
        umamiFetch<UmamiMetricRaw>(umami, "/metrics", { startAt: String(startAt), endAt: String(endAt), type: "referrer" }),
        umamiFetch<UmamiMetricRaw>(umami, "/metrics", { startAt: String(startAt), endAt: String(endAt), type: "country" }),
        umamiFetch<UmamiMetricRaw>(umami, "/metrics", { startAt: String(startAt), endAt: String(endAt), type: "browser" }),
        umamiFetch<UmamiMetricRaw>(umami, "/metrics", { startAt: String(startAt), endAt: String(endAt), type: "device" }),
        // Umami v3 — `path`; v2 — `url`. Avval `path`, 400 bo'lsa `url`.
        umamiFetch<UmamiMetricRaw>(umami, "/metrics", { startAt: String(startAt), endAt: String(endAt), type: "path" }).catch(
          () => umamiFetch<UmamiMetricRaw>(umami, "/metrics", { startAt: String(startAt), endAt: String(endAt), type: "url" }),
        ),
      ],
    );

    const data: AdminUmamiStats = {
      configured: true,
      stats: {
        pageviews: statPair(statsRaw, "pageviews").value,
        visitors: statPair(statsRaw, "visitors").value,
        visits: statPair(statsRaw, "visits").value,
        bounces: statPair(statsRaw, "bounces").value,
        totaltime: statPair(statsRaw, "totaltime").value,
      },
      previous: {
        pageviews: statPair(statsRaw, "pageviews").prev,
        visitors: statPair(statsRaw, "visitors").prev,
        visits: statPair(statsRaw, "visits").prev,
        bounces: statPair(statsRaw, "bounces").prev,
        totaltime: statPair(statsRaw, "totaltime").prev,
      },
      pageviewsSeries: pageviewsRaw.pageviews.map((p) => ({ t: p.x, y: p.y })),
      referrers: toMetricRows(referrersRaw, "To'g'ridan-to'g'ri"),
      countries: toMetricRows(countriesRaw, "Noma'lum"),
      browsers: toMetricRows(browsersRaw, "Noma'lum"),
      devices: toMetricRows(devicesRaw, "Noma'lum"),
      pages: toMetricRows(pagesRaw, "/"),
    };

    responseCache.set(range, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    return data;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Noma'lum xatolik";
    return { configured: true, error: message };
  }
}

import { DistributionError, sanitizeMessage } from "./errors.js";

/**
 * Yagona tashqi so'rov qatlami. Qoidalar:
 *  - faqat HTTPS va provider uchun qattiq yozilgan host ro'yxati (allow-list) — boshqa host'ga
 *    so'rov FETCH'GA HAM YETIB BORMAYDI (platforma bergan upload URL ham tekshiriladi);
 *  - `fetch` inyeksiya qilinadi (testlar tarmoqqa chiqmaydi);
 *  - redirect KUZATILMAYDI (`redirect: "manual"`): 3xx — xato;
 *  - hech narsa log qilinmaydi; xato xabarlaridan token/maxfiy qiymatlar olib tashlanadi.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProviderDeps {
  fetch: FetchLike;
  /** Test uchun soxta soat. */
  now?: () => Date;
  /** Test uchun soxta kutish (polling). */
  sleep?: (ms: number) => Promise<void>;
  /** Bitta so'rov uchun timeout (ms). Standart 30 soniya. */
  timeoutMs?: number;
}

/**
 * - `read`: GET — qayta urinish xavfsiz.
 * - `safe_write`: yozadi, lekin qayta urinish zararsiz (token almashtirish, konteyner/yuklash boshlash, o'chirish...).
 * - `create`: ko'rinadigan post yaratadi — timeout/5xx = `outcome_unknown`, ko'r-ko'rona qayta urinmang.
 */
export type RequestMode = "read" | "safe_write" | "create";

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  mode: RequestMode;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

export class HostClient {
  private readonly hosts: ReadonlySet<string>;

  constructor(
    private readonly deps: ProviderDeps,
    allowedHosts: readonly string[],
    /** Xato xabarlaridan olib tashlanadigan maxfiy qiymatlar (token, client secret). */
    private readonly secrets: readonly string[] = [],
  ) {
    this.hosts = new Set(allowedHosts);
  }

  /** URL ruxsat etilgan hostda va HTTPS ekanini tekshiradi (so'rov yuborishdan OLDIN). */
  assertAllowed(rawUrl: string): URL {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new DistributionError({ kind: "validation_rejected", message: "Noto'g'ri URL" });
    }
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !this.hosts.has(url.hostname)) {
      throw new DistributionError({
        kind: "validation_rejected",
        message: `So'rov ruxsat etilmagan manzilga yo'naltirildi (${url.hostname || "?"})`,
      });
    }
    return url;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const url = this.assertAllowed(req.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.deps.fetch(url.toString(), {
        method: req.method,
        headers: req.headers,
        body: req.body as RequestInit["body"],
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (e) {
      const aborted = controller.signal.aborted || (e instanceof Error && e.name === "AbortError");
      const reason = aborted ? "timeout" : "ulanish uzildi";
      if (req.mode === "create") {
        throw new DistributionError({
          kind: "outcome_unknown",
          message: `Yaratish so'rovi natijasi noma'lum (${reason}). Post yaratilgan bo'lishi mumkin — qayta urinmang, platformani tekshiring.`,
        });
      }
      throw new DistributionError({ kind: "transient", message: `Tarmoq xatosi (${reason})` });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 0 || (res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
      // Redirect KUZATILMAYDI — boshqa host'ga yo'naltirish imkoni yo'q.
      throw new DistributionError({
        kind: req.mode === "create" ? "outcome_unknown" : "transient",
        status: res.status || undefined,
        message: "Kutilmagan redirect — kuzatilmadi",
      });
    }

    let text = "";
    try {
      text = await res.text();
    } catch {
      if (req.mode === "create" && res.status >= 200 && res.status < 300) {
        // Javob keldi, lekin tanasi uzildi — yaratilgan bo'lishi mumkin; id sarlavhadan o'qiladi.
        text = "";
      } else if (req.mode === "create") {
        throw new DistributionError({ kind: "outcome_unknown", message: "Javob tanasi uzildi — natija noma'lum" });
      }
    }
    let json: unknown;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return { status: res.status, headers: res.headers, text, json };
  }

  /** Muvaffaqiyatsiz javobni (2xx emas) `DistributionError`ga aylantiradi. `refine` — platformaga xos qoidalar. */
  fail(res: HttpResponse, mode: RequestMode, refine?: (r: HttpResponse, msg: string) => DistributionError | undefined): DistributionError {
    const platformMessage = sanitizeMessage(extractMessage(res), this.secrets);
    const refined = refine?.(res, platformMessage);
    if (refined) return refined;
    const retryAt = parseRetryAfter(res.headers.get("retry-after"), this.deps.now?.() ?? new Date());
    const base = { status: res.status, platformMessage: platformMessage || undefined };
    switch (true) {
      case res.status === 401:
        return new DistributionError({ ...base, kind: "auth_expired", message: "Token muddati tugagan yoki bekor qilingan" });
      case res.status === 402:
        return new DistributionError({ ...base, kind: "payment_required", message: "To'lov yoki kredit kerak" });
      case res.status === 403:
        return new DistributionError({ ...base, kind: "permission_missing", message: "Ruxsat yetarli emas" });
      case res.status === 429:
        return new DistributionError({ ...base, kind: "rate_limited", retryAt, message: "So'rovlar limiti oshib ketdi" });
      case res.status === 408 || res.status >= 500:
        return mode === "create"
          ? new DistributionError({ ...base, kind: "outcome_unknown", message: `Server xatosi (${res.status}) yaratish paytida — natija noma'lum, qayta urinmang` })
          : new DistributionError({ ...base, kind: "transient", retryAt, message: `Vaqtinchalik xato (${res.status})` });
      default:
        return new DistributionError({ ...base, kind: "validation_rejected", message: `Platforma so'rovni rad etdi (${res.status})` });
    }
  }
}

/** Javob tanasidan inson o'qiy oladigan xabarni topadi (turli platforma shakllari). */
export function extractMessage(res: HttpResponse): string {
  const j = res.json as Record<string, unknown> | undefined;
  if (j && typeof j === "object") {
    const err = j.error;
    const candidates: unknown[] = [
      j.message,
      j.detail,
      j.error_description,
      typeof err === "string" ? err : undefined,
      err && typeof err === "object" ? (err as Record<string, unknown>).message : undefined,
      j.title,
    ];
    for (const c of candidates) if (typeof c === "string" && c) return c;
    const errors = j.errors;
    if (Array.isArray(errors) && errors[0] && typeof errors[0] === "object") {
      const m = (errors[0] as Record<string, unknown>).message ?? (errors[0] as Record<string, unknown>).detail;
      if (typeof m === "string") return m;
    }
  }
  return res.text.slice(0, 300);
}

export function parseRetryAfter(value: string | null, now: Date): Date | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return new Date(now.getTime() + secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : new Date(at);
}

export function formBody(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, v);
  return sp.toString();
}

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

export const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  /** Bitta so'rov uchun timeout (ms) — sarlavhalar VA javob tanasini o'qishni qamrab oladi. Standart 30 soniya. */
  timeoutMs?: number;
  /** O'qishga tayyor javob tanasi chegarasi (bayt). Standart 4 MiB. */
  maxResponseBytes?: number;
}

/**
 * - `read`: GET — qayta urinish xavfsiz.
 * - `safe_write`: yozadi, lekin qayta urinish zararsiz (token almashtirish, konteyner/yuklash boshlash, o'chirish...).
 * - `create`: ko'rinadigan post yaratadi — timeout/uzilish/408/5xx = `outcome_unknown`, ko'r-ko'rona qayta urinmang.
 *   Bu qoida HAR QANDAY provider `refine` qoidasidan USTUN (`fail` ichida birinchi tekshiriladi).
 * - `refresh`: rotatsiyali refresh token almashtirish — timeout/uzilish/408/5xx = `refresh_ambiguous` (token almashgan bo'lishi mumkin).
 */
export type RequestMode = "read" | "safe_write" | "create" | "refresh";

export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function ambiguousError(mode: RequestMode, detail: string, status?: number): DistributionError | undefined {
  if (mode === "create") {
    return new DistributionError({ kind: "outcome_unknown", status, message: `Yaratish so'rovi natijasi noma'lum (${detail}). Post yaratilgan bo'lishi mumkin — qayta urinmang, platformani tekshiring.` });
  }
  if (mode === "refresh") {
    return new DistributionError({
      kind: "refresh_ambiguous",
      status,
      message: `Token yangilash natijasi noma'lum (${detail}): token almashtirilgan bo'lishi mumkin. Keyingi yangilash ham xato bersa, akkauntni qayta ulang.`,
    });
  }
  return undefined;
}

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
    try {
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
        const detail = aborted ? "timeout" : "ulanish uzildi";
        throw ambiguousError(req.mode, detail) ?? new DistributionError({ kind: "transient", message: `Tarmoq xatosi (${detail})` });
      }

      if (res.status === 0 || (res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
        // Redirect KUZATILMAYDI — boshqa host'ga yo'naltirish imkoni yo'q.
        throw ambiguousError(req.mode, "kutilmagan redirect", res.status || undefined) ??
          new DistributionError({ kind: "transient", status: res.status || undefined, message: "Kutilmagan redirect — kuzatilmadi" });
      }

      // Timeout javob TANASINI o'qishni ham qamraydi (tugamaydigan tana osilib qolmaydi) va hajm cheklangan.
      let text: string;
      try {
        text = await readBody(res, controller.signal, this.deps.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
      } catch (e) {
        const reason = e instanceof BodyLimitError ? "javob juda katta" : controller.signal.aborted ? "tana o'qishda timeout" : "javob tanasi uzildi";
        throw ambiguousError(req.mode, reason, res.status) ?? new DistributionError({ kind: "transient", status: res.status, message: `Javob o'qilmadi (${reason})` });
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
    } finally {
      clearTimeout(timer);
    }
  }

  /** Muvaffaqiyatsiz javobni (2xx emas) `DistributionError`ga aylantiradi. `refine` — platformaga xos qoidalar. */
  fail(res: HttpResponse, mode: RequestMode, refine?: (r: HttpResponse, msg: string) => DistributionError | undefined): DistributionError {
    const platformMessage = sanitizeMessage(extractMessage(res), this.secrets);
    // Create/refresh rejimida server xatosi har qanday provider qoidasidan USTUN: natija noma'lum, qayta urinish xavfli.
    if (res.status === 408 || res.status >= 500) {
      const amb = ambiguousError(mode, `server xatosi ${res.status}`, res.status);
      if (amb) return new DistributionError({ kind: amb.kind, message: amb.message, status: res.status, platformMessage: platformMessage || undefined });
    }
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
        return new DistributionError({ ...base, kind: "transient", retryAt, message: `Vaqtinchalik xato (${res.status})` });
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
  return res.text;
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

class BodyLimitError extends Error {}

/** Javob tanasini abort signal va hajm chegarasi bilan o'qiydi. */
async function readBody(res: Response, signal: AbortSignal, cap: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) throw new BodyLimitError("too large");
  if (!res.body) return "";
  const reader = res.body.getReader();
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => {
      void reader.cancel().catch(() => undefined);
      reject(new Error("aborted"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const loop = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        void reader.cancel().catch(() => undefined);
        throw new BodyLimitError("too large");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  })();
  loop.catch(() => undefined);
  return Promise.race([loop, aborted]);
}

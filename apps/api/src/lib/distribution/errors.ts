/**
 * Distribution xatolari — chaqiruvchi (keyingi PR) ustida ish qila oladigan kichik taksonomiya.
 *
 * MUHIM (`outcome_unknown`): yaratish (create/publish) so'rovi timeout yoki uzilgan ulanish bilan
 * tugasa, post platformada yaratilgan bo'lishi MUMKIN. Chaqiruvchi bunday holatda yaratishni
 * ko'r-ko'rona QAYTA URINMASLIGI kerak (dublikat post xavfi) — avval egasi platformani qo'lda
 * tekshiradi yoki "outcome unknown" holatida to'xtatib qo'yadi.
 */
export type DistributionErrorKind =
  /** Token muddati tugagan yoki bekor qilingan — qayta ulash (yoki refresh) kerak. */
  | "auth_expired"
  /** Token bor, lekin scope/ruxsat yetishmaydi (yoki ilova tasdiqlanmagan). */
  | "permission_missing"
  /** Limit — `retryAt` platforma bergan bo'lsa to'ldiriladi. */
  | "rate_limited"
  /** Platforma so'rovni mazmunan rad etdi (`platformMessage` bilan). */
  | "validation_rejected"
  /** Platforma shu matnni dublikat deb rad etdi. */
  | "duplicate_content"
  /** To'lov / kredit / kvota kerak. */
  | "payment_required"
  /** Vaqtinchalik xato — xavfsiz qayta urinish mumkin (create bo'lmagan so'rovlar uchun). */
  | "transient"
  /** Create paytida timeout/uzilish: post yaratilgan-yaratilmaganini bilmaymiz. QAYTA URINMANG. */
  | "outcome_unknown";

export interface DistributionErrorInit {
  kind: DistributionErrorKind;
  message: string;
  /** HTTP status (bo'lsa). */
  status?: number;
  /** Platformaning o'z xabari (qisqartirilgan, maxfiy qiymatlardan tozalangan). */
  platformMessage?: string;
  retryAt?: Date;
}

export class DistributionError extends Error {
  readonly kind: DistributionErrorKind;
  readonly status?: number;
  readonly platformMessage?: string;
  readonly retryAt?: Date;

  constructor(init: DistributionErrorInit) {
    super(init.message);
    this.name = "DistributionError";
    this.kind = init.kind;
    this.status = init.status;
    this.platformMessage = init.platformMessage;
    this.retryAt = init.retryAt;
  }

  /** Faqat `transient` va `rate_limited` (retryAt dan keyin) xavfsiz qayta uriniladi. `outcome_unknown` — HECH QACHON. */
  get retryable(): boolean {
    return this.kind === "transient" || this.kind === "rate_limited";
  }
}

export function isDistributionError(e: unknown): e is DistributionError {
  return e instanceof DistributionError;
}

const MAX_PLATFORM_MESSAGE = 300;

/** Platforma xabarini qisqartiradi va ma'lum maxfiy qiymatlarni `[redacted]` bilan almashtiradi. */
export function sanitizeMessage(raw: string, secrets: readonly string[] = []): string {
  let out = raw;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  }
  // Umumiy token ko'rinishlari (Bearer ..., access_token=..., "access_token":"...").
  out = out
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/((?:access|refresh|client_secret|id)_?(?:token|secret)?["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[redacted]");
  out = out.replace(/\s+/g, " ").trim();
  return out.length > MAX_PLATFORM_MESSAGE ? `${out.slice(0, MAX_PLATFORM_MESSAGE)}…` : out;
}

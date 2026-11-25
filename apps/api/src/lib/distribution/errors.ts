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
  /** Create paytida timeout/uzilish/5xx: post yaratilgan-yaratilmaganini bilmaymiz. QAYTA URINMANG. */
  | "outcome_unknown"
  /**
   * Token yangilash (rotatsiyali refresh token, X) paytida timeout/uzilish/5xx: platforma tokenni ALLAQACHON almashtirgan bo'lishi mumkin.
   * Chaqiruvchi: eski refresh token bilan keyingi yangilash ham xato bersa — akkauntni QAYTA ULASH kerak.
   */
  | "refresh_ambiguous"
  /** Platforma bu amalni API orqali qo'llamaydi (masalan Instagram'da postni o'chirish). */
  | "not_supported";

/** Ko'p bosqichli publish'ning qaysi bosqichi xato bergan. */
export type PublishStep = "init" | "upload" | "media" | "container" | "poll" | "publish" | "read" | "write";

/**
 * Xatodan oldin allaqachon yaratilgan va qayta ishlatish mumkin bo'lgan narsalar (`PublishInput.resume` ga qaytarib berish mumkin).
 * Faqat TAYYOR (ishlatishga yaroqli) narsalar yoziladi: masalan LinkedIn rasm yuklanishi muvaffaqiyatli tugagandan keyingina `imageUrn`.
 */
export interface PartialRefs {
  /** Threads/Instagram: yaratilgan konteyner id (`poll`/`publish` bosqichida xato bo'lsa). */
  containerId?: string;
  /** X: yuklangan media id (tweet yaratilmay qolsa). */
  mediaId?: string;
  /** LinkedIn: yuklangan rasm URN (post yaratilmay qolsa). */
  imageUrn?: string;
}

export interface DistributionErrorInit {
  kind: DistributionErrorKind;
  message: string;
  /** HTTP status (bo'lsa). */
  status?: number;
  /** Platformaning o'z xabari (qisqartirilgan, maxfiy qiymatlardan tozalangan). */
  platformMessage?: string;
  retryAt?: Date;
  step?: PublishStep;
  partial?: PartialRefs;
}

export class DistributionError extends Error {
  readonly kind: DistributionErrorKind;
  readonly status?: number;
  readonly platformMessage?: string;
  readonly retryAt?: Date;
  /** Qaysi bosqichda xato bo'ldi (ko'p bosqichli publish uchun). */
  readonly step?: PublishStep;
  /** Xatogacha yaratilgan, qayta ishlatish mumkin bo'lgan narsalar. */
  readonly partial?: PartialRefs;

  constructor(init: DistributionErrorInit) {
    super(init.message);
    this.name = "DistributionError";
    this.kind = init.kind;
    this.status = init.status;
    this.platformMessage = init.platformMessage;
    this.retryAt = init.retryAt;
    this.step = init.step;
    this.partial = init.partial;
  }

  /** Xatoning nusxasi `step`/`partial` bilan (asl xato o'zgarmaydi). */
  with(extra: { step?: PublishStep; partial?: PartialRefs }): DistributionError {
    return new DistributionError({
      kind: this.kind,
      message: this.message,
      status: this.status,
      platformMessage: this.platformMessage,
      retryAt: this.retryAt,
      step: extra.step ?? this.step,
      partial: extra.partial ?? this.partial,
    });
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

const URL_IN_TEXT = /https?:\/\/[^\s<>"]+/giu;

/** `limit` belgidan oshsa qisqartiradi; kesish URL ichiga tushsa — URL boshlanishidan oldin kesadi (URL hech qachon bo'laklanmaydi). */
export function truncateUrlAware(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let cut = limit;
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const start = m.index;
    const end = start + m[0].length;
    if (start < cut && cut < end) {
      cut = start;
      break;
    }
  }
  return `${text.slice(0, cut).trimEnd()}…`;
}

/** Qiymat ko'rinishidagi uzun satrlar (tokenlar) — "token"/"secret"/"bearer" kabi iboralardan keyin. */
const AFTER_PHRASE_RE = /\b((?:access|refresh|bearer|auth(?:orization)?|api|client|session|id)?[ _-]?(?:(?:token|secret|key|password|credential)s?|authorization|bearer)\b(?:\s+(?:is|was|of|for|value|provided))?[^A-Za-z0-9\n]{0,12})([A-Za-z0-9._~+/=-]{16,})/giu;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/gu;

/**
 * Platforma xabarini maxfiy qiymatlardan TOZALAYDI va KEYIN qisqartiradi (token kesilgan bo'lak holida qolib ketmasligi uchun).
 * Qisqartirish URL-aware.
 */
export function sanitizeMessage(raw: string, secrets: readonly string[] = []): string {
  let out = raw;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  }
  out = out
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/((?:access|refresh|client_secret|id)_?(?:token|secret)?["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[redacted]")
    .replace(AFTER_PHRASE_RE, "$1[redacted]")
    .replace(JWT_RE, "[redacted]");
  out = out.replace(/\s+/g, " ").trim();
  return truncateUrlAware(out, MAX_PLATFORM_MESSAGE);
}

/** `capabilities`da qo'llanmaydigan amal uchun yagona xato. */
export function notSupported(what: string, reason: string): DistributionError {
  return new DistributionError({ kind: "not_supported", message: `${what} bu platformada qo'llanmaydi: ${reason}` });
}

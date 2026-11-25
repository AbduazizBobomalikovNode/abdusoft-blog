import { NEW_PASSWORD_MAX, NEW_PASSWORD_MIN, formatWait, parseRetryAfter } from "./password-change";

/**
 * Parolni tiklash sahifalari uchun sof (React'siz) mantiq. Parol qoidalari akkaunt sahifasi bilan bir xil
 * (`password-change.ts`dagi konstantalar): forma kamida 12, server (Better Auth) 8..128. Hech narsa log qilinmaydi.
 */

export const FORGOT_PAGE_PATH = "/parolni-unutdim";
export const RESET_PAGE_PATH = "/parolni-tiklash";

// --- "Parolni unutdingizmi?" so'rov formasi ---

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateForgotEmail(email: string): string | null {
  const value = email.trim();
  if (value.length === 0) return "Email manzilini kiriting.";
  if (value.length > 254 || !EMAIL_RE.test(value)) return "Email manzili noto'g'ri ko'rinadi.";
  return null;
}

/**
 * So'rov natijasi HAR DOIM bir xil neytral matn — hisob bor-yo'qligi, rol yoki Telegram holati ko'rinmaydi.
 * (Xodimlar uchun yo'riqnoma shu matnning o'zida, shuning uchun u ham hammaga bir xil.)
 */
export const FORGOT_NEUTRAL_MESSAGE =
  "So'rov qabul qilindi. Agar bu manzil admin hisobiga tegishli bo'lsa va Telegram sozlangan bo'lsa, tiklash havolasi admin Telegram chatiga yuboriladi. Havola qisqa muddat amal qiladi va faqat bir marta ishlaydi.";
export const FORGOT_STAFF_HINT = "Xodim bo'lsangiz, admindan yangi parol havolasini so'rang.";

export interface RequestFailure {
  status?: number;
  retryAfter?: string | null;
}

/** So'rov yuborishdagi xato (neytral javobdan tashqari yagona holatlar: chegara va tarmoq). */
export function describeForgotFailure(failure: RequestFailure): string {
  if (failure.status === 429) {
    const seconds = parseRetryAfter(failure.retryAfter);
    return seconds
      ? `Juda ko'p urinish bo'ldi. ${formatWait(seconds)}dan keyin qayta urinib ko'ring.`
      : "Juda ko'p urinish bo'ldi. Bir necha daqiqadan keyin qayta urinib ko'ring.";
  }
  if (!failure.status) return "Tarmoq xatosi: serverga ulanib bo'lmadi. Internetni tekshirib, qayta urinib ko'ring.";
  return "So'rovni yuborib bo'lmadi. Birozdan keyin qayta urinib ko'ring.";
}

// --- Tiklash sahifasi ---

export type ResetLinkState =
  | { kind: "ready"; token: string }
  | { kind: "invalid" } // muddati tugagan yoki allaqachon ishlatilgan
  | { kind: "rate_limited"; waitSeconds: number | null }
  | { kind: "missing" }; // manzilda token ham, xato ham yo'q (masalan sahifa yangilangan)

/**
 * Manzil query'sidan holatni o'qiydi. `error=INVALID_TOKEN`/`RATE_LIMITED` — API'ning havola ochish bosqichi qo'yadi.
 * Token qiymatiga hech qanday format taxmin qilinmaydi (faqat bo'sh emasligi va oqilona uzunlik).
 */
export function parseResetLocation(search: string): ResetLinkState {
  const params = new URLSearchParams(search);
  const error = params.get("error");
  if (error === "RATE_LIMITED") {
    const wait = Number(params.get("wait"));
    return { kind: "rate_limited", waitSeconds: Number.isFinite(wait) && wait > 0 ? Math.ceil(wait) : null };
  }
  if (error) return { kind: "invalid" };
  const token = params.get("token");
  if (token && token.length <= 512) return { kind: "ready", token };
  return { kind: "missing" };
}

export interface PasswordResetInput {
  newPassword: string;
  confirmPassword: string;
}
export type PasswordResetField = keyof PasswordResetInput;
export type PasswordResetErrors = Partial<Record<PasswordResetField, string>>;

export function validatePasswordReset({ newPassword, confirmPassword }: PasswordResetInput): PasswordResetErrors {
  const errors: PasswordResetErrors = {};

  if (newPassword.length === 0) {
    errors.newPassword = "Yangi parolni kiriting.";
  } else if (newPassword.length < NEW_PASSWORD_MIN) {
    errors.newPassword = `Yangi parol kamida ${NEW_PASSWORD_MIN} ta belgidan iborat bo'lishi kerak.`;
  } else if (newPassword.length > NEW_PASSWORD_MAX) {
    errors.newPassword = `Yangi parol ${NEW_PASSWORD_MAX} belgidan oshmasligi kerak.`;
  }

  if (confirmPassword.length === 0) {
    errors.confirmPassword = "Yangi parolni qayta kiriting.";
  } else if (confirmPassword !== newPassword) {
    errors.confirmPassword = "Parollar mos kelmadi.";
  }

  return errors;
}

export interface ResetFailureView {
  message: string;
  /** Havolaning o'zi yaroqsiz — forma o'rniga "muddati tugagan" holati ko'rsatiladi. */
  linkInvalid?: boolean;
  field?: PasswordResetField;
}

/** Serverdan kelgan inglizcha matn ko'rsatilmaydi — faqat status/kod bo'yicha o'zbekcha xabar. */
export function describeResetFailure(failure: RequestFailure & { code?: string }): ResetFailureView {
  const { status, code } = failure;
  if (status === 429) {
    const seconds = parseRetryAfter(failure.retryAfter);
    return {
      message: seconds
        ? `Juda ko'p urinish bo'ldi. ${formatWait(seconds)}dan keyin qayta urinib ko'ring.`
        : "Juda ko'p urinish bo'ldi. Bir necha daqiqadan keyin qayta urinib ko'ring.",
    };
  }
  if (code === "INVALID_TOKEN") return { message: RESET_LINK_INVALID_MESSAGE, linkInvalid: true };
  if (code === "PASSWORD_TOO_SHORT") return { message: "Yangi parol juda qisqa.", field: "newPassword" };
  if (code === "PASSWORD_TOO_LONG") return { message: "Yangi parol juda uzun.", field: "newPassword" };
  if (!status) return { message: "Tarmoq xatosi: serverga ulanib bo'lmadi. Internetni tekshirib, qayta urinib ko'ring." };
  return { message: "Parolni almashtirib bo'lmadi. Birozdan keyin qayta urinib ko'ring." };
}

export const RESET_LINK_INVALID_MESSAGE =
  "Bu havolaning muddati tugagan yoki u allaqachon ishlatilgan. Yangi havola so'rang.";
export const RESET_LINK_MISSING_MESSAGE =
  "Havola topilmadi. Telegramdagi xabardan havolani qayta oching (sahifani yangilash tokenni o'chirib yuboradi).";

/** Havola holati uchun sarlavha va matn (forma ko'rsatilmaydigan holatlar). */
export function describeLinkState(state: Exclude<ResetLinkState, { kind: "ready" }>): { title: string; message: string } {
  switch (state.kind) {
    case "invalid":
      return { title: "Havola yaroqsiz", message: RESET_LINK_INVALID_MESSAGE };
    case "rate_limited":
      return {
        title: "Juda ko'p urinish",
        message: state.waitSeconds
          ? `${formatWait(state.waitSeconds)}dan keyin havolani qayta oching.`
          : "Bir necha daqiqadan keyin havolani qayta oching.",
      };
    case "missing":
      return { title: "Havola topilmadi", message: RESET_LINK_MISSING_MESSAGE };
  }
}

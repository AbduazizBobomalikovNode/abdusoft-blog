/**
 * Parolni almashtirish formasi uchun sof (React'siz) mantiq: tekshiruv, xato
 * xabarlari, Retry-After formatlash. Hech qachon parolni log qilmaydi va
 * saqlamaydi.
 */

/**
 * Better Auth (`apps/api/src/lib/auth.ts`da `minPasswordLength`/`maxPasswordLength`
 * berilmagan) standartlari: kamida 8, ko'pi bilan 128 (JS `string.length` bo'yicha).
 * API testi (`auth-change-password.test.ts`) serverning haqiqiy qiymatlarini shu
 * konstantalar bilan solishtiradi — server sozlamasi o'zgarsa test qizarib qoladi.
 */
export const SERVER_PASSWORD_MIN = 8;
export const SERVER_PASSWORD_MAX = 128;

/** Admin hisobi uchun forma qat'iyroq: serverdan kam bo'lmagan, 12 belgi. */
export const NEW_PASSWORD_MIN = 12;
export const NEW_PASSWORD_MAX = SERVER_PASSWORD_MAX;

export interface PasswordChangeInput {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export type PasswordChangeField = keyof PasswordChangeInput;
export type PasswordChangeErrors = Partial<Record<PasswordChangeField, string>>;

export function validatePasswordChange(input: PasswordChangeInput): PasswordChangeErrors {
  const errors: PasswordChangeErrors = {};
  const { currentPassword, newPassword, confirmPassword } = input;

  if (currentPassword.length === 0) {
    errors.currentPassword = "Joriy parolni kiriting.";
  } else if (currentPassword.length > SERVER_PASSWORD_MAX) {
    errors.currentPassword = `Parol ${SERVER_PASSWORD_MAX} belgidan oshmasligi kerak.`;
  }

  if (newPassword.length === 0) {
    errors.newPassword = "Yangi parolni kiriting.";
  } else if (newPassword.length < NEW_PASSWORD_MIN) {
    errors.newPassword = `Yangi parol kamida ${NEW_PASSWORD_MIN} ta belgidan iborat bo'lishi kerak.`;
  } else if (newPassword.length > NEW_PASSWORD_MAX) {
    errors.newPassword = `Yangi parol ${NEW_PASSWORD_MAX} belgidan oshmasligi kerak.`;
  } else if (newPassword === currentPassword) {
    errors.newPassword = "Yangi parol joriy paroldan farq qilishi kerak.";
  }

  if (confirmPassword.length === 0) {
    errors.confirmPassword = "Yangi parolni qayta kiriting.";
  } else if (confirmPassword !== newPassword) {
    errors.confirmPassword = "Parollar mos kelmadi.";
  }

  return errors;
}

/** `Retry-After` (soniya yoki HTTP sana) -> butun soniya; noma'lum bo'lsa `null`. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds > 0 ? seconds : null;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  const seconds = Math.ceil((at - now) / 1000);
  return seconds > 0 ? seconds : null;
}

/** 45 -> "45 soniya", 90 -> "2 daqiqa", 3700 -> "2 soat" (yuqoriga yaxlitlanadi). */
export function formatWait(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return `${s} soniya`;
  if (s < 3600) return `${Math.ceil(s / 60)} daqiqa`;
  return `${Math.ceil(s / 3600)} soat`;
}

export interface ChangePasswordFailure {
  /** HTTP status; tarmoq xatosida `0`/`undefined`. */
  status?: number;
  /** Better Auth xato kodi (masalan `INVALID_PASSWORD`). */
  code?: string;
  /** `Retry-After` header qiymati (agar o'qilgan bo'lsa). */
  retryAfter?: string | null;
}

export interface ChangePasswordFailureView {
  message: string;
  /** Xato qaysi maydonga tegishli (fokus va `aria-invalid` uchun). */
  field?: PasswordChangeField;
}

/** Serverdan kelgan inglizcha matn ko'rsatilmaydi — faqat status/kod bo'yicha o'zbekcha xabar. */
export function describeChangePasswordFailure(failure: ChangePasswordFailure): ChangePasswordFailureView {
  const { status, code } = failure;

  if (status === 429) {
    const seconds = parseRetryAfter(failure.retryAfter);
    return {
      message: seconds
        ? `Juda ko'p urinish bo'ldi. ${formatWait(seconds)}dan keyin qayta urinib ko'ring.`
        : "Juda ko'p urinish bo'ldi. Bir necha daqiqadan keyin qayta urinib ko'ring.",
    };
  }
  if (code === "INVALID_PASSWORD") {
    return { message: "Joriy parol noto'g'ri.", field: "currentPassword" };
  }
  if (code === "PASSWORD_TOO_SHORT") {
    return { message: "Yangi parol juda qisqa.", field: "newPassword" };
  }
  if (code === "PASSWORD_TOO_LONG") {
    return { message: "Parol juda uzun.", field: "newPassword" };
  }
  if (status === 401) {
    return { message: "Sessiya tugagan. Qaytadan kiring." };
  }
  if (!status) {
    return { message: "Tarmoq xatosi: serverga ulanib bo'lmadi. Internetni tekshirib, qayta urinib ko'ring." };
  }
  return { message: "Parolni almashtirib bo'lmadi. Birozdan keyin qayta urinib ko'ring." };
}

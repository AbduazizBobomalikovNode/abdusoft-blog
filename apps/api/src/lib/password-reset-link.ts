import { auth } from "./auth.js";
import { PASSWORD_RESET_TTL_SECONDS, captureResetToken, buildResetLink, resetTokenExpiry, revokeAllResetTokens, webResetPageUrl } from "./password-reset.js";

/**
 * Admin xodim uchun "yangi parol o'rnatish" havolasini yaratadi: Better Auth'ning `requestPasswordReset` endpoint'i
 * (server tomonidan chaqiriladi) tokenni yaratadi va saqlaydi; Telegram'ga YUBORILMAYDI — havola admin'ga qaytariladi.
 * Avvalgi tiklash havolalari bekor qilinadi (faqat eng yangisi yaroqli).
 */
export async function createStaffPasswordResetLink(target: {
  id: string;
  email: string;
}): Promise<{ url: string; expiresAt: Date }> {
  await revokeAllResetTokens(target.id);
  const token = await captureResetToken(() =>
    auth.api.requestPasswordReset({ body: { email: target.email, redirectTo: webResetPageUrl() } }),
  );
  if (!token) throw new Error("Tiklash tokenini yaratib bo'lmadi");
  const expiresAt = (await resetTokenExpiry(token)) ?? new Date(Date.now() + PASSWORD_RESET_TTL_SECONDS * 1000);
  return { url: buildResetLink(token), expiresAt };
}

import { isProduction } from "../config.js";
import { getSettings } from "./settings.js";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Turnstile `secretKey`/`required` endi admin panelda ham sozlanishi mumkin
 * (`lib/settings.ts`, env ustunlik qiladi) — shu sabab har chaqiriqda
 * `getSettings()` orqali JORIY qiymat o'qiladi (restart shart emas).
 *
 * `secretKey` bo'sh bo'lsa:
 * - dev/test'da tekshiruv o'tkazib yuboriladi (qulaylik uchun);
 * - prod'da `required=true` bo'lsa rad etiladi (fail-closed),
 *   aks holda o'tkazib yuboriladi (fail-open).
 */
export async function verifyTurnstile(token: string | undefined, remoteIp: string): Promise<boolean> {
  const settings = await getSettings();

  if (!settings.turnstile.secretKey) {
    if (isProduction && settings.turnstile.required) return false;
    return true;
  }
  if (!token) return false;

  try {
    const body = new URLSearchParams({
      secret: settings.turnstile.secretKey,
      response: token,
    });
    if (remoteIp && remoteIp !== "unknown") body.set("remoteip", remoteIp);

    const res = await fetch(VERIFY_URL, { method: "POST", body });
    const data = (await res.json()) as { success?: boolean };
    return Boolean(data.success);
  } catch {
    return false;
  }
}

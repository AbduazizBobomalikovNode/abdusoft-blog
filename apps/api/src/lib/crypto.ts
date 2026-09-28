import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
/** Format: `enc:v1:<iv base64>:<authTag base64>:<ciphertext base64>` — eski (legacy) qiymatlar oddiy matn holida saqlangan bo'lishi mumkin, ular o'zgarishsiz o'qiladi. */
const PREFIX = "enc:v1:";

let cachedKey: Buffer | null = null;

/** AES-256-GCM kaliti — `BETTER_AUTH_SECRET`ning SHA-256 xeshidan olinadi (alohida maxfiy kalit talab qilinmaydi). */
function deriveKey(): Buffer {
  cachedKey ??= createHash("sha256").update(config.BETTER_AUTH_SECRET).digest();
  return cachedKey;
}

/** Bo'sh satrni bo'sh holicha qaytaradi (shifrlanmagan) — "sozlanmagan" holatni ifodalaydi. */
export function encryptSecret(plain: string): string {
  if (!plain) return "";

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, deriveKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

/**
 * `enc:v1:` prefiksi bo'lmasa — eski (legacy) plain-text qiymat deb hisoblanadi
 * va o'zgarishsiz qaytariladi (orqaga moslik). Deshifrlash muvaffaqiyatsiz
 * bo'lsa (masalan `BETTER_AUTH_SECRET` almashtirilgan) bo'sh satr qaytadi —
 * hech qachon throw qilmaydi (chaqiruvchilar "sozlanmagan" deb talqin qiladi).
 */
export function decryptSecret(value: string | null | undefined): string {
  if (!value) return "";
  if (!value.startsWith(PREFIX)) return value;

  const parts = value.slice(PREFIX.length).split(":");
  if (parts.length !== 3) return "";
  const [ivB64, tagB64, dataB64] = parts as [string, string, string];

  try {
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const data = Buffer.from(dataB64, "base64");
    const decipher = createDecipheriv(ALGO, deriveKey(), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    return "";
  }
}

/** Admin UI uchun: oxirgi 4 belgi ko'rinadi, qolgani `••••` bilan yopiladi. */
export function maskSecret(plain: string): string {
  if (!plain) return "";
  const last4 = plain.slice(-4);
  return `••••${last4}`;
}

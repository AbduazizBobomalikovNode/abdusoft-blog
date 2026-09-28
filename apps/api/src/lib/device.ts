import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { config, isProduction } from "../config.js";

const COOKIE_NAME = "bd";
const YEAR_SECONDS = 60 * 60 * 24 * 365;

export interface DeviceInfo {
  deviceId: string;
  deviceHash: string;
  ipHash: string;
}

function secret(): string {
  return config.DEVICE_SECRET || config.BETTER_AUTH_SECRET;
}

function sign(id: string): string {
  return createHmac("sha256", secret()).update(id).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * `TRUST_PROXY=false` (dev, default) — mijoz `x-forwarded-for`/`x-real-ip`
 * header'larini soxtalashtirishi mumkin bo'lgani uchun ular butunlay e'tiborsiz
 * qoldiriladi, faqat socket manzili ishlatiladi.
 *
 * `TRUST_PROXY=true` (prod, Coolify/Traefik orqasida) — `x-forwarded-for`dagi
 * OXIRGI (eng yaqin) hopdan foydalaniladi, chunki bizning proksi shu qiymatni
 * o'zi qo'shib qo'yadi va undan oldingi qiymatlarni mijoz istalgancha
 * soxtalashtirishi mumkin.
 */
export function clientIp(c: Context): string {
  if (config.TRUST_PROXY) {
    const forwarded = c.req.header("x-forwarded-for");
    if (forwarded) {
      const parts = forwarded.split(",").map((p) => p.trim()).filter(Boolean);
      const last = parts[parts.length - 1];
      if (last) return last;
    }
    const real = c.req.header("x-real-ip");
    if (real) return real;
  }

  try {
    const info = getConnInfo(c);
    if (info.remote.address) return info.remote.address;
  } catch {
    // Node bo'lmagan runtime'da yoki testda ulanish ma'lumoti bo'lmasligi mumkin.
  }

  return "unknown";
}

function hashWithSecret(value: string): string {
  return createHash("sha256").update(value + secret()).digest("hex");
}

/**
 * Qurilma identifikatori: `bd` HttpOnly cookie'da saqlanadi (32 bayt tasodifiy
 * id + HMAC-SHA256 imzo). Cookie mavjud bo'lmasa yoki imzo noto'g'ri bo'lsa,
 * yangisi yaratiladi va javobga qo'yiladi. `device_hash` va `ip_hash` doim shu
 * qurilma uchun deterministik (izohlar egaligi va rate-limit uchun).
 */
export function getDevice(c: Context): DeviceInfo {
  const raw = getCookie(c, COOKIE_NAME);
  let deviceId: string | null = null;

  if (raw) {
    const dotIndex = raw.indexOf(".");
    if (dotIndex > 0) {
      const id = raw.slice(0, dotIndex);
      const sig = raw.slice(dotIndex + 1);
      if (id && sig && safeEqual(sign(id), sig)) {
        deviceId = id;
      }
    }
  }

  if (!deviceId) {
    deviceId = randomBytes(32).toString("hex");
    setCookie(c, COOKIE_NAME, `${deviceId}.${sign(deviceId)}`, {
      path: "/",
      httpOnly: true,
      maxAge: YEAR_SECONDS,
      sameSite: "Lax",
      secure: isProduction,
      domain: isProduction && config.COOKIE_DOMAIN ? config.COOKIE_DOMAIN : undefined,
    });
  }

  return {
    deviceId,
    deviceHash: hashWithSecret(deviceId),
    ipHash: hashWithSecret(clientIp(c)),
  };
}

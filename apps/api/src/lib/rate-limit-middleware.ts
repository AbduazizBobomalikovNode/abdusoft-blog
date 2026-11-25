import type { Context, Next } from "hono";
import { clientIp } from "./device.js";
import { consumeRateLimit } from "./rate-limit.js";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Mavjud xotiradagi limiter ustiga qurilgan Hono middleware: faqat yozuv
 * metodlari (POST/PUT/PATCH/DELETE) mijoz IP'si bo'yicha hisoblanadi (IP —
 * `clientIp`, ya'ni `TRUST_PROXY` hisobga olinadi). Limitdan oshsa `429` va
 * `Retry-After` qaytariladi. `limit <= 0` — middleware hech narsa qilmaydi.
 */
export function rateLimitWrites(opts: { name: string; limit: number; windowSeconds: number }) {
  const windowMs = opts.windowSeconds * 1000;

  return async (c: Context, next: Next) => {
    if (opts.limit <= 0 || !WRITE_METHODS.has(c.req.method)) return next();

    const result = consumeRateLimit(`${opts.name}:${clientIp(c)}`, opts.limit, windowMs);
    if (!result.allowed) {
      c.header("Retry-After", String(result.retryAfterSeconds));
      return c.json(
        {
          error: "Juda ko'p so'rov yuborildi — biroz kutib, qayta urinib ko'ring",
          retryAfter: result.retryAfterSeconds,
        },
        429,
      );
    }

    return next();
  };
}

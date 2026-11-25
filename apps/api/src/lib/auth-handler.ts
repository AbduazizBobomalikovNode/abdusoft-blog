import type { Context } from "hono";
import { config, isProduction } from "../config.js";
import { auth } from "./auth.js";
import { AUTH_CLIENT_IP_HEADER } from "./auth-options.js";
import { clientIp } from "./device.js";
import { RESET_PAGE_PATH } from "./password-reset.js";
import { consumeRateLimit } from "./rate-limit.js";

/**
 * `/api/auth/*` so'rovlarini Better Auth'ga uzatadi. Better Auth rate limit
 * uchun IP'ni faqat `AUTH_CLIENT_IP_HEADER` header'idan oladi; uni bu yerda
 * HAR DOIM `clientIp(c)` (ya'ni `TRUST_PROXY` hisobga olingan, soxtalashtirib
 * bo'lmaydigan qiymat) bilan qayta yozamiz — mijoz yuborgan qiymat ishlatilmaydi.
 *
 * `request` (ixtiyoriy) — MCP yoqilganda so'rovni (masalan `scope`ga `offline_access` qo'shib) o'zgartirib uzatish uchun;
 * berilmasa avvalgidek `c.req.raw`.
 *
 * Better Auth 429 javobida `X-Retry-After` beradi; standart `Retry-After`
 * header'i ham qo'shiladi.
 */
export async function handleAuthRequest(c: Context, request: Request = c.req.raw): Promise<Response> {
  const blocked = limitResetLinkOpens(c, request);
  if (blocked) return blocked;

  const headers = new Headers(request.headers);
  headers.set(AUTH_CLIENT_IP_HEADER, clientIp(c));

  const res = await auth.handler(new Request(request, { headers }));

  if (res.status === 429 && !res.headers.has("Retry-After")) {
    const retryAfter = res.headers.get("X-Retry-After");
    if (retryAfter) {
      const patched = new Response(res.body, res);
      patched.headers.set("Retry-After", retryAfter);
      return patched;
    }
  }

  return res;
}

const RESET_LINK_OPEN_PATH = /^\/api\/auth\/reset-password\/[^/]+\/?$/;

/**
 * `GET /api/auth/reset-password/:token` (tiklash havolasini ochish) Better Auth'ning IP|yo'l kaliti bilan
 * cheklanmaydi: kalitga tokenning o'zi kiradi, ya'ni har bir taxminiy token yangi hisob — brute-force'ga to'siq yo'q.
 * Shu sabab bu yerda token'siz, faqat IP bo'yicha qo'shimcha chegara (qolgan auth endpoint'lari bilan bir xil son/oyna
 * va yoqish qoidasi). Brauzer navigatsiyasi uchun JSON emas — tiklash sahifasiga `error=RATE_LIMITED` bilan yo'naltiriladi.
 */
function limitResetLinkOpens(c: Context, request: Request): Response | null {
  const enabled = config.AUTH_RATE_LIMIT_ENABLED ?? isProduction;
  if (!enabled || request.method !== "GET" || !RESET_LINK_OPEN_PATH.test(new URL(request.url).pathname)) return null;

  const result = consumeRateLimit(
    `auth-reset-link-open:${clientIp(c)}`,
    config.AUTH_RATE_LIMIT_MAX,
    config.AUTH_RATE_LIMIT_WINDOW_SECONDS * 1000,
  );
  if (result.allowed) return null;

  const target = new URL(`${config.WEB_ORIGIN}${RESET_PAGE_PATH}`);
  target.searchParams.set("error", "RATE_LIMITED");
  target.searchParams.set("wait", String(result.retryAfterSeconds));
  return new Response(null, {
    status: 302,
    headers: { Location: target.href, "Retry-After": String(result.retryAfterSeconds), "Cache-Control": "no-store" },
  });
}

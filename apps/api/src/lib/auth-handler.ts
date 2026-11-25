import type { Context } from "hono";
import { auth } from "./auth.js";
import { AUTH_CLIENT_IP_HEADER } from "./auth-options.js";
import { clientIp } from "./device.js";

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

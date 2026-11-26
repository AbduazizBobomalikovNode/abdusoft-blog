import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { DOC_LIMITS } from "@blog/shared";

/**
 * Hujjat qabul qiladigan admin marshrutlari (post tahriri, "Haqida" sahifasi, kanal versiyasi) uchun so'rov tanasi chegarasi.
 * Hujjat validatori (`DOC_LIMITS.maxDocSize`, ~2 000 000 belgi) renderdan oldin ishlaydi, lekin tana JSON sifatida o'qilgandan
 * KEYIN; bu chegara esa o'qishdan OLDIN ortiqcha tanani to'xtatadi (kirill/maxsus belgilarda bayt soni belgilar sonidan
 * ~2 baravar ko'p bo'lishi mumkin, shuning uchun zaxira bilan).
 */
export const ADMIN_DOC_BODY_MAX_BYTES = Math.ceil(DOC_LIMITS.maxDocSize * 2.5);

/** `match` rost bo'lgan so'rovlarga chegara qo'llanadi (qolganlari o'zgarishsiz o'tadi). */
export function adminDocBodyLimit(match: (c: Context) => boolean): MiddlewareHandler {
  const limiter = bodyLimit({
    maxSize: ADMIN_DOC_BODY_MAX_BYTES,
    onError: (c) => c.json({ error: `So'rov hajmi juda katta (ko'pi bilan ${Math.round(ADMIN_DOC_BODY_MAX_BYTES / 1024 / 1024)} MB)` }, 413),
  });
  return async (c, next) => (match(c) ? limiter(c, next) : next());
}

/** Ikki middleware'ni BITTA middleware qilib birlashtiradi (marshrut jadvalida qo'shimcha yozuv paydo bo'lmasin). */
export function chain(first: MiddlewareHandler, second: MiddlewareHandler): MiddlewareHandler {
  return async (c, next) => {
    let response: Response | void = undefined;
    const result = await first(c, async () => {
      response = await second(c, next);
      if (response instanceof Response) c.res = response;
    });
    return result ?? response;
  };
}

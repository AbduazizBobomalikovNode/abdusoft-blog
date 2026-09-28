import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { config } from "./config.js";
import { auth } from "./lib/auth.js";
import { uploadsDir } from "./lib/media/store.js";
import { adminRoute } from "./routes/admin.js";
import { commentItemRoute } from "./routes/comment-item.js";
import { postCommentsRoute } from "./routes/comments.js";
import { healthRoute } from "./routes/health.js";
import { meRoute } from "./routes/me.js";
import { postsRoute } from "./routes/posts.js";
import { siteRoute } from "./routes/site.js";
import { tagsRoute } from "./routes/tags.js";
import { mountTelegramWebhook } from "./telegram/bot.js";

export const app = new Hono();

app.use(logger());
app.use(async (c, next) => {
  // `/uploads/*` o'zining CSP sandbox + nosniff + CORP header'larini pastda
  // o'rnatadi (media rasmlarni web origin'idan <img> bilan yuklash uchun
  // `Cross-Origin-Resource-Policy: cross-origin` kerak). `secureHeaders()`
  // header'larni `next()`dan KEYIN `ctx.res.headers.set(...)` bilan qo'yadi —
  // bu ichkarida o'rnatilgan qiymatlarni har doim qayta yozib yuboradi
  // (masalan CORP'ni yana `same-origin`ga qaytaradi). Shu sabab bu marshrut
  // uchun global secureHeaders() umuman ishlatilmaydi, qolgan hamma joyda esa
  // avvalgidek qat'iy sozlamalar saqlanadi.
  if (c.req.path.startsWith("/uploads/")) return next();
  return secureHeaders()(c, next);
});
app.use(
  "*",
  cors({
    origin: config.WEB_ORIGIN,
    credentials: true,
  }),
);

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.use("/uploads/*", async (c, next) => {
  // SVG upload'lar (sharp orqali o'tmaydigan passthrough fayllar) shu papkadan
  // to'g'ridan-to'g'ri xizmat qilinadi — yuklashda tozalangan bo'lsa ham
  // (lib/media/store.ts), qo'shimcha himoya qatlami sifatida ijro etuvchi
  // kontekstni butunlay o'chirib qo'yamiz (sandbox + strict CSP).
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  );
  c.header("X-Content-Type-Options", "nosniff");
  // Global `secureHeaders()` (yuqorida) `Cross-Origin-Resource-Policy: same-origin`
  // qo'yadi, bu esa web (localhost:3000) dan API (localhost:4000) orqali
  // xizmat qilinadigan rasmlarni <img> bilan yuklashni bloklaydi
  // (ERR_BLOCKED_BY_RESPONSE.NotSameOrigin). Media faqat shu marshrut uchun
  // cross-origin qiladi — boshqa marshrutlarda global qat'iy qiymat saqlanadi.
  c.header("Cross-Origin-Resource-Policy", "cross-origin");
  await next();
});
app.use(
  "/uploads/*",
  serveStatic({
    root: uploadsDir,
    rewriteRequestPath: (path) => path.replace(/^\/uploads/, ""),
  }),
);

app.route("/health", healthRoute);
app.route("/me", meRoute);
app.route("/posts", postsRoute);
app.route("/posts", postCommentsRoute);
app.route("/comments", commentItemRoute);
app.route("/tags", tagsRoute);
app.route("/site", siteRoute);
app.route("/admin", adminRoute);
mountTelegramWebhook(app);

export type AppType = typeof app;

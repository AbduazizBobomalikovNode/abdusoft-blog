import { Hono } from "hono";
import { config } from "../config.js";
import { loadDistributionModule } from "../lib/distribution/load-guard.js";
import { rateLimitWrites } from "../lib/rate-limit-middleware.js";
import { requireRole } from "../lib/require-admin.js";
import { adminAuditRoute } from "./admin-audit.js";
import { adminBansRoute, adminCommentsRoute } from "./admin-comments.js";
import { adminConnectionsRoute } from "./admin-connections.js";
import { adminMediaRoute } from "./admin-media.js";
import { adminPostsRoute } from "./admin-posts.js";
import { adminSettingsRoute } from "./admin-settings.js";
import { adminSiteRoute } from "./admin-site.js";
import { adminStaffRoute } from "./admin-staff.js";
import { adminStatsRoute } from "./admin-stats.js";
import { adminTagsRoute } from "./admin-tags.js";
import { adminTelegramRoute } from "./admin-telegram.js";

export const adminRoute = new Hono()
  // Yozuv so'rovlari (POST/PUT/PATCH/DELETE) IP bo'yicha cheklanadi — sessiya tekshiruvidan OLDIN,
  // shunda avtorizatsiyasiz urinishlar ham hisoblanadi. GET'lar cheklanmaydi.
  .use(
    "*",
    rateLimitWrites({
      name: "admin-write",
      limit: config.ADMIN_WRITE_RATE_LIMIT_MAX,
      windowSeconds: config.ADMIN_WRITE_RATE_LIMIT_WINDOW_SECONDS,
    }),
  )
  // Staff ham o'zini tekshirishi kerak (admin panel shell'i rolga qarab
  // navigatsiyani filtrlaydi) — shu sabab "/me" admin+staff uchun ochiq,
  // qolgan hamma marshrut alohida rollarni o'zi belgilaydi.
  .get("/me", requireRole("admin", "staff"), (c) => {
    const adminUser = c.get("adminUser");
    // Veb "Tarqatish" kirish nuqtalarini ko'rsatish-ko'rsatmasligini shundan biladi (alohida 404 so'rovlarisiz).
    // Bayroq o'chiq (yoki xodim) bo'lsa javob avvalgidek — maydon yo'q.
    return c.json(config.DISTRIBUTION_ENABLED && adminUser.role === "admin" ? { ...adminUser, distributionEnabled: true } : adminUser);
  })
  .route("/posts", adminPostsRoute)
  .route("/media", adminMediaRoute)
  .route("/tags", adminTagsRoute)
  .route("/site", adminSiteRoute)
  .route("/comments", adminCommentsRoute)
  .route("/bans", adminBansRoute)
  .route("/stats", adminStatsRoute)
  .route("/telegram", adminTelegramRoute)
  .route("/settings", adminSettingsRoute)
  .route("/staff", adminStaffRoute)
  .route("/audit", adminAuditRoute);

// "Ulangan ilovalar" (Claude konnektori) — faqat MCP_ENABLED=true bo'lganda; o'chiq bo'lsa marshrut yo'q.
if (config.MCP_ENABLED) adminRoute.route("/connections", adminConnectionsRoute);

// Ijtimoiy tarqatish — faqat DISTRIBUTION_ENABLED=true bo'lganda; o'chiq bo'lsa marshrut ham, modul ham yuklanmaydi.
if (config.DISTRIBUTION_ENABLED) {
  const { adminDistributionRoute } = await loadDistributionModule("routes/admin-distribution", () => import("./admin-distribution.js"));
  adminRoute.route("/distribution", adminDistributionRoute);
}

import { Hono } from "hono";
import { requireRole } from "../lib/require-admin.js";
import { adminBansRoute, adminCommentsRoute } from "./admin-comments.js";
import { adminMediaRoute } from "./admin-media.js";
import { adminPostsRoute } from "./admin-posts.js";
import { adminSettingsRoute } from "./admin-settings.js";
import { adminSiteRoute } from "./admin-site.js";
import { adminStaffRoute } from "./admin-staff.js";
import { adminStatsRoute } from "./admin-stats.js";
import { adminTagsRoute } from "./admin-tags.js";
import { adminTelegramRoute } from "./admin-telegram.js";

export const adminRoute = new Hono()
  // Staff ham o'zini tekshirishi kerak (admin panel shell'i rolga qarab
  // navigatsiyani filtrlaydi) — shu sabab "/me" admin+staff uchun ochiq,
  // qolgan hamma marshrut alohida rollarni o'zi belgilaydi.
  .get("/me", requireRole("admin", "staff"), (c) => {
    const adminUser = c.get("adminUser");
    return c.json(adminUser);
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
  .route("/staff", adminStaffRoute);

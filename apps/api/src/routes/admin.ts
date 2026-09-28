import { Hono } from "hono";
import { requireAdmin } from "../lib/require-admin.js";
import { adminBansRoute, adminCommentsRoute } from "./admin-comments.js";
import { adminMediaRoute } from "./admin-media.js";
import { adminPostsRoute } from "./admin-posts.js";
import { adminSettingsRoute } from "./admin-settings.js";
import { adminSiteRoute } from "./admin-site.js";
import { adminStatsRoute } from "./admin-stats.js";
import { adminTagsRoute } from "./admin-tags.js";
import { adminTelegramRoute } from "./admin-telegram.js";

export const adminRoute = new Hono()
  .get("/me", requireAdmin, (c) => {
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
  .route("/settings", adminSettingsRoute);

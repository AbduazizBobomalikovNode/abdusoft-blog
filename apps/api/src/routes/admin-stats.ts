import { Hono } from "hono";
import { StatsRangeSchema } from "@blog/shared";
import { getPostStatsView, getStatsOverview } from "../lib/admin-reads/stats.js";
import { requireAdmin } from "../lib/require-admin.js";
import {
  pendingCommentsCount,
  resolveRange,
  topPostsForRange,
  totalsForRange,
  type RangeWindow,
} from "../lib/stats.js";
import { fetchUmamiStats } from "../lib/umami.js";

const SUMMARY_TOP_POSTS_LIMIT = 3;

function parseRange(raw: string | undefined): "7d" | "30d" | "90d" | "all" {
  const parsed = StatsRangeSchema.safeParse(raw ?? "7d");
  return parsed.success ? parsed.data : "7d";
}

export const adminStatsRoute = new Hono()
  .use("*", requireAdmin)
  .get("/overview", async (c) => {
    return c.json(await getStatsOverview(parseRange(c.req.query("range"))));
  })
  .get("/summary", async (c) => {
    const window7d = resolveRange("7d");
    const todayWindow: RangeWindow = { startDay: window7d.endDay, endDay: window7d.endDay, days: 1 };

    const [todayViews, last7d, last30d, pending, topPosts] = await Promise.all([
      totalsForRange(null, todayWindow),
      totalsForRange(null, window7d),
      totalsForRange(null, resolveRange("30d")),
      pendingCommentsCount(null),
      topPostsForRange(window7d, SUMMARY_TOP_POSTS_LIMIT),
    ]);

    return c.json({
      today: { views: todayViews.views },
      last7d,
      last30d,
      pendingComments: pending,
      topPosts: topPosts.map((p) => ({ slug: p.slug, title: p.title, views: p.views })),
    });
  })
  .get("/umami", async (c) => {
    const range = parseRange(c.req.query("range"));
    const data = await fetchUmamiStats(range);
    return c.json(data);
  })
  .get("/posts/:id", async (c) => {
    const view = await getPostStatsView(c.req.param("id"), parseRange(c.req.query("range")));
    if (!view) return c.json({ error: "Topilmadi" }, 404);
    return c.json(view);
  });

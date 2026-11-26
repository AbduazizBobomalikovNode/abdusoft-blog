import { Hono } from "hono";
import { StatsRangeSchema } from "@blog/shared";
import { getPostStatsView, getStatsOverview, getStatsSummary } from "../lib/admin-reads/stats.js";
import { requireAdmin } from "../lib/require-admin.js";
import { fetchUmamiStats } from "../lib/umami.js";

function parseRange(raw: string | undefined): "7d" | "30d" | "90d" | "all" {
  const parsed = StatsRangeSchema.safeParse(raw ?? "7d");
  return parsed.success ? parsed.data : "7d";
}

export const adminStatsRoute = new Hono()
  .use("*", requireAdmin)
  .get("/overview", async (c) => {
    return c.json(await getStatsOverview(parseRange(c.req.query("range"))));
  })
  .get("/summary", async (c) => c.json(await getStatsSummary()))
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

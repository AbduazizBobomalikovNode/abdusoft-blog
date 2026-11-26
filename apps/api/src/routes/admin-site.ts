import { Hono } from "hono";
import { UpdateSiteSettingsBodySchema } from "@blog/shared";
import { requireAdmin } from "../lib/require-admin.js";
import { adminDocBodyLimit, chain } from "../lib/body-limit.js";
import { actorFromAdminUser } from "../lib/posts/types.js";
import { loadSiteSettings } from "../lib/site-settings.js";
import { updateSiteSettings } from "../lib/site-admin.js";

const SITE_BODY_LIMIT = adminDocBodyLimit((c) => c.req.method === "PUT");

export const adminSiteRoute = new Hono()
  .use("*", chain(requireAdmin, SITE_BODY_LIMIT))
  .get("/", async (c) => {
    const settings = await loadSiteSettings();
    return c.json(settings);
  })
  .put("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = UpdateSiteSettingsBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);

    const result = await updateSiteSettings(actorFromAdminUser(c.get("adminUser")), parsed.data);
    if (!result.ok) return c.json({ error: result.error.message }, 400);
    return c.json(result.data);
  });

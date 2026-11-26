import { Hono } from "hono";
import { SocialLinksSchema, PostSettingsSchema, TelegramSettingsSchema, UpdateSiteSettingsBodySchema } from "@blog/shared";
import { requireAdmin } from "../lib/require-admin.js";
import { adminDocBodyLimit, chain } from "../lib/body-limit.js";
import { recordAuditSafe } from "../lib/audit.js";
import { actorFromAdminUser } from "../lib/posts/types.js";
import { validatePanelDocument } from "../lib/content/validate.js";
import { renderPost } from "../lib/content/render.js";
import {
  ABOUT_KEY,
  DEFAULT_POST_SETTINGS_KEY,
  SOCIAL_KEY,
  TELEGRAM_KEY,
  loadSiteSettings,
  upsertSiteSetting,
} from "../lib/site-settings.js";
import { revalidateWeb } from "../lib/revalidate.js";

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

    const current = await loadSiteSettings();
    const revalidatePaths = new Set<string>();

    if (parsed.data.about !== undefined) {
      const docCheck = validatePanelDocument(parsed.data.about.json);
      if (!docCheck.ok) return c.json({ error: `Hujjat qabul qilinmadi: ${docCheck.message}` }, 400);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tiptap JSONContent
      const rendered = await renderPost(parsed.data.about.json as any);
      await upsertSiteSetting(ABOUT_KEY, { json: parsed.data.about.json, html: rendered.html });
      revalidatePaths.add("/haqida");
    }

    if (parsed.data.social !== undefined) {
      const merged = SocialLinksSchema.parse({ ...current.social, ...parsed.data.social });
      await upsertSiteSetting(SOCIAL_KEY, merged);
      revalidatePaths.add("/");
      revalidatePaths.add("/haqida");
    }

    if (parsed.data.defaultPostSettings !== undefined) {
      const merged = PostSettingsSchema.parse({
        ...current.defaultPostSettings,
        ...parsed.data.defaultPostSettings,
      });
      await upsertSiteSetting(DEFAULT_POST_SETTINGS_KEY, merged);
    }

    if (parsed.data.telegram !== undefined) {
      const merged = TelegramSettingsSchema.parse({ ...current.telegram, ...parsed.data.telegram });
      await upsertSiteSetting(TELEGRAM_KEY, merged);
    }

    if (revalidatePaths.size > 0) {
      revalidateWeb([...revalidatePaths]);
    }

    const sections = Object.entries(parsed.data)
      .filter(([, value]) => value !== undefined)
      .map(([name]) => name);
    await recordAuditSafe(actorFromAdminUser(c.get("adminUser")), {
      action: "site.update",
      entityType: "site",
      summary: `Sayt sozlamalari yangilandi: ${sections.join(", ") || "—"}`,
      meta: { sections },
    });

    const fresh = await loadSiteSettings();
    return c.json(fresh);
  });

import { PostSettingsSchema, SocialLinksSchema, TelegramSettingsSchema, type SettingsPatch, type UpdateSiteSettingsBody } from "@blog/shared";
import { recordAuditSafe } from "./audit.js";
import { validatePanelDocument } from "./content/validate.js";
import { renderPost } from "./content/render.js";
import { fail, ok, type Actor, type ServiceResult } from "./posts/types.js";
import { revalidateWeb } from "./revalidate.js";
import { saveSettings } from "./settings.js";
import { ABOUT_KEY, DEFAULT_POST_SETTINGS_KEY, SOCIAL_KEY, TELEGRAM_KEY, loadSiteSettings, upsertSiteSetting } from "./site-settings.js";

/**
 * `PUT /admin/site` va MCP `update_site_settings` / `update_about_page` uchun YAGONA yo'l: "Haqida" hujjati (panel validatori +
 * render), ijtimoiy havolalar, standart post sozlamalari, Telegram ko'rsatish sozlamalari; keyin revalidate + jurnal.
 */
export async function updateSiteSettings(actor: Actor, body: UpdateSiteSettingsBody): Promise<ServiceResult<Awaited<ReturnType<typeof loadSiteSettings>>>> {
  const current = await loadSiteSettings();
  const revalidatePaths = new Set<string>();

  if (body.about !== undefined) {
    const docCheck = validatePanelDocument(body.about.json);
    if (!docCheck.ok) return fail("bad_request", `Hujjat qabul qilinmadi: ${docCheck.message}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tiptap JSONContent
    const rendered = await renderPost(body.about.json as any);
    await upsertSiteSetting(ABOUT_KEY, { json: body.about.json, html: rendered.html });
    revalidatePaths.add("/haqida");
  }
  if (body.social !== undefined) {
    await upsertSiteSetting(SOCIAL_KEY, SocialLinksSchema.parse({ ...current.social, ...body.social }));
    revalidatePaths.add("/");
    revalidatePaths.add("/haqida");
  }
  if (body.defaultPostSettings !== undefined) {
    await upsertSiteSetting(DEFAULT_POST_SETTINGS_KEY, PostSettingsSchema.parse({ ...current.defaultPostSettings, ...body.defaultPostSettings }));
  }
  if (body.telegram !== undefined) {
    await upsertSiteSetting(TELEGRAM_KEY, TelegramSettingsSchema.parse({ ...current.telegram, ...body.telegram }));
  }
  if (revalidatePaths.size > 0) revalidateWeb([...revalidatePaths]);

  const sections = Object.entries(body)
    .filter(([, value]) => value !== undefined)
    .map(([name]) => name);
  await recordAuditSafe(actor, {
    action: "site.update",
    entityType: "site",
    summary: `Sayt sozlamalari yangilandi: ${sections.join(", ") || "—"}`,
    meta: { sections },
  });
  return ok(await loadSiteSettings());
}

/** `PUT /admin/settings` va MCP `update_site_settings` (faqat `general`) uchun: saqlash + jurnal (faqat bo'lim nomlari). */
export async function saveSettingsAudited(actor: Actor, patch: SettingsPatch): Promise<void> {
  await saveSettings(patch);
  const sections = Object.entries(patch)
    .filter(([, value]) => value !== undefined)
    .map(([name]) => name);
  await recordAuditSafe(actor, {
    action: "settings.update",
    entityType: "settings",
    summary: `Sozlamalar yangilandi: ${sections.join(", ") || "—"}`,
    meta: { sections },
  });
}

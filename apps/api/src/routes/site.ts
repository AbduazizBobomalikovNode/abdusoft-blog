import { Hono } from "hono";
import { getSettings } from "../lib/settings.js";
import { loadSiteSettings } from "../lib/site-settings.js";

export const siteRoute = new Hono().get("/", async (c) => {
  const [settings, integrations] = await Promise.all([loadSiteSettings(), getSettings()]);
  return c.json({
    about: { html: settings.about.html },
    social: settings.social,
    config: {
      siteName: integrations.general.siteName,
      siteDescription: integrations.general.siteDescription,
      turnstileSiteKey: integrations.turnstile.siteKey,
      umamiScriptUrl: integrations.umami.scriptUrl,
      umamiWebsiteId: integrations.umami.websiteId,
      githubLoginEnabled: integrations.github.providerEnabled && integrations.github.loginEnabled,
      githubConfigured: integrations.github.providerEnabled,
      telegramDisplay: integrations.telegram.telegramDisplay,
    },
  });
});

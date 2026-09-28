"use client";

import { createContext, useContext } from "react";
import type { PublicSiteConfig } from "@blog/shared";
import { site } from "./site";

/** API ishlamay qolsa yoki `(site)` layout hali GET /site'ni bajarmagan bo'lsa ishlatiladigan fallback (build-time env). */
const FALLBACK_CONFIG: PublicSiteConfig = {
  siteName: site.name,
  siteDescription: "",
  turnstileSiteKey: site.turnstileSiteKey,
  umamiScriptUrl: site.umamiScriptUrl,
  umamiWebsiteId: site.umamiWebsiteId,
  githubLoginEnabled: site.githubLoginEnabled,
};

const SiteConfigContext = createContext<PublicSiteConfig>(FALLBACK_CONFIG);

/**
 * `(site)` layout har so'rovda `GET /site`dan (`revalidate: 60`) olingan
 * runtime sozlamalarni shu Provider orqali pastga uzatadi — admin panelda
 * Turnstile/Umami/GitHub-login sozlamalari o'zgarsa, web'da restart/redeploy
 * shart emas (keyingi so'rovda yangi qiymat ko'rinadi).
 */
export function SiteConfigProvider({
  value,
  children,
}: {
  value: PublicSiteConfig | null;
  children: React.ReactNode;
}) {
  return <SiteConfigContext.Provider value={value ?? FALLBACK_CONFIG}>{children}</SiteConfigContext.Provider>;
}

export function useSiteConfig(): PublicSiteConfig {
  return useContext(SiteConfigContext);
}

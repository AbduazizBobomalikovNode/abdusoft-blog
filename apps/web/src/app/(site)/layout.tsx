import Script from "next/script";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { getSite } from "@/lib/api";
import { SiteConfigProvider } from "@/lib/site-config";

/** Ommaviy (public) sahifalar uchun umumiy qobiq: header + markazlashgan ustun + footer. */
export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  // `getSite()` — `revalidate: 60` bilan har so'rovda (Next.js data cache orqali)
  // API'dan runtime konfiguratsiyani o'qiydi (Turnstile site key, Umami, GitHub
  // login, sayt nomi) — admin panelda o'zgartirilsa, keyingi so'rovda ko'rinadi.
  const data = await getSite();
  const config = data?.config ?? null;

  return (
    <SiteConfigProvider value={config}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-foreground focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Asosiy kontentga o&apos;tish
      </a>
      <SiteHeader />
      <main id="main-content" className="mx-auto w-full max-w-[680px] flex-1 px-4 py-8">
        {children}
      </main>
      <SiteFooter />
      {config?.umamiScriptUrl && config.umamiWebsiteId ? (
        <Script defer src={config.umamiScriptUrl} data-website-id={config.umamiWebsiteId} />
      ) : null}
    </SiteConfigProvider>
  );
}

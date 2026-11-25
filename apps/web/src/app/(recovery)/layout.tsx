import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

/**
 * Parolni tiklash sahifalari uchun qobiq — `(site)` layout bilan bir xil ko'rinish (header + ustun + footer), lekin
 * Umami skriptisiz (token manzilda bo'lishi mumkin: sahifa hech qanday uchinchi tomon so'rovini yuklamasligi shart).
 */
export default function RecoveryLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main id="main-content" className="mx-auto w-full max-w-[680px] flex-1 px-4 py-8">
        {children}
      </main>
      <SiteFooter />
    </>
  );
}

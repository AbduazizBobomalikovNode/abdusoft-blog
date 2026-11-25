import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { site } from "@/lib/site";

/**
 * Kirish sahifasi uslubidagi qobiq (belgi + sayt nomi + sarlavha + karta). Tashqi so'rovlarsiz: faqat shrift (build'da
 * o'zimizga yuklangan) va API — parol tiklash sahifalari uchun (token manzilda bo'lishi mumkin).
 */
export function AuthShell({
  subtitle,
  children,
  backHref = "/login",
  backLabel = "Kirish sahifasiga qaytish",
}: {
  subtitle: string;
  children: ReactNode;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-sm flex-col justify-center gap-6 px-4 py-12">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <ShieldCheck className="size-5" aria-hidden="true" />
        </span>
        <h1 className="text-lg font-semibold tracking-tight">{site.name}</h1>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </div>

      {children}

      <Link
        href={backHref}
        className="mx-auto flex items-center gap-1.5 rounded text-sm text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        {backLabel}
      </Link>
    </main>
  );
}

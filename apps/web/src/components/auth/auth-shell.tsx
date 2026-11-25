import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { site } from "@/lib/site";

/**
 * Kirish sahifasi bilan bir xil ko'rinish (belgi + sayt nomi + sarlavha + karta) — parol tiklash sahifalari uchun.
 */
export function BackLink({ href = "/login", label = "Kirish sahifasiga qaytish" }: { href?: string; label?: string }) {
  return (
    <Link
      href={href}
      className="mx-auto flex items-center gap-1.5 rounded text-sm text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
    >
      <ArrowLeft className="size-3.5" aria-hidden="true" />
      {label}
    </Link>
  );
}

export function AuthShell({
  subtitle,
  children,
  backHref = "/login",
  backLabel = "Kirish sahifasiga qaytish",
}: {
  subtitle: string;
  children: ReactNode;
  backHref?: string | null;
  backLabel?: string;
}) {
  return (
    <div className="mx-auto flex min-h-svh max-w-sm flex-col justify-center gap-6 px-4 py-12">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <ShieldCheck className="size-5" aria-hidden="true" />
        </span>
        <h1 className="text-lg font-semibold tracking-tight">{site.name}</h1>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </div>

      {children}

      {backHref === null ? null : <BackLink href={backHref} label={backLabel} />}
    </div>
  );
}

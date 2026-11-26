import Link from "next/link";
import { Rss } from "lucide-react";
import { LogoMark } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { site } from "@/lib/site";

const NAV_ITEMS = [
  { href: "/", label: "Postlar" },
  { href: "/teglar", label: "Teglar" },
  { href: "/haqida", label: "Haqida" },
];

export function SiteHeader() {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex w-full max-w-[680px] items-center justify-between gap-2 px-4 py-4 sm:gap-4">
        <Link href="/" className="brand-link flex items-center gap-1.5 text-base sm:gap-2 font-semibold tracking-tight">
          <LogoMark className="size-5 rounded-[22%] sm:size-6" />
          {site.name}
        </Link>
        <nav className="flex items-center gap-3 text-sm sm:gap-4 text-muted-foreground">
          {NAV_ITEMS.map((item) => (
            <Link key={item.href} href={item.href} className="hover:text-foreground">
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-1">
          <Link
            href="/rss.xml"
            aria-label="RSS lentasi"
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Rss className="size-4" />
          </Link>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

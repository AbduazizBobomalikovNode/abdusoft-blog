"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ExternalLink, Menu, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import type { Me } from "@blog/shared";
import { LogoutButton } from "@/app/admin/logout-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { site } from "@/lib/site";
import { cn } from "@/lib/utils";
import { isNavItemActive, navItemsForRole, titleForPath, type AdminNavItem } from "./admin-nav";

// Pastki tab bar'da faqat eng ko'p ishlatiladigan 4 ta bo'lim ko'rsatiladi —
// qolganlari "Ko'proq" sheet ichida. 7 ta elementning bittada sig'maganidan.
const MOBILE_BOTTOM_HREFS = new Set(["/admin", "/admin/postlar", "/admin/fikrlar", "/admin/media"]);

function NavLinks({
  pathname,
  pendingComments,
  items,
  onNavigate,
}: {
  pathname: string;
  pendingComments?: number;
  items: AdminNavItem[];
  onNavigate?: () => void;
}) {
  return (
    <nav className="flex flex-col gap-0.5">
      {items.map((item) => {
        const active = isNavItemActive(pathname, item);
        const Icon = item.icon;
        const badge = item.href === "/admin/fikrlar" ? (pendingComments ?? 0) : 0;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {item.label}
            {badge > 0 ? (
              <span className="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[0.65rem] text-primary-foreground">
                {badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

export function AdminShell({
  me,
  pendingComments,
  children,
}: {
  me: Me;
  pendingComments?: number;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const navItems = navItemsForRole(me.role);
  const bottomNavItems = navItems.filter((item) => MOBILE_BOTTOM_HREFS.has(item.href));
  const moreNavItems = navItems.filter((item) => !MOBILE_BOTTOM_HREFS.has(item.href));
  const moreActive = moreNavItems.some((item) => isNavItemActive(pathname, item));

  return (
    <div className="flex min-h-svh w-full">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-svh w-56 shrink-0 flex-col border-r border-border p-3 md:flex">
        <Link href="/admin" className="px-2 py-2 text-sm font-semibold tracking-tight">
          {site.name} <span className="text-muted-foreground">/ admin</span>
        </Link>

        <div className="mt-4 flex-1">
          <NavLinks pathname={pathname} pendingComments={pendingComments} items={navItems} />
        </div>

        <div className="flex flex-col gap-1 border-t border-border pt-3">
          <a
            href={site.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            <ExternalLink className="size-4" />
            Saytga o&apos;tish
          </a>
          <div className="flex items-center justify-between gap-2 px-2.5 py-1">
            <span className="truncate text-xs text-muted-foreground">{me.email}</span>
            <ThemeToggle />
          </div>
          <LogoutButton />
        </div>
      </aside>

      <div className="flex min-h-svh min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="sticky top-0 z-40 flex items-center justify-between border-b border-border bg-background px-4 py-3 md:hidden">
          <span className="text-sm font-semibold tracking-tight">{titleForPath(pathname, me.role)}</span>
          <Button variant="ghost" size="icon-sm" onClick={() => setMobileNavOpen(true)} aria-label="Menyu">
            <Menu className="size-4" />
          </Button>
        </header>

        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetContent side="left" className="flex flex-col p-3">
            <SheetHeader className="p-1">
              <SheetTitle>{site.name} / admin</SheetTitle>
            </SheetHeader>
            <NavLinks
              pathname={pathname}
              pendingComments={pendingComments}
              items={navItems}
              onNavigate={() => setMobileNavOpen(false)}
            />
            <div className="mt-auto flex flex-col gap-1 border-t border-border pt-3">
              <a
                href={site.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              >
                <ExternalLink className="size-4" />
                Saytga o&apos;tish
              </a>
              <div className="flex items-center justify-between gap-2 px-2.5 py-1">
                <span className="truncate text-xs text-muted-foreground">{me.email}</span>
                <ThemeToggle />
              </div>
              <LogoutButton />
            </div>
          </SheetContent>
        </Sheet>

        <main className="flex-1 px-4 py-5 pb-24 md:px-8 md:py-8 md:pb-8">{children}</main>

        {/* Mobile bottom tab bar — 4 ta asosiy bo'lim + "Ko'proq" */}
        <nav
          className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-around border-t border-border bg-background/95 py-1.5 backdrop-blur-sm md:hidden"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          {bottomNavItems.map((item) => {
            const active = isNavItemActive(pathname, item);
            const Icon = item.icon;
            const badge = item.href === "/admin/fikrlar" ? (pendingComments ?? 0) : 0;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex min-w-11 flex-col items-center gap-0.5 px-3 py-1.5 text-[0.65rem] font-medium",
                  active ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <span className="relative">
                  <Icon className="size-5" />
                  {badge > 0 ? (
                    <span className="absolute -top-1 -right-1.5 flex size-3.5 items-center justify-center rounded-full bg-primary text-[0.55rem] text-primary-foreground">
                      {badge > 9 ? "9+" : badge}
                    </span>
                  ) : null}
                </span>
                {item.label}
              </Link>
            );
          })}
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            className={cn(
              "flex min-w-11 flex-col items-center gap-0.5 px-3 py-1.5 text-[0.65rem] font-medium",
              moreActive ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <MoreHorizontal className="size-5" />
            Ko&apos;proq
          </button>
        </nav>

        <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
          <SheetContent side="bottom" className="flex flex-col gap-3 p-3">
            <SheetHeader className="p-1">
              <SheetTitle>Ko&apos;proq</SheetTitle>
            </SheetHeader>
            <NavLinks
              pathname={pathname}
              pendingComments={pendingComments}
              items={moreNavItems}
              onNavigate={() => setMoreOpen(false)}
            />
            <div className="flex flex-col gap-1 border-t border-border pt-3">
              <a
                href={site.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              >
                <ExternalLink className="size-4" />
                Saytga o&apos;tish
              </a>
              <LogoutButton />
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}

import {
  FileText,
  Image as ImageIcon,
  LayoutDashboard,
  MessageSquare,
  Settings,
  ShieldBan,
  Tags,
  Users,
} from "lucide-react";
import type { Role } from "@blog/shared";

export interface AdminNavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  exact?: boolean;
  /** Berilmasa — hamma rol ko'radi. Berilsa — faqat shu rollar ro'yxatda ko'radi. */
  roles?: Role[];
}

export const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/admin/postlar", label: "Postlar", icon: FileText },
  { href: "/admin/fikrlar", label: "Fikrlar", icon: MessageSquare, roles: ["admin"] },
  { href: "/admin/bloklar", label: "Bloklar", icon: ShieldBan, roles: ["admin"] },
  { href: "/admin/media", label: "Media", icon: ImageIcon },
  { href: "/admin/teglar", label: "Teglar", icon: Tags, roles: ["admin"] },
  { href: "/admin/xodimlar", label: "Xodimlar", icon: Users, roles: ["admin"] },
  { href: "/admin/sozlamalar", label: "Sozlamalar", icon: Settings, roles: ["admin"] },
];

export function navItemsForRole(role: Role): AdminNavItem[] {
  return ADMIN_NAV_ITEMS.filter((item) => !item.roles || item.roles.includes(role)).map((item) =>
    role === "staff" && item.href === "/admin/postlar" ? { ...item, label: "Postlarim" } : item,
  );
}

export function isNavItemActive(pathname: string, item: AdminNavItem): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function titleForPath(pathname: string, role: Role = "admin"): string {
  const items = navItemsForRole(role);
  const match = [...items].reverse().find((item) => isNavItemActive(pathname, item));
  return match?.label ?? "Admin";
}

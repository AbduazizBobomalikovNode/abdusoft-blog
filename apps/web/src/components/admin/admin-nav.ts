import {
  FileText,
  Image as ImageIcon,
  LayoutDashboard,
  MessageSquare,
  Settings,
  ShieldBan,
  Tags,
} from "lucide-react";

export interface AdminNavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  exact?: boolean;
}

export const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/admin/postlar", label: "Postlar", icon: FileText },
  { href: "/admin/fikrlar", label: "Fikrlar", icon: MessageSquare },
  { href: "/admin/bloklar", label: "Bloklar", icon: ShieldBan },
  { href: "/admin/media", label: "Media", icon: ImageIcon },
  { href: "/admin/teglar", label: "Teglar", icon: Tags },
  { href: "/admin/sozlamalar", label: "Sozlamalar", icon: Settings },
];

export function isNavItemActive(pathname: string, item: AdminNavItem): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function titleForPath(pathname: string): string {
  const match = [...ADMIN_NAV_ITEMS].reverse().find((item) => isNavItemActive(pathname, item));
  return match?.label ?? "Admin";
}

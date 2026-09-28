import type { Context, Next } from "hono";
import type { Role } from "@blog/shared";
import { auth } from "./auth.js";

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: Role;
}

declare module "hono" {
  interface ContextVariableMap {
    adminUser: AdminUser;
  }
}

/**
 * `requireRole("admin")`, `requireRole("admin", "staff")` va h.k. — sessiya
 * bo'lmasa 401, roli ro'yxatda bo'lmasa 403 qaytaradi. GitHub orqali kirgan
 * ODDIY foydalanuvchi (role "user") hech qachon bu middleware'dan o'tolmaydi —
 * faqat admin panelda (`/admin/xodimlar` yoki taklif qabul qilish orqali)
 * "staff"ga ko'tarilgan yoki dastlabki seed'dagi "admin" hisoblar o'tadi.
 */
export function requireRole(...roles: Role[]) {
  return async (c: Context, next: Next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });

    if (!session) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const role = ((session.user as { role?: string }).role ?? "user") as Role;

    if (!roles.includes(role)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    c.set("adminUser", {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name ?? null,
      role,
    });

    await next();
  };
}

/** Eski nom — faqat "admin" ruxsat beradi. Ko'p marshrutlar hali shu nomdan foydalanadi. */
export const requireAdmin = requireRole("admin");

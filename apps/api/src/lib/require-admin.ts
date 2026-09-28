import type { Context, Next } from "hono";
import { auth } from "./auth.js";

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: "admin" | "user";
}

declare module "hono" {
  interface ContextVariableMap {
    adminUser: AdminUser;
  }
}

export async function requireAdmin(c: Context, next: Next) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const role = (session.user as { role?: string }).role ?? "user";

  if (role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  c.set("adminUser", {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name ?? null,
    role: "admin",
  });

  await next();
}

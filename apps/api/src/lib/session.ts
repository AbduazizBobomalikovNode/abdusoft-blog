import type { Context } from "hono";
import type { Role } from "@blog/shared";
import { auth } from "./auth.js";

export interface SessionUser {
  id: string;
  name: string | null;
  image: string | null;
  role: Role;
}

export async function getSessionUser(c: Context): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;

  const rawRole = (session.user as { role?: string }).role;
  const role: Role = rawRole === "admin" || rawRole === "staff" ? rawRole : "user";

  return {
    id: session.user.id,
    name: session.user.name ?? null,
    image: session.user.image ?? null,
    role,
  };
}

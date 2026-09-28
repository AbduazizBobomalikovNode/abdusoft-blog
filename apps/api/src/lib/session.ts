import type { Context } from "hono";
import { auth } from "./auth.js";

export interface SessionUser {
  id: string;
  name: string | null;
  image: string | null;
  role: "admin" | "user";
}

export async function getSessionUser(c: Context): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;

  const role = (session.user as { role?: string }).role === "admin" ? "admin" : "user";

  return {
    id: session.user.id,
    name: session.user.name ?? null,
    image: session.user.image ?? null,
    role,
  };
}

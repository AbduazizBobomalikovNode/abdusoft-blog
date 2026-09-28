import { Hono } from "hono";
import { auth } from "../lib/auth.js";
import { acceptStaffInvite, findInviteByToken } from "../lib/staff-invites.js";

/**
 * Ochiq (auth talab qilmaydigan) va sessiya talab qiladigan xodim taklif
 * marshrutlari — `/taklif/[token]` sahifasi ishlatadi. `/admin/staff/*`dan
 * ALOHIDA: bu yerga hali "staff" bo'lmagan, hatto tizimga kirmagan
 * mehmon ham (token tekshiruvi uchun) kira oladi.
 */
export const staffInvitesRoute = new Hono()
  .get("/:token", async (c) => {
    const lookup = await findInviteByToken(c.req.param("token"));
    if (!lookup) return c.json({ status: "not_found", note: null });
    return c.json({ status: lookup.status, note: lookup.row.note });
  })
  .post("/:token/accept", async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "Tizimga kirish talab qilinadi" }, 401);

    const result = await acceptStaffInvite(c.req.param("token"), session.user.id);
    if (!result.ok) {
      const messages: Record<string, string> = {
        not_found: "Taklif topilmadi",
        expired: "Taklif muddati tugagan",
        used: "Taklif allaqachon ishlatilgan",
        revoked: "Taklif bekor qilingan",
      };
      return c.json({ error: messages[result.reason] ?? "Taklifni qabul qilib bo'lmadi" }, 409);
    }

    return c.json({ ok: true, role: result.role });
  });

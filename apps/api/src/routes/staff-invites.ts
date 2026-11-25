import { Hono } from "hono";
import { auth } from "../lib/auth.js";
import { recordAuditSafe } from "../lib/audit.js";
import { actorFromAdminUser } from "../lib/posts/types.js";
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

    const token = c.req.param("token");
    const lookup = await findInviteByToken(token);
    const result = await acceptStaffInvite(token, session.user.id);
    if (!result.ok) {
      const messages: Record<string, string> = {
        not_found: "Taklif topilmadi",
        expired: "Taklif muddati tugagan",
        used: "Taklif allaqachon ishlatilgan",
        revoked: "Taklif bekor qilingan",
      };
      return c.json({ error: messages[result.reason] ?? "Taklifni qabul qilib bo'lmadi" }, 409);
    }

    // Faqat taklif id'si va rol — token jurnalga tushmaydi.
    await recordAuditSafe(actorFromAdminUser({ id: session.user.id, role: result.role }), {
      action: "staff.invite_accept",
      entityType: "staff_invite",
      entityId: lookup?.row.id ?? null,
      summary: `Xodim taklifi qabul qilindi (rol: ${result.role})`,
      meta: { userId: session.user.id, role: result.role },
    });

    return c.json({ ok: true, role: result.role });
  });

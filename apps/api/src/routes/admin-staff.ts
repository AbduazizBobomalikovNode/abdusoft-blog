import { Hono } from "hono";
import { CreateStaffInviteBodySchema } from "@blog/shared";
import { config } from "../config.js";
import { requireRole } from "../lib/require-admin.js";
import {
  createStaffInvite,
  listStaffInvites,
  listStaffMembers,
  removeStaffMember,
  revokeStaffInvite,
  toStaffInviteDto,
} from "../lib/staff-invites.js";

/** `/admin/xodimlar` sahifasi ishlatadigan API — faqat admin. */
export const adminStaffRoute = new Hono()
  .use("*", requireRole("admin"))
  .get("/", async (c) => {
    const [staff, invites] = await Promise.all([listStaffMembers(), listStaffInvites()]);
    return c.json({ staff, invites });
  })
  .post("/invites", async (c) => {
    const adminUser = c.get("adminUser");
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateStaffInviteBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);

    const { invite, token } = await createStaffInvite(adminUser.id, parsed.data.note?.trim() || null);

    return c.json(
      {
        invite: toStaffInviteDto(invite),
        token,
        url: `${config.WEB_ORIGIN}/taklif/${token}`,
      },
      201,
    );
  })
  .post("/invites/:id/revoke", async (c) => {
    const ok = await revokeStaffInvite(c.req.param("id"));
    if (!ok) return c.json({ error: "Taklif topilmadi yoki allaqachon ishlatilgan/bekor qilingan" }, 409);
    return c.json({ ok: true });
  })
  .delete("/:userId", async (c) => {
    const ok = await removeStaffMember(c.req.param("userId"));
    if (!ok) return c.json({ error: "Xodim topilmadi" }, 404);
    return c.json({ ok: true });
  });

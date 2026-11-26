import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { CreateStaffInviteBodySchema } from "@blog/shared";
import { db } from "../db/index.js";
import { user } from "../db/auth-schema.js";
import { createStaffPasswordResetLink } from "../lib/password-reset-link.js";
import { requireRole } from "../lib/require-admin.js";
import { recordAuditSafe } from "../lib/audit.js";
import { actorFromAdminUser } from "../lib/posts/types.js";
import { createStaffInviteAudited, getStaffOverview, removeStaffMemberAudited, revokeStaffInviteAudited } from "../lib/staff-admin.js";

/** `/admin/xodimlar` sahifasi ishlatadigan API — faqat admin. */
export const adminStaffRoute = new Hono()
  .use("*", requireRole("admin"))
  .get("/", async (c) => c.json(await getStaffOverview()))
  .post("/invites", async (c) => {
    const adminUser = c.get("adminUser");
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateStaffInviteBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);
    return c.json(await createStaffInviteAudited(actorFromAdminUser(adminUser), adminUser.id, parsed.data.note?.trim() || null), 201);
  })
  .post("/invites/:id/revoke", async (c) => {
    const result = await revokeStaffInviteAudited(actorFromAdminUser(c.get("adminUser")), c.req.param("id"));
    if (!result.ok) return c.json({ error: result.error.message }, 409);
    return c.json({ ok: true });
  })
  // Xodim parolni unutganda: admin bir martalik "yangi parol o'rnatish" havolasini yaratadi va o'zi yetkazadi.
  // Faqat xodim (staff) uchun — boshqa admin yoki o'zi uchun emas. Token/havola jurnalga yozilmaydi.
  .post("/:userId/password-reset-link", async (c) => {
    const adminUser = c.get("adminUser");
    const targetId = c.req.param("userId");
    if (targetId === adminUser.id) {
      return c.json({ error: "O'zingiz uchun havola yaratib bo'lmaydi — parolni akkaunt sahifasidan almashtiring" }, 403);
    }

    const [target] = await db.select({ id: user.id, email: user.email, role: user.role }).from(user).where(eq(user.id, targetId)).limit(1);
    if (target?.role === "admin") return c.json({ error: "Admin hisobi uchun havola yaratib bo'lmaydi" }, 403);
    if (!target || target.role !== "staff") return c.json({ error: "Xodim topilmadi" }, 404);

    const { url, expiresAt } = await createStaffPasswordResetLink(target);
    await recordAuditSafe(actorFromAdminUser(adminUser), {
      action: "staff.password_link_create",
      entityType: "user",
      entityId: target.id,
      summary: "Xodim uchun yangi parol o'rnatish havolasi yaratildi",
      meta: { expiresAt: expiresAt.toISOString() },
    });

    c.header("Cache-Control", "no-store");
    return c.json({ url, expiresAt: expiresAt.toISOString() }, 201);
  })
  .delete("/:userId", async (c) => {
    const result = await removeStaffMemberAudited(actorFromAdminUser(c.get("adminUser")), c.req.param("userId"));
    if (!result.ok) return c.json({ error: result.error.message }, 404);
    return c.json({ ok: true });
  });

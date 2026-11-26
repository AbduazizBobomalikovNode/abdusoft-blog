import { config } from "../config.js";
import { recordAuditSafe } from "./audit.js";
import { fail, ok, type Actor, type ServiceResult } from "./posts/types.js";
import { createStaffInvite, listStaffInvites, listStaffMembers, removeStaffMember, revokeStaffInvite, toStaffInviteDto } from "./staff-invites.js";

/** Xodimlar va takliflar ro'yxati (`GET /admin/staff` va MCP `list_staff`). */
export async function getStaffOverview() {
  const [staff, invites] = await Promise.all([listStaffMembers(), listStaffInvites()]);
  return { staff, invites };
}

/** Taklif yaratadi + jurnal. Token va havola jurnalga HECH QACHON yozilmaydi — faqat taklif id'si. */
export async function createStaffInviteAudited(actor: Actor, adminUserId: string, note: string | null) {
  const { invite, token } = await createStaffInvite(adminUserId, note);
  await recordAuditSafe(actor, {
    action: "staff.invite_create",
    entityType: "staff_invite",
    entityId: invite.id,
    summary: "Xodim taklifi yaratildi",
    meta: { expiresAt: invite.expiresAt.toISOString(), hasNote: Boolean(note) },
  });
  return { invite: toStaffInviteDto(invite), token, url: `${config.WEB_ORIGIN}/taklif/${token}` };
}

export async function revokeStaffInviteAudited(actor: Actor, inviteId: string): Promise<ServiceResult<null>> {
  const done = await revokeStaffInvite(inviteId);
  if (!done) return fail("conflict", "Taklif topilmadi yoki allaqachon ishlatilgan/bekor qilingan");
  await recordAuditSafe(actor, { action: "staff.invite_revoke", entityType: "staff_invite", entityId: inviteId, summary: "Xodim taklifi bekor qilindi" });
  return ok(null);
}

export async function removeStaffMemberAudited(actor: Actor, userId: string): Promise<ServiceResult<null>> {
  const done = await removeStaffMember(userId);
  if (!done) return fail("not_found", "Xodim topilmadi");
  await recordAuditSafe(actor, { action: "staff.remove", entityType: "user", entityId: userId, summary: "Xodim roli olib tashlandi", meta: { from: "staff", to: "user" } });
  return ok(null);
}

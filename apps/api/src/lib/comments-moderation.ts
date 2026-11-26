import {
  banCommentAuthor,
  deleteCommentCascade,
  isBanAvailable,
  loadCommentRow,
  replyToCommentAsAdmin,
  setCommentStatus,
  type AdminReplyAuthor,
} from "./comments-admin.js";
import { recordAuditSafe } from "./audit.js";
import { fail, ok, type Actor, type ServiceResult } from "./posts/types.js";

/**
 * Izoh moderatsiyasi (HTTP admin marshrutlari va MCP vositalari uchun YAGONA yo'l): amal + jurnal yozuvi.
 * Telegram xatolari (`TelegramReplyError`) o'zgarishsiz yuqoriga uzatiladi — chaqiruvchi o'z formatida javob beradi.
 */
export async function moderateComment(
  actor: Actor,
  id: string,
  status: "visible" | "hidden" | "deleted",
  extraMeta: Record<string, unknown> = {},
): Promise<ServiceResult<{ postId: string; previousStatus: string }>> {
  const before = await loadCommentRow(id);
  const updated = await setCommentStatus(id, status);
  if (!updated) return fail("not_found", "Topilmadi");
  await recordAuditSafe(actor, {
    action: "comment.status",
    entityType: "comment",
    entityId: id,
    summary: `Izoh holati o'zgardi: ${status}`,
    meta: { status, postId: updated.postId, ...extraMeta },
  });
  return ok({ postId: updated.postId, previousStatus: before?.status ?? "unknown" });
}

export async function deleteComment(actor: Actor, id: string): Promise<ServiceResult<{ postId: string }>> {
  const deleted = await deleteCommentCascade(id);
  if (!deleted) return fail("not_found", "Topilmadi");
  await recordAuditSafe(actor, {
    action: "comment.delete",
    entityType: "comment",
    entityId: deleted.id,
    summary: "Izoh o'chirildi",
    meta: { postId: deleted.postId },
  });
  return ok({ postId: deleted.postId });
}

export async function banCommenter(actor: Actor, id: string, reason?: string): Promise<ServiceResult<null>> {
  const target = await loadCommentRow(id);
  if (!target) return fail("not_found", "Topilmadi");
  if (!isBanAvailable(target)) {
    return fail("conflict", "Bu izoh muallifini bloklab bo'lmaydi (Telegram foydalanuvchi id'si yo'q)");
  }
  const banned = await banCommentAuthor(id, reason);
  if (!banned) return fail("not_found", "Topilmadi");
  await recordAuditSafe(actor, {
    action: "comment.ban",
    entityType: "comment",
    entityId: id,
    summary: "Izoh muallifi bloklandi",
    meta: { hasReason: Boolean(reason) },
  });
  return ok(null);
}

export async function replyToComment(
  actor: Actor,
  parentId: string,
  body: string,
  author: AdminReplyAuthor,
): Promise<ServiceResult<{ id: string; postId: string }>> {
  const created = await replyToCommentAsAdmin(parentId, body, author);
  if (!created) return fail("not_found", "Topilmadi");
  await recordAuditSafe(actor, {
    action: "comment.reply",
    entityType: "comment",
    entityId: created.id,
    summary: "Izohga admin javob yozdi",
    meta: { parentId },
  });
  return ok({ id: created.id, postId: created.postId });
}

/**
 * Admin javobini Telegram guruhiga qayta yuborish (`POST /admin/comments/:id/send-to-telegram` va MCP `resend_reply_to_telegram`):
 * amal + jurnal. `null` — topilmadi; `TelegramReplyError` o'zgarishsiz uzatiladi.
 */
export async function sendReplyToTelegram(actor: Actor, id: string): Promise<{ id: string; postId: string } | null> {
  const { sendAdminReplyToTelegram } = await import("./comments-admin.js");
  const sent = await sendAdminReplyToTelegram(id);
  if (!sent) return null;
  await recordAuditSafe(actor, { action: "comment.send_to_telegram", entityType: "comment", entityId: sent.id, summary: "Admin javobi Telegramga yuborildi" });
  return sent;
}

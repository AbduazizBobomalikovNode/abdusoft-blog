import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import {
  AdminCommentBanBodySchema,
  AdminCommentBulkBodySchema,
  AdminCommentReplyBodySchema,
  AdminCommentUpdateBodySchema,
} from "@blog/shared";
import { db } from "../db/index.js";
import { bannedDevices } from "../db/schema.js";
import { AdminCommentListQuerySchema, listAdminComments } from "../lib/admin-reads/comments.js";
import { sendAdminReplyToTelegram, setCommentStatus, TelegramReplyError } from "../lib/comments-admin.js";
import { banCommenter, deleteComment, moderateComment, replyToComment } from "../lib/comments-moderation.js";
import { errorResponse } from "./service-response.js";
import { requireAdmin } from "../lib/require-admin.js";
import { recordAuditSafe } from "../lib/audit.js";
import { actorFromAdminUser } from "../lib/posts/types.js";

export const adminCommentsRoute = new Hono()
  .use("*", requireAdmin)
  .get("/", async (c) => {
    const parsed = AdminCommentListQuerySchema.safeParse({
      status: c.req.query("status") ?? undefined,
      source: c.req.query("source") ?? undefined,
      postId: c.req.query("postId"),
      q: c.req.query("q"),
      from: c.req.query("from"),
      to: c.req.query("to"),
      page: c.req.query("page"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov parametrlari" }, 400);

    const { from, to } = parsed.data;
    if (from && to && from > to) {
      return c.json({ error: "'from' sanasi 'to' sanasidan keyin bo'lishi mumkin emas" }, 400);
    }

    return c.json(await listAdminComments(parsed.data));
  })
  .patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const parsed = AdminCommentUpdateBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);

    const result = await moderateComment(actorFromAdminUser(c.get("adminUser")), id, parsed.data.status);
    if (!result.ok) return errorResponse(c, result.error);

    return c.json({ ok: true });
  })
  .post("/bulk", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = AdminCommentBulkBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);

    // Har bir izoh yakka amal bilan bir xil yo'ldan o'tadi: Telegram manbali izoh
    // yashirilsa/o'chirilsa, guruhdagi xabar ham o'chiriladi va hisoblagichlar yangilanadi.
    const rows: { id: string }[] = [];
    for (const id of parsed.data.ids) {
      const updated = await setCommentStatus(id, parsed.data.status);
      if (updated) rows.push({ id: updated.id });
    }

    await recordAuditSafe(actorFromAdminUser(c.get("adminUser")), {
      action: "comment.bulk_status",
      entityType: "comment",
      summary: `Izohlar holati o'zgardi (${rows.length} ta): ${parsed.data.status}`,
      meta: { status: parsed.data.status, count: rows.length, ids: rows.map((row) => row.id) },
    });

    return c.json({ ok: true, updated: rows.length });
  })
  .post("/:id/reply", async (c) => {
    const id = c.req.param("id");
    const adminUser = c.get("adminUser");

    const body = await c.req.json().catch(() => null);
    const parsed = AdminCommentReplyBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);

    try {
      const created = await replyToComment(actorFromAdminUser(adminUser), id, parsed.data.body, {
        id: adminUser.id,
        name: adminUser.name ?? adminUser.email,
      });
      if (!created.ok) return errorResponse(c, created.error);

      return c.json({ id: created.data.id }, 201);
    } catch (error) {
      if (error instanceof TelegramReplyError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  })
  .post("/:id/send-to-telegram", async (c) => {
    try {
      const sent = await sendAdminReplyToTelegram(c.req.param("id"));
      if (!sent) return c.json({ error: "Topilmadi" }, 404);
      await recordAuditSafe(actorFromAdminUser(c.get("adminUser")), {
        action: "comment.send_to_telegram",
        entityType: "comment",
        entityId: sent.id,
        summary: "Admin javobi Telegramga yuborildi",
      });
      return c.json({ ok: true, id: sent.id });
    } catch (error) {
      if (error instanceof TelegramReplyError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  })
  .delete("/:id", async (c) => {
    const deleted = await deleteComment(actorFromAdminUser(c.get("adminUser")), c.req.param("id"));
    if (!deleted.ok) return errorResponse(c, deleted.error);
    return c.json({ ok: true });
  })
  .post("/:id/ban", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const parsed = AdminCommentBanBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);

    const banned = await banCommenter(actorFromAdminUser(c.get("adminUser")), id, parsed.data.reason);
    if (!banned.ok) return errorResponse(c, banned.error);

    return c.json({ ok: true });
  });

export const adminBansRoute = new Hono()
  .use("*", requireAdmin)
  .get("/", async (c) => {
    const rows = await db.select().from(bannedDevices).orderBy(desc(bannedDevices.createdAt));
    return c.json({
      items: rows.map((row) => ({
        id: row.id,
        deviceHash: row.deviceHash,
        ipHash: row.ipHash,
        reason: row.reason,
        createdAt: row.createdAt.toISOString(),
      })),
    });
  })
  .delete("/:id", async (c) => {
    const banId = c.req.param("id");
    await db.delete(bannedDevices).where(eq(bannedDevices.id, banId));
    await recordAuditSafe(actorFromAdminUser(c.get("adminUser")), {
      action: "ban.remove",
      entityType: "ban",
      entityId: banId,
      summary: "Blok olib tashlandi",
    });
    return c.json({ ok: true });
  });

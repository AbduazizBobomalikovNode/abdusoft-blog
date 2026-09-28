import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import {
  DEFAULT_POST_SETTINGS,
  PostSettingsSchema,
  ReactionBodySchema,
  UpdateCommentBodySchema,
} from "@blog/shared";
import { db } from "../db/index.js";
import { comments, posts, reactions } from "../db/schema.js";
import { getDevice } from "../lib/device.js";
import { isBanned, recountPostComments } from "../lib/comments.js";
import { renderCommentBody } from "../lib/markdown.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { getSessionUser } from "../lib/session.js";

const EDIT_WINDOW_MS = 15 * 60 * 1000;
const REACTION_RATE_LIMIT = 60;
const REACTION_RATE_WINDOW_MS = 60 * 1000;
/** Ikkilamchi IP-asosli limit — device-limitni "yangi qurilma" yaratib chetlab o'tishning oldini oladi. */
const REACTION_IP_RATE_LIMIT = 120;

async function loadComment(id: string) {
  const [row] = await db.select().from(comments).where(eq(comments.id, id)).limit(1);
  return row ?? null;
}

export const commentItemRoute = new Hono()
  .patch("/:id", async (c) => {
    const comment = await loadComment(c.req.param("id"));
    if (!comment) return c.json({ error: "Topilmadi" }, 404);

    const sessionUser = await getSessionUser(c);
    const device = getDevice(c);
    const isAdmin = sessionUser?.role === "admin";
    const isOwner = comment.authorUserId
      ? sessionUser?.id === comment.authorUserId
      : comment.authorTokenHash === device.deviceHash;

    if (!isAdmin) {
      if (!isOwner) return c.json({ error: "Ruxsat yo'q" }, 403);
      const age = Date.now() - comment.createdAt.getTime();
      if (age > EDIT_WINDOW_MS) {
        return c.json({ error: "Tahrirlash vaqti tugagan (15 daqiqa)" }, 403);
      }
      if (await isBanned(device.deviceHash, device.ipHash)) {
        return c.json({ error: "Sizga fikr bildirish taqiqlangan" }, 403);
      }
    }

    const body = await c.req.json().catch(() => null);
    const parsed = UpdateCommentBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);

    const bodyHtml = renderCommentBody(parsed.data.body);
    const editedAt = new Date();

    await db
      .update(comments)
      .set({ body: parsed.data.body, bodyHtml, editedAt })
      .where(eq(comments.id, comment.id));

    return c.json({
      id: comment.id,
      body: parsed.data.body,
      bodyHtml,
      editedAt: editedAt.toISOString(),
    });
  })
  .delete("/:id", async (c) => {
    const comment = await loadComment(c.req.param("id"));
    if (!comment) return c.json({ error: "Topilmadi" }, 404);

    const sessionUser = await getSessionUser(c);
    const device = getDevice(c);
    const isAdmin = sessionUser?.role === "admin";
    const isOwner = comment.authorUserId
      ? sessionUser?.id === comment.authorUserId
      : comment.authorTokenHash === device.deviceHash;

    if (!isAdmin && !isOwner) return c.json({ error: "Ruxsat yo'q" }, 403);

    await db
      .update(comments)
      .set({ status: "deleted", deletedAt: new Date() })
      .where(eq(comments.id, comment.id));

    await recountPostComments(comment.postId);

    return c.json({ ok: true });
  })
  .post("/:id/reactions", async (c) => {
    const comment = await loadComment(c.req.param("id"));
    if (!comment) return c.json({ error: "Topilmadi" }, 404);

    const [post] = await db.select().from(posts).where(eq(posts.id, comment.postId)).limit(1);
    if (!post) return c.json({ error: "Topilmadi" }, 404);

    const settings = PostSettingsSchema.parse({
      ...DEFAULT_POST_SETTINGS,
      ...((post.settings as Record<string, unknown>) ?? {}),
    });
    if (!settings.reactionsEnabled) return c.json({ error: "Reaksiyalar o'chirilgan" }, 403);

    const body = await c.req.json().catch(() => null);
    const parsed = ReactionBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);

    if (parsed.data.type === "dislike" && !settings.showDislike) {
      return c.json({ error: "Dislike o'chirilgan" }, 400);
    }

    const device = getDevice(c);
    if (await isBanned(device.deviceHash, device.ipHash)) {
      return c.json({ error: "Ruxsat berilmagan" }, 403);
    }

    if (!checkRateLimit(`reaction:${device.deviceHash}`, REACTION_RATE_LIMIT, REACTION_RATE_WINDOW_MS)) {
      return c.json({ error: "Biroz kuting" }, 429);
    }
    if (!checkRateLimit(`reaction:ip:${device.ipHash}`, REACTION_IP_RATE_LIMIT, REACTION_RATE_WINDOW_MS)) {
      return c.json({ error: "Biroz kuting" }, 429);
    }

    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(reactions)
        .where(
          and(
            eq(reactions.targetType, "comment"),
            eq(reactions.targetId, comment.id),
            eq(reactions.deviceHash, device.deviceHash),
          ),
        )
        .limit(1);

      let likeDelta = 0;
      let dislikeDelta = 0;

      if (parsed.data.type === null) {
        if (existing) {
          await tx.delete(reactions).where(eq(reactions.id, existing.id));
          if (existing.type === "like") likeDelta -= 1;
          else dislikeDelta -= 1;
        }
      } else if (!existing) {
        await tx.insert(reactions).values({
          targetType: "comment",
          targetId: comment.id,
          deviceHash: device.deviceHash,
          type: parsed.data.type,
        });
        if (parsed.data.type === "like") likeDelta += 1;
        else dislikeDelta += 1;
      } else if (existing.type !== parsed.data.type) {
        await tx.update(reactions).set({ type: parsed.data.type }).where(eq(reactions.id, existing.id));
        if (existing.type === "like") likeDelta -= 1;
        else dislikeDelta -= 1;
        if (parsed.data.type === "like") likeDelta += 1;
        else dislikeDelta += 1;
      }

      if (likeDelta !== 0 || dislikeDelta !== 0) {
        await tx
          .update(comments)
          .set({
            likesCount: sql`${comments.likesCount} + ${likeDelta}`,
            dislikesCount: sql`${comments.dislikesCount} + ${dislikeDelta}`,
          })
          .where(eq(comments.id, comment.id));
      }

      const [fresh] = await tx
        .select({ likes: comments.likesCount, dislikes: comments.dislikesCount })
        .from(comments)
        .where(eq(comments.id, comment.id))
        .limit(1);

      return { likes: fresh?.likes ?? 0, dislikes: fresh?.dislikes ?? 0, mine: parsed.data.type };
    });

    return c.json(result);
  });

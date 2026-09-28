import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  CreateCommentBodySchema,
  DEFAULT_POST_SETTINGS,
  PostSettingsSchema,
  ReactionBodySchema,
  type CommentNode,
} from "@blog/shared";
import { db } from "../db/index.js";
import { comments, posts, reactions, telegramRefs } from "../db/schema.js";
import { clientIp, getDevice } from "../lib/device.js";
import {
  getCommentsForPost,
  isBanned,
  MAX_COMMENT_DEPTH,
  nextCommentPath,
  toCommentNodeForCreator,
} from "../lib/comments.js";
import { renderCommentBody } from "../lib/markdown.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { getSessionUser } from "../lib/session.js";
import { verifyTurnstile } from "../lib/turnstile.js";
import { events } from "../lib/events.js";
import { getSettings } from "../lib/settings.js";

const TELEGRAM_SEPARATE_LIMIT = 200;

/** `t.me/<username>/<id>?comment=<id>` — kanal postining muhokama guruhidagi izohlar bo'limini ochadigan rasmiy deep-link formati (https://core.telegram.org/api/links). Aniq izoh id'i shart emas — mavjud bo'lmasa ham mijoz umumiy muhokama oynasini ochadi. */
async function resolveTelegramThreadUrl(postId: string, channelId: string): Promise<string | null> {
  if (!channelId.startsWith("@")) return null;
  const [ref] = await db
    .select({ channelMessageId: telegramRefs.channelMessageId })
    .from(telegramRefs)
    .where(eq(telegramRefs.postId, postId))
    .limit(1);
  if (!ref?.channelMessageId) return null;
  return `https://t.me/${channelId.slice(1)}/${ref.channelMessageId}?comment=1`;
}

const COMMENT_RATE_LIMIT = 5;
const COMMENT_RATE_WINDOW_MS = 10 * 60 * 1000;
const REACTION_RATE_LIMIT = 60;
const REACTION_RATE_WINDOW_MS = 60 * 1000;
/** Ikkilamchi IP-asosli limit — device-limitni "yangi qurilma" yaratib chetlab o'tishning oldini oladi. */
const REACTION_IP_RATE_LIMIT = 120;

const ListQuerySchema = z.object({
  sort: z.union([z.literal("new"), z.literal("top")]).default("new"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(50).default(20),
});

async function loadPublishedPost(slug: string) {
  const [post] = await db
    .select()
    .from(posts)
    .where(and(eq(posts.slug, slug), eq(posts.status, "published")))
    .limit(1);
  return post ?? null;
}

function parseSettings(raw: unknown) {
  return PostSettingsSchema.parse({ ...DEFAULT_POST_SETTINGS, ...((raw as Record<string, unknown>) ?? {}) });
}

export const postCommentsRoute = new Hono()
  .get("/:slug/reactions/me", async (c) => {
    const post = await loadPublishedPost(c.req.param("slug"));
    if (!post) return c.json({ error: "Topilmadi" }, 404);

    const device = getDevice(c);
    const [existing] = await db
      .select({ type: reactions.type })
      .from(reactions)
      .where(
        and(
          eq(reactions.targetType, "post"),
          eq(reactions.targetId, post.id),
          eq(reactions.deviceHash, device.deviceHash),
        ),
      )
      .limit(1);

    return c.json({ mine: existing?.type ?? null });
  })
  .get("/:slug/comments", async (c) => {
    const post = await loadPublishedPost(c.req.param("slug"));
    if (!post) return c.json({ error: "Topilmadi" }, 404);

    const parsed = ListQuerySchema.safeParse({
      sort: c.req.query("sort") ?? undefined,
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov parametrlari" }, 400);

    const device = getDevice(c);
    const sessionUser = await getSessionUser(c);
    const integrationSettings = await getSettings();
    const displayMode = integrationSettings.telegram.telegramDisplay;

    const result = await getCommentsForPost({
      postId: post.id,
      sort: parsed.data.sort,
      cursor: parsed.data.cursor ?? null,
      limit: parsed.data.limit,
      deviceHash: device.deviceHash,
      sessionUserId: sessionUser?.id ?? null,
      source: displayMode === "mixed" ? "all" : "web",
    });

    if (displayMode !== "separate") {
      return c.json(result);
    }

    const tgResult = await getCommentsForPost({
      postId: post.id,
      sort: "new",
      cursor: null,
      limit: TELEGRAM_SEPARATE_LIMIT,
      deviceHash: device.deviceHash,
      sessionUserId: sessionUser?.id ?? null,
      source: "telegram",
    });

    const telegramThreadUrl = await resolveTelegramThreadUrl(post.id, integrationSettings.telegram.channelId);

    return c.json({
      ...result,
      telegram: tgResult.items,
      telegramTotal: tgResult.total,
      telegramThreadUrl,
    });
  })
  .post("/:slug/comments", async (c) => {
    const post = await loadPublishedPost(c.req.param("slug"));
    if (!post) return c.json({ error: "Topilmadi" }, 404);

    const settings = parseSettings(post.settings);
    if (!settings.commentsEnabled) {
      return c.json({ error: "Bu postda fikrlar yopilgan" }, 403);
    }

    const device = getDevice(c);
    if (await isBanned(device.deviceHash, device.ipHash)) {
      return c.json({ error: "Sizga fikr bildirish taqiqlangan" }, 403);
    }

    const sessionUser = await getSessionUser(c);
    if (!sessionUser && !settings.allowAnonymousComments) {
      return c.json({ error: "Fikr bildirish uchun tizimga kiring" }, 401);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = CreateCommentBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);
    const data = parsed.data;

    // Honeypot — botlar to'ldiradi, odam ko'rmaydi. Muvaffaqiyat taqlid qilinadi, yozuv qo'shilmaydi.
    // Javob shakli haqiqiy CreateCommentResponseSchema bilan bir xil bo'lishi kerak (klient
    // tomonda zod parse xatosiz o'tishi uchun) — shu sabab hech narsa saqlanmagan holda
    // haqiqatga yaqin, lekin DB'ga yozilmagan CommentNode qaytariladi.
    if (data.website && data.website.trim() !== "") {
      const now = new Date().toISOString();
      const fakeNode: CommentNode = {
        id: crypto.randomUUID(),
        parentId: data.parentId ?? null,
        depth: 0,
        authorName: (sessionUser?.name ?? data.authorName)?.trim() || "Anonim",
        authorImage: sessionUser?.image ?? null,
        authorIsAdmin: sessionUser?.role === "admin",
        authorVerified: Boolean(sessionUser),
        isMine: true,
        editableUntil: now,
        body: data.body,
        bodyHtml: renderCommentBody(data.body),
        pending: false,
        deleted: false,
        createdAt: now,
        editedAt: null,
        likes: 0,
        dislikes: 0,
        replies: [],
        source: "web",
        tgUsername: null,
      };
      return c.json({ comment: fakeNode }, 201);
    }

    if (!sessionUser && !data.authorName) {
      return c.json({ error: "Ism kiriting" }, 400);
    }

    const ip = clientIp(c);
    const turnstileOk = await verifyTurnstile(data.turnstileToken, ip);
    if (!turnstileOk) {
      return c.json({ error: "Robot tekshiruvidan o'tmadi" }, 400);
    }

    const deviceOk = checkRateLimit(`comment:d:${device.deviceHash}`, COMMENT_RATE_LIMIT, COMMENT_RATE_WINDOW_MS);
    const ipOk = checkRateLimit(`comment:i:${device.ipHash}`, COMMENT_RATE_LIMIT, COMMENT_RATE_WINDOW_MS);
    if (!deviceOk || !ipOk) {
      return c.json({ error: "Biroz kuting — juda ko'p fikr yubordingiz" }, 429);
    }

    let parent: { id: string; path: string; depth: number } | null = null;
    if (data.parentId) {
      const [parentRow] = await db
        .select({ id: comments.id, path: comments.path, depth: comments.depth, postId: comments.postId })
        .from(comments)
        .where(eq(comments.id, data.parentId))
        .limit(1);
      if (!parentRow || parentRow.postId !== post.id) {
        return c.json({ error: "Ota izoh topilmadi" }, 400);
      }
      parent = parentRow;
    }

    const { path, depth } = await nextCommentPath(post.id, parent);
    if (depth > MAX_COMMENT_DEPTH) {
      return c.json({ error: "Juda chuqur javob — bu yerda javob berib bo'lmaydi" }, 400);
    }

    const status = settings.commentsRequireApproval ? "pending" : "visible";
    const authorName = sessionUser ? (sessionUser.name ?? "Foydalanuvchi") : data.authorName!.trim();
    const bodyHtml = renderCommentBody(data.body);

    const [created] = await db
      .insert(comments)
      .values({
        postId: post.id,
        parentId: parent?.id ?? null,
        path,
        depth,
        authorName,
        authorTokenHash: device.deviceHash,
        authorUserId: sessionUser?.id ?? null,
        body: data.body,
        bodyHtml,
        status,
        ipHash: device.ipHash,
      })
      .returning();

    if (!created) return c.json({ error: "Izoh yaratib bo'lmadi" }, 500);

    if (status === "visible") {
      await db
        .update(posts)
        .set({ commentsCount: sql`${posts.commentsCount} + 1` })
        .where(eq(posts.id, post.id));
    }

    events.emit("comment.created", {
      post: { id: post.id, slug: post.slug, title: post.title },
      comment: {
        id: created.id,
        parentId: created.parentId,
        body: created.body,
        bodyHtml: created.bodyHtml,
        status: created.status as "visible" | "pending",
        createdAt: created.createdAt.toISOString(),
      },
      author: {
        name: authorName,
        userId: sessionUser?.id ?? null,
        isAdmin: sessionUser?.role === "admin",
      },
    });

    const node = toCommentNodeForCreator({
      id: created.id,
      postId: created.postId,
      parentId: created.parentId,
      path: created.path,
      depth: created.depth,
      authorName: created.authorName,
      authorTokenHash: created.authorTokenHash,
      authorUserId: created.authorUserId,
      body: created.body,
      bodyHtml: created.bodyHtml,
      status: created.status,
      likesCount: created.likesCount,
      dislikesCount: created.dislikesCount,
      createdAt: created.createdAt,
      editedAt: created.editedAt,
      userName: sessionUser?.name ?? null,
      userImage: sessionUser?.image ?? null,
      userRole: sessionUser?.role ?? null,
      source: created.source,
      tgUsername: created.tgUsername,
    });

    return c.json({ comment: node }, 201);
  })
  .post("/:slug/reactions", async (c) => {
    const post = await loadPublishedPost(c.req.param("slug"));
    if (!post) return c.json({ error: "Topilmadi" }, 404);

    const settings = parseSettings(post.settings);
    if (!settings.reactionsEnabled) {
      return c.json({ error: "Reaksiyalar o'chirilgan" }, 403);
    }

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
            eq(reactions.targetType, "post"),
            eq(reactions.targetId, post.id),
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
          targetType: "post",
          targetId: post.id,
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
          .update(posts)
          .set({
            likesCount: sql`${posts.likesCount} + ${likeDelta}`,
            dislikesCount: sql`${posts.dislikesCount} + ${dislikeDelta}`,
          })
          .where(eq(posts.id, post.id));
      }

      const [fresh] = await tx
        .select({ likes: posts.likesCount, dislikes: posts.dislikesCount })
        .from(posts)
        .where(eq(posts.id, post.id))
        .limit(1);

      return { likes: fresh?.likes ?? 0, dislikes: fresh?.dislikes ?? 0, mine: parsed.data.type };
    });

    return c.json(result);
  });

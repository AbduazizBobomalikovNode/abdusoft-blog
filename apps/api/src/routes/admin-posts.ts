import { Hono } from "hono";
import { and, asc, desc, eq, gt, ilike, inArray, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  CreatePostBodySchema,
  DEFAULT_POST_SETTINGS,
  PostSettingsSchema,
  RESERVED_SLUGS,
  SchedulePostBodySchema,
  UpdatePostBodySchema,
  slugify,
  type AdminPostStatus,
  type PostListItem,
  type Tag,
} from "@blog/shared";
import { nanoid } from "nanoid";
import { db } from "../db/index.js";
import { postTags, posts, tags } from "../db/schema.js";
import { postSelectColumns, tagsForPostIds } from "./posts.js";
import { requireAdmin } from "../lib/require-admin.js";
import { escapeLike } from "../lib/like.js";
import { renderPost } from "../lib/content/render.js";
import { events } from "../lib/events.js";
import { pathsForPost, revalidateWeb } from "../lib/revalidate.js";
import { getTelegramRefForPost, refreshTelegraphMirror, repostToChannel } from "../telegram/publish.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const SHORT_QUERY_LENGTH = 3;
const RELATED_LIMIT = 3;
const SLUG_ID_LENGTH = 6;

const STATUS_VALUES = ["all", "draft", "scheduled", "published", "archived"] as const;

const ListQuerySchema = z.object({
  status: z.enum(STATUS_VALUES).default("all"),
  q: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

const adminPostSelectColumns = {
  ...postSelectColumns,
  status: posts.status,
  scheduledAt: posts.scheduledAt,
  updatedAt: posts.updatedAt,
};

type AdminPostRow = {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  publishedAt: Date | null;
  readingTime: number | null;
  pinned: boolean;
  viewsCount: number;
  likesCount: number;
  dislikesCount: number;
  commentsCount: number;
  status: AdminPostStatus;
  scheduledAt: Date | null;
  updatedAt: Date;
};

function toAdminListItem(row: AdminPostRow, tagMap: Map<string, Tag[]>) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    pinned: row.pinned,
    tags: tagMap.get(row.id) ?? [],
    counts: {
      views: row.viewsCount,
      likes: row.likesCount,
      dislikes: row.dislikesCount,
      comments: row.commentsCount,
    },
  };
}

async function computeTotals(): Promise<Record<"all" | AdminPostStatus, number>> {
  const rows = await db
    .select({ status: posts.status, count: sql<number>`count(*)::int` })
    .from(posts)
    .groupBy(posts.status);

  const totals = { all: 0, draft: 0, scheduled: 0, published: 0, archived: 0 };
  for (const row of rows) {
    totals[row.status] = row.count;
    totals.all += row.count;
  }
  return totals;
}

async function generateDraftSlug(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `nomsiz-post-${nanoid(SLUG_ID_LENGTH).toLowerCase()}`;
    const [existing] = await db.select({ id: posts.id }).from(posts).where(eq(posts.slug, candidate)).limit(1);
    if (!existing) return candidate;
  }
  throw new Error("Unikal slug generatsiya qilib bo'lmadi");
}

interface SlugValidationError {
  error: string;
}

async function validateSlug(rawSlug: string, postId: string): Promise<string | SlugValidationError> {
  const clean = slugify(rawSlug);
  if (!clean) return { error: "Slug bo'sh bo'lishi mumkin emas" };
  if ((RESERVED_SLUGS as readonly string[]).includes(clean)) {
    return { error: `"${clean}" — band qilingan slug, boshqasini tanlang` };
  }

  const [existing] = await db
    .select({ id: posts.id })
    .from(posts)
    .where(eq(posts.slug, clean))
    .limit(1);

  if (existing && existing.id !== postId) {
    return { error: `"${clean}" slug allaqachon band` };
  }

  return clean;
}

async function resolveTagIds(tagSlugs: string[]): Promise<{ id: string; slug: string }[]> {
  if (tagSlugs.length === 0) return [];
  return db
    .select({ id: tags.id, slug: tags.slug })
    .from(tags)
    .where(inArray(tags.slug, tagSlugs));
}

async function loadPostOr404(id: string) {
  const [post] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
  return post ?? null;
}

function toLifecycleSummary(post: typeof posts.$inferSelect) {
  return {
    id: post.id,
    slug: post.slug,
    status: post.status,
    publishedAt: post.publishedAt?.toISOString() ?? null,
    scheduledAt: post.scheduledAt?.toISOString() ?? null,
    pinned: post.pinned,
    updatedAt: post.updatedAt.toISOString(),
  };
}

export const adminPostsRoute = new Hono()
  .use("*", requireAdmin)
  .get("/", async (c) => {
    const parsed = ListQuerySchema.safeParse({
      status: c.req.query("status") ?? undefined,
      q: c.req.query("q"),
      page: c.req.query("page"),
      limit: c.req.query("limit"),
    });

    if (!parsed.success) {
      return c.json({ error: "Noto'g'ri so'rov parametrlari" }, 400);
    }

    const { status, q, page, limit } = parsed.data;
    const offset = (page - 1) * limit;

    const conditions = [];
    if (status !== "all") {
      conditions.push(eq(posts.status, status));
    }

    if (q) {
      if (q.length < SHORT_QUERY_LENGTH) {
        const like = `%${escapeLike(q)}%`;
        conditions.push(or(ilike(posts.title, like), ilike(posts.contentText, like))!);
      } else {
        conditions.push(
          sql`to_tsvector('simple', coalesce(${posts.title}, '') || ' ' || coalesce(${posts.contentText}, '')) @@ websearch_to_tsquery('simple', ${q})`,
        );
      }
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, countRows, totals] = await Promise.all([
      db
        .select(adminPostSelectColumns)
        .from(posts)
        .where(whereClause)
        .orderBy(desc(posts.pinned), desc(posts.updatedAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(posts).where(whereClause),
      computeTotals(),
    ]);

    const total = countRows[0]?.count ?? 0;
    const tagMap = await tagsForPostIds(rows.map((row) => row.id));

    return c.json({
      items: rows.map((row) => toAdminListItem(row, tagMap)),
      page,
      limit,
      total,
      hasMore: page * limit < total,
      totals,
    });
  })
  .post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreatePostBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);
    }

    const title = parsed.data.title?.trim() || "Nomsiz post";
    const slug = await generateDraftSlug();
    // Bo'sh `content: []` — sxemaga (`block+`) mos kelmaydigan haqiqatan ham
    // bo'sh hujjat: Tiptap/ProseMirror uni bitta ham textblock tugunisiz
    // render qiladi, shu sabab Placeholder kengaytmasi hech narsaga
    // ilova qiladigan tugun topa olmaydi va bo'sh muharrir joy egallovchisiz
    // ko'rinadi. Bitta bo'sh paragraf — minimal to'g'ri hujjat.
    const emptyDoc = { type: "doc", content: [{ type: "paragraph" }] };
    const rendered = await renderPost(emptyDoc);

    const [created] = await db
      .insert(posts)
      .values({
        slug,
        title,
        contentJson: emptyDoc,
        contentHtml: rendered.html,
        contentText: rendered.text,
        toc: rendered.toc,
        readingTime: rendered.readingTime,
        status: "draft",
        settings: DEFAULT_POST_SETTINGS,
      })
      .returning();

    if (!created) {
      return c.json({ error: "Post yaratib bo'lmadi" }, 500);
    }

    return c.json({ id: created.id, slug: created.slug }, 201);
  })
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const post = await loadPostOr404(id);
    if (!post) return c.json({ error: "Topilmadi" }, 404);

    const [tagMap, telegramRef] = await Promise.all([tagsForPostIds([post.id]), getTelegramRefForPost(post.id)]);
    const settings = PostSettingsSchema.parse({
      ...DEFAULT_POST_SETTINGS,
      ...((post.settings as Record<string, unknown>) ?? {}),
    });

    return c.json({
      id: post.id,
      slug: post.slug,
      title: post.title,
      excerpt: post.excerpt,
      contentJson: post.contentJson,
      coverUrl: post.coverUrl,
      status: post.status,
      publishedAt: post.publishedAt?.toISOString() ?? null,
      scheduledAt: post.scheduledAt?.toISOString() ?? null,
      pinned: post.pinned,
      settings,
      tags: tagMap.get(post.id) ?? [],
      readingTime: post.readingTime,
      createdAt: post.createdAt.toISOString(),
      updatedAt: post.updatedAt.toISOString(),
      counts: {
        views: post.viewsCount,
        likes: post.likesCount,
        dislikes: post.dislikesCount,
        comments: post.commentsCount,
      },
      telegram: telegramRef
        ? {
            telegraphUrl: telegramRef.telegraphUrl,
            telegraphPath: telegramRef.telegraphPath,
            channelMessageId: telegramRef.channelMessageId,
          }
        : null,
    });
  })
  .post("/:id/telegram/telegraph", async (c) => {
    const id = c.req.param("id");
    const post = await loadPostOr404(id);
    if (!post) return c.json({ error: "Topilmadi" }, 404);
    if (post.status !== "published") {
      return c.json({ error: "Faqat chop etilgan post uchun Telegraph mirror yaratiladi" }, 409);
    }

    await refreshTelegraphMirror(id);
    const ref = await getTelegramRefForPost(id);
    return c.json({ telegraphUrl: ref?.telegraphUrl ?? null });
  })
  .post("/:id/telegram/repost", async (c) => {
    const id = c.req.param("id");
    const post = await loadPostOr404(id);
    if (!post) return c.json({ error: "Topilmadi" }, 404);
    if (post.status !== "published") {
      return c.json({ error: "Faqat chop etilgan post kanalga yuboriladi" }, 409);
    }

    await repostToChannel(id);
    const ref = await getTelegramRefForPost(id);
    return c.json({ channelMessageId: ref?.channelMessageId ?? null });
  })
  .get("/:id/preview", async (c) => {
    const id = c.req.param("id");
    const post = await loadPostOr404(id);
    if (!post) return c.json({ error: "Topilmadi" }, 404);

    const tagMap = await tagsForPostIds([post.id]);
    const currentTags = tagMap.get(post.id) ?? [];
    const settings = PostSettingsSchema.parse({
      ...DEFAULT_POST_SETTINGS,
      ...((post.settings as Record<string, unknown>) ?? {}),
    });

    let prev: { slug: string; title: string } | null = null;
    let next: { slug: string; title: string } | null = null;

    if (post.status === "published" && post.publishedAt) {
      const [prevRow] = await db
        .select({ slug: posts.slug, title: posts.title })
        .from(posts)
        .where(and(eq(posts.status, "published"), lt(posts.publishedAt, post.publishedAt)))
        .orderBy(desc(posts.publishedAt))
        .limit(1);
      prev = prevRow ?? null;

      const [nextRow] = await db
        .select({ slug: posts.slug, title: posts.title })
        .from(posts)
        .where(and(eq(posts.status, "published"), gt(posts.publishedAt, post.publishedAt)))
        .orderBy(asc(posts.publishedAt))
        .limit(1);
      next = nextRow ?? null;
    }

    let related: PostListItem[] = [];
    const currentTagIds = currentTags.map((t) => t.id);

    if (currentTagIds.length > 0) {
      const relatedRows = await db
        .select(postSelectColumns)
        .from(posts)
        .where(
          and(
            eq(posts.status, "published"),
            ne(posts.id, post.id),
            inArray(
              posts.id,
              db.select({ id: postTags.postId }).from(postTags).where(inArray(postTags.tagId, currentTagIds)),
            ),
          ),
        )
        .orderBy(desc(posts.publishedAt))
        .limit(RELATED_LIMIT);

      const relatedTagMap = await tagsForPostIds(relatedRows.map((row) => row.id));
      related = relatedRows.map((row) => ({
        slug: row.slug,
        title: row.title,
        excerpt: row.excerpt,
        publishedAt: row.publishedAt?.toISOString() ?? null,
        readingTime: row.readingTime,
        pinned: row.pinned,
        tags: relatedTagMap.get(row.id) ?? [],
        counts: {
          views: row.viewsCount,
          likes: row.likesCount,
          dislikes: row.dislikesCount,
          comments: row.commentsCount,
        },
      }));
    }

    return c.json({
      slug: post.slug,
      title: post.title,
      excerpt: post.excerpt,
      html: post.contentHtml,
      toc: post.toc,
      coverUrl: post.coverUrl,
      status: post.status,
      publishedAt: post.publishedAt?.toISOString() ?? null,
      readingTime: post.readingTime,
      pinned: post.pinned,
      tags: currentTags,
      settings,
      counts: {
        views: post.viewsCount,
        likes: post.likesCount,
        dislikes: post.dislikesCount,
        comments: post.commentsCount,
      },
      adjacent: { prev, next },
      related,
    });
  })
  .patch("/:id", async (c) => {
    const id = c.req.param("id");
    const post = await loadPostOr404(id);
    if (!post) return c.json({ error: "Topilmadi" }, 404);

    const body = await c.req.json().catch(() => null);
    const parsed = UpdatePostBodySchema.safeParse(body);
    if (!parsed.success) {
      // `issues` — debug uchun: qaysi maydon nega rad etilganini ko'rsatadi
      // (masalan avtosaqlash bo'sh `slug` yuborsa, `zod` xatosi shu yerda ko'rinadi).
      return c.json({ error: "Noto'g'ri so'rov tanasi", issues: parsed.error.issues }, 400);
    }

    const data = parsed.data;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle partial update payload, mixed column types
    const update: Record<string, any> = {};

    if (data.title !== undefined) update.title = data.title;

    if (data.slug !== undefined) {
      const result = await validateSlug(data.slug, id);
      if (typeof result !== "string") {
        return c.json(result, 400);
      }
      update.slug = result;
    }

    if (data.coverUrl !== undefined) update.coverUrl = data.coverUrl;
    if (data.pinned !== undefined) update.pinned = data.pinned;
    if (data.scheduledAt !== undefined) {
      update.scheduledAt = data.scheduledAt ? new Date(data.scheduledAt) : null;
    }

    if (data.settings !== undefined) {
      const mergedSettings = PostSettingsSchema.parse({
        ...DEFAULT_POST_SETTINGS,
        ...((post.settings as Record<string, unknown>) ?? {}),
        ...data.settings,
      });
      update.settings = mergedSettings;
    }

    let renderedExcerpt: string | null = null;

    if (data.contentJson !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tiptap JSONContent, avoids extra dep in API layer
      const rendered = await renderPost(data.contentJson as any);
      update.contentJson = data.contentJson;
      update.contentHtml = rendered.html;
      update.contentText = rendered.text;
      update.toc = rendered.toc;
      update.readingTime = rendered.readingTime;
      renderedExcerpt = rendered.excerpt;
    }

    if (data.excerpt !== undefined) {
      if (data.excerpt === null) {
        if (renderedExcerpt === null) {
          const rendered = await renderPost(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (update.contentJson ?? post.contentJson) as any,
          );
          renderedExcerpt = rendered.excerpt;
        }
        update.excerpt = renderedExcerpt;
      } else {
        update.excerpt = data.excerpt;
      }
    }

    let tagSlugsForRevalidate: string[] | null = null;

    if (Object.keys(update).length > 0) {
      update.updatedAt = new Date();
      await db.update(posts).set(update).where(eq(posts.id, id));
    }

    if (data.tagSlugs !== undefined) {
      const resolved = await resolveTagIds(data.tagSlugs);
      await db.delete(postTags).where(eq(postTags.postId, id));
      if (resolved.length > 0) {
        await db
          .insert(postTags)
          .values(resolved.map((tag) => ({ postId: id, tagId: tag.id })))
          .onConflictDoNothing();
      }
      tagSlugsForRevalidate = resolved.map((tag) => tag.slug);
      if (Object.keys(update).length === 0) {
        await db.update(posts).set({ updatedAt: new Date() }).where(eq(posts.id, id));
      }
    }

    const [fresh] = await db
      .select({ updatedAt: posts.updatedAt, slug: posts.slug, status: posts.status })
      .from(posts)
      .where(eq(posts.id, id))
      .limit(1);

    if (fresh?.status === "published") {
      events.emit("post.updated", { id, slug: fresh.slug });
      const tagSlugs = tagSlugsForRevalidate ?? (await tagsForPostIds([id])).get(id)?.map((t) => t.slug) ?? [];
      const paths = pathsForPost(fresh.slug, tagSlugs);
      if (update.slug && update.slug !== post.slug) {
        paths.push(`/${post.slug}`);
      }
      revalidateWeb(paths);
    }

    return c.json({ updatedAt: fresh?.updatedAt.toISOString() ?? new Date().toISOString() });
  })
  .post("/:id/publish", async (c) => {
    const id = c.req.param("id");
    const post = await loadPostOr404(id);
    if (!post) return c.json({ error: "Topilmadi" }, 404);

    const now = new Date();
    await db
      .update(posts)
      .set({ status: "published", publishedAt: post.publishedAt ?? now, updatedAt: now })
      .where(eq(posts.id, id));

    const [fresh] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
    if (!fresh) return c.json({ error: "Topilmadi" }, 404);

    events.emit("post.published", { id: fresh.id, slug: fresh.slug });
    const tagSlugs = (await tagsForPostIds([id])).get(id)?.map((t) => t.slug) ?? [];
    revalidateWeb(pathsForPost(fresh.slug, tagSlugs));

    return c.json(toLifecycleSummary(fresh));
  })
  .post("/:id/unpublish", async (c) => {
    const id = c.req.param("id");
    const post = await loadPostOr404(id);
    if (!post) return c.json({ error: "Topilmadi" }, 404);

    const wasPublished = post.status === "published";
    await db.update(posts).set({ status: "draft", updatedAt: new Date() }).where(eq(posts.id, id));

    const [fresh] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
    if (!fresh) return c.json({ error: "Topilmadi" }, 404);

    if (wasPublished) {
      events.emit("post.unpublished", { id: fresh.id, slug: fresh.slug });
      const tagSlugs = (await tagsForPostIds([id])).get(id)?.map((t) => t.slug) ?? [];
      revalidateWeb(pathsForPost(fresh.slug, tagSlugs));
    }

    return c.json(toLifecycleSummary(fresh));
  })
  .post("/:id/archive", async (c) => {
    const id = c.req.param("id");
    const post = await loadPostOr404(id);
    if (!post) return c.json({ error: "Topilmadi" }, 404);

    const wasPublished = post.status === "published";
    await db.update(posts).set({ status: "archived", updatedAt: new Date() }).where(eq(posts.id, id));

    const [fresh] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
    if (!fresh) return c.json({ error: "Topilmadi" }, 404);

    if (wasPublished) {
      events.emit("post.unpublished", { id: fresh.id, slug: fresh.slug });
      const tagSlugs = (await tagsForPostIds([id])).get(id)?.map((t) => t.slug) ?? [];
      revalidateWeb(pathsForPost(fresh.slug, tagSlugs));
    }

    return c.json(toLifecycleSummary(fresh));
  })
  .post("/:id/schedule", async (c) => {
    const id = c.req.param("id");
    const post = await loadPostOr404(id);
    if (!post) return c.json({ error: "Topilmadi" }, 404);

    const body = await c.req.json().catch(() => null);
    const parsed = SchedulePostBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "scheduledAt majburiy" }, 400);
    }

    const scheduledAt = new Date(parsed.data.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime())) {
      return c.json({ error: "Noto'g'ri sana" }, 400);
    }

    const wasPublished = post.status === "published";
    await db
      .update(posts)
      .set({ status: "scheduled", scheduledAt, updatedAt: new Date() })
      .where(eq(posts.id, id));

    const [fresh] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
    if (!fresh) return c.json({ error: "Topilmadi" }, 404);

    if (wasPublished) {
      events.emit("post.unpublished", { id: fresh.id, slug: fresh.slug });
      const tagSlugs = (await tagsForPostIds([id])).get(id)?.map((t) => t.slug) ?? [];
      revalidateWeb(pathsForPost(fresh.slug, tagSlugs));
    }

    return c.json(toLifecycleSummary(fresh));
  })
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    const post = await loadPostOr404(id);
    if (!post) return c.json({ error: "Topilmadi" }, 404);

    if (post.status !== "draft" && post.status !== "archived") {
      return c.json(
        { error: "Chop etilgan postni o'chirish uchun avval uni qoralamaga qaytaring yoki arxivlang" },
        409,
      );
    }

    await db.delete(posts).where(eq(posts.id, id));
    return c.json({ ok: true });
  });

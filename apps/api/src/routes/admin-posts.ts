import { Hono, type Context } from "hono";
import { and, asc, desc, eq, gt, ilike, inArray, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  ChannelPreviewRequestSchema,
  ChannelSendRequestSchema,
  CreatePostBodySchema,
  DEFAULT_POST_SETTINGS,
  PostSettingsSchema,
  RequestChangesBodySchema,
  RESERVED_SLUGS,
  SchedulePostBodySchema,
  STAFF_EDITABLE_POST_FIELDS,
  UpdatePostBodySchema,
  slugify,
  type AdminPostStatus,
  type PostAuthorRef,
  type PostListItem,
  type Tag,
} from "@blog/shared";
import { nanoid } from "nanoid";
import { db } from "../db/index.js";
import { user } from "../db/auth-schema.js";
import { postTags, posts, tags } from "../db/schema.js";
import { postSelectColumns, tagsForPostIds } from "./posts.js";
import { requireRole } from "../lib/require-admin.js";
import { escapeLike } from "../lib/like.js";
import { renderPost } from "../lib/content/render.js";
import { events } from "../lib/events.js";
import { approvePost, requestPostChanges, submitPostForReview } from "../lib/post-review.js";
import { pathsForPost, revalidateWeb } from "../lib/revalidate.js";
import {
  computeChannelPost,
  editChannelCaptionForPost,
  getChannelAlreadySent,
  sendPostToChannel,
} from "../telegram/channel-send.js";
import { getTelegramRefForPost, refreshTelegraphMirror } from "../telegram/publish.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const SHORT_QUERY_LENGTH = 3;
const RELATED_LIMIT = 3;
const SLUG_ID_LENGTH = 6;
const RECENT_MINE_LIMIT = 8;

/**
 * Hono'ning fluent (zanjirlangan) marshrut tur chiqarishini buzmaslik uchun
 * (middleware'ni `.post(path, middleware, handler)` ko'rinishida uchinchi
 * argument sifatida berish `c.req.param()` turini `string | undefined`ga
 * kengaytirib yuborardi) — admin-only tekshiruvi alohida middleware EMAS,
 * handler ICHIDA chaqiriladigan oddiy tekshiruv sifatida amalga oshiriladi.
 */
function forbidUnlessAdmin(c: Context): Response | null {
  const adminUser = c.get("adminUser");
  if (adminUser.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }
  return null;
}

const STATUS_VALUES = [
  "all",
  "draft",
  "in_review",
  "changes_requested",
  "scheduled",
  "published",
  "archived",
] as const;

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
  createdBy: posts.createdBy,
  reviewNote: posts.reviewNote,
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
  createdBy: string | null;
  reviewNote: string | null;
};

/** Ro'yxat sahifasidagi "Yozgan" ustuni uchun — bitta so'rovda barcha (sahifadagi) muallif nomlarini oldindan yuklaydi. */
async function authorNamesForIds(ids: (string | null)[]): Promise<Map<string, string | null>> {
  const uniqueIds = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (uniqueIds.length === 0) return new Map();
  const rows = await db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(inArray(user.id, uniqueIds));
  return new Map(rows.map((row) => [row.id, row.name || row.email]));
}

function toAuthorRef(id: string | null, authorMap: Map<string, string | null>): PostAuthorRef | null {
  if (!id) return null;
  return { id, name: authorMap.get(id) ?? null };
}

function toAdminListItem(row: AdminPostRow, tagMap: Map<string, Tag[]>, authorMap: Map<string, string | null>) {
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
    createdBy: toAuthorRef(row.createdBy, authorMap),
    reviewNote: row.reviewNote,
  };
}

async function computeTotals(ownerId?: string): Promise<Record<"all" | AdminPostStatus, number>> {
  const rows = await db
    .select({ status: posts.status, count: sql<number>`count(*)::int` })
    .from(posts)
    .where(ownerId ? eq(posts.createdBy, ownerId) : undefined)
    .groupBy(posts.status);

  const totals = {
    all: 0,
    draft: 0,
    in_review: 0,
    changes_requested: 0,
    scheduled: 0,
    published: 0,
    archived: 0,
  };
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
  .use("*", requireRole("admin", "staff"))
  .get("/mine/summary", async (c) => {
    const adminUser = c.get("adminUser");
    const [totals, recentRows] = await Promise.all([
      computeTotals(adminUser.id),
      db
        .select(adminPostSelectColumns)
        .from(posts)
        .where(eq(posts.createdBy, adminUser.id))
        .orderBy(desc(posts.updatedAt))
        .limit(RECENT_MINE_LIMIT),
    ]);

    const tagMap = await tagsForPostIds(recentRows.map((row) => row.id));
    const authorMap = await authorNamesForIds(recentRows.map((row) => row.createdBy));

    return c.json({
      counts: {
        draft: totals.draft,
        in_review: totals.in_review,
        changes_requested: totals.changes_requested,
        published: totals.published,
        archived: totals.archived,
      },
      recent: recentRows.map((row) => toAdminListItem(row, tagMap, authorMap)),
    });
  })
  .get("/", async (c) => {
    const adminUser = c.get("adminUser");
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
    // Xodim (staff) FAQAT o'z postlarini ko'radi — bu shart har doim, so'rov
    // parametrlaridan qat'i nazar, qo'shiladi (API — haqiqiy himoya qatlami).
    if (adminUser.role === "staff") {
      conditions.push(eq(posts.createdBy, adminUser.id));
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
      computeTotals(adminUser.role === "staff" ? adminUser.id : undefined),
    ]);

    const total = countRows[0]?.count ?? 0;
    const tagMap = await tagsForPostIds(rows.map((row) => row.id));
    const authorMap = await authorNamesForIds(rows.map((row) => row.createdBy));

    return c.json({
      items: rows.map((row) => toAdminListItem(row, tagMap, authorMap)),
      page,
      limit,
      total,
      hasMore: page * limit < total,
      totals,
    });
  })
  .post("/", async (c) => {
    const adminUser = c.get("adminUser");
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
        createdBy: adminUser.id,
        updatedBy: adminUser.id,
      })
      .returning();

    if (!created) {
      return c.json({ error: "Post yaratib bo'lmadi" }, 500);
    }

    return c.json({ id: created.id, slug: created.slug }, 201);
  })
  .get("/:id", async (c) => {
    const adminUser = c.get("adminUser");
    const id = c.req.param("id");
    const post = await loadPostOr404(id);
    if (!post) return c.json({ error: "Topilmadi" }, 404);
    if (adminUser.role === "staff" && post.createdBy !== adminUser.id) {
      return c.json({ error: "Faqat o'z postlaringizni ko'rishingiz mumkin" }, 403);
    }

    const [tagMap, telegramRef, authorMap] = await Promise.all([
      tagsForPostIds([post.id]),
      getTelegramRefForPost(post.id),
      authorNamesForIds([post.createdBy, post.updatedBy, post.reviewedBy]),
    ]);
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
      createdBy: toAuthorRef(post.createdBy, authorMap),
      updatedBy: toAuthorRef(post.updatedBy, authorMap),
      reviewNote: post.reviewNote,
      submittedAt: post.submittedAt?.toISOString() ?? null,
      reviewedBy: toAuthorRef(post.reviewedBy, authorMap),
      reviewedAt: post.reviewedAt?.toISOString() ?? null,
    });
  })
  .post("/:id/telegram/telegraph", async (c) => {
    const forbidden = forbidUnlessAdmin(c);
    if (forbidden) return forbidden;
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
  .post("/:id/channel/preview", async (c) => {
    const forbidden = forbidUnlessAdmin(c);
    if (forbidden) return forbidden;
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const parsed = ChannelPreviewRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "mode va variant majburiy (mode: media|text)" }, 400);

    const computed = await computeChannelPost(id, parsed.data.mode, parsed.data.variant);
    if (!computed.ok) {
      if (computed.reason === "not_found") return c.json({ error: "Topilmadi" }, 404);
      if (computed.reason === "not_published") {
        return c.json({ error: "Faqat chop etilgan post uchun kanal ko'rinishi tayyorlanadi" }, 409);
      }
      if (computed.reason === "invalid_combo") {
        return c.json({ error: "Bu uzunlik ushbu rejim uchun mos emas" }, 400);
      }
      // no_media
      return c.json({ error: "🖼 Rasmli rejim uchun postda kover yoki band ichida rasm bo'lishi kerak" }, 400);
    }

    const alreadySent = await getChannelAlreadySent(id);

    return c.json({
      mode: parsed.data.mode,
      variant: parsed.data.variant,
      captionHtml: computed.data.captionHtml,
      visibleLength: computed.data.visibleLength,
      limit: computed.data.limit,
      truncated: computed.data.truncated,
      media: computed.data.media,
      alreadySent,
    });
  })
  .post("/:id/channel/send", async (c) => {
    const forbidden = forbidUnlessAdmin(c);
    if (forbidden) return forbidden;
    const id = c.req.param("id");
    const post = await loadPostOr404(id);
    if (!post) return c.json({ error: "Topilmadi" }, 404);
    if (post.status !== "published") {
      return c.json({ error: "Faqat chop etilgan post kanalga yuboriladi" }, 409);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = ChannelSendRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "mode va variant majburiy (mode: media|text)" }, 400);

    const result = await sendPostToChannel(id, parsed.data.mode, parsed.data.variant, {
      replaceExisting: parsed.data.replaceExisting,
    });

    if (!result.ok) {
      if (result.reason === "not_found") return c.json({ error: "Topilmadi" }, 404);
      if (result.reason === "not_published") {
        return c.json({ error: "Faqat chop etilgan post kanalga yuboriladi" }, 409);
      }
      if (result.reason === "telegram_disabled") {
        return c.json({ error: "Telegram bot yoki kanal sozlanmagan" }, 409);
      }
      if (result.reason === "invalid_combo") {
        return c.json({ error: "Bu uzunlik ushbu rejim uchun mos emas" }, 400);
      }
      if (result.reason === "no_media") {
        return c.json({ error: "🖼 Rasmli rejim uchun postda kover yoki band ichida rasm bo'lishi kerak" }, 400);
      }
      // already_sent
      return c.json({ error: "Post allaqachon kanalga yuborilgan — replaceExisting bilan qayta yuboring" }, 409);
    }

    return c.json(result);
  })
  .post("/:id/channel/resync-caption", async (c) => {
    const forbidden = forbidUnlessAdmin(c);
    if (forbidden) return forbidden;
    const id = c.req.param("id");
    const post = await loadPostOr404(id);
    if (!post) return c.json({ error: "Topilmadi" }, 404);

    // Post hali kanalga yuborilmagan bo'lsa — jimgina hech narsa qilmaydi
    // (`editChannelCaptionForPost` ichida tekshiriladi), shu sabab bu yerda
    // 409 tashlamaymiz: tugma faqat "allaqachon yuborilgan" holatda ko'rinadi.
    await editChannelCaptionForPost(id);
    return c.json({ ok: true });
  })
  .get("/:id/preview", async (c) => {
    const adminUser = c.get("adminUser");
    const id = c.req.param("id");
    const post = await loadPostOr404(id);
    if (!post) return c.json({ error: "Topilmadi" }, 404);
    if (adminUser.role === "staff" && post.createdBy !== adminUser.id) {
      return c.json({ error: "Faqat o'z postlaringizni ko'rishingiz mumkin" }, 403);
    }

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
    const adminUser = c.get("adminUser");
    const id = c.req.param("id");
    const post = await loadPostOr404(id);
    if (!post) return c.json({ error: "Topilmadi" }, 404);

    if (adminUser.role === "staff") {
      if (post.createdBy !== adminUser.id) {
        return c.json({ error: "Faqat o'z postlaringizni tahrirlashingiz mumkin" }, 403);
      }
      if (post.status !== "draft" && post.status !== "changes_requested") {
        return c.json(
          { error: "Post ko'rib chiqishda yoki chop etilgan — hozir tahrirlab bo'lmaydi" },
          409,
        );
      }
    }

    const body = await c.req.json().catch(() => null);
    const parsed = UpdatePostBodySchema.safeParse(body);
    if (!parsed.success) {
      // `issues` — debug uchun: qaysi maydon nega rad etilganini ko'rsatadi
      // (masalan avtosaqlash bo'sh `slug` yuborsa, `zod` xatosi shu yerda ko'rinadi).
      return c.json({ error: "Noto'g'ri so'rov tanasi", issues: parsed.error.issues }, 400);
    }

    const data = parsed.data;

    if (adminUser.role === "staff") {
      const disallowedKeys = Object.keys(data).filter(
        (key) => !(STAFF_EDITABLE_POST_FIELDS as readonly string[]).includes(key),
      );
      if (disallowedKeys.length > 0) {
        return c.json(
          { error: `Xodim quyidagi maydonlarni o'zgartira olmaydi: ${disallowedKeys.join(", ")}` },
          403,
        );
      }
    }
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
      update.updatedBy = adminUser.id;
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
        await db.update(posts).set({ updatedAt: new Date(), updatedBy: adminUser.id }).where(eq(posts.id, id));
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
  .post("/:id/submit", async (c) => {
    const adminUser = c.get("adminUser");
    const id = c.req.param("id");
    const result = await submitPostForReview(id, adminUser.id);

    if (!result.ok) {
      if (result.reason === "not_found") return c.json({ error: "Topilmadi" }, 404);
      if (result.reason === "not_owner") {
        return c.json({ error: "Faqat o'z postlaringizni ko'rib chiqishga yubora olasiz" }, 403);
      }
      return c.json({ error: "Post allaqachon ko'rib chiqilmoqda yoki chop etilgan" }, 409);
    }

    return c.json({
      id: result.post.id,
      status: result.post.status,
      submittedAt: result.post.submittedAt?.toISOString() ?? null,
    });
  })
  .post("/:id/approve", async (c) => {
    const forbidden = forbidUnlessAdmin(c);
    if (forbidden) return forbidden;
    const adminUser = c.get("adminUser");
    const id = c.req.param("id");
    const result = await approvePost(id, adminUser.id);

    if (!result.ok) {
      if (result.reason === "not_found") return c.json({ error: "Topilmadi" }, 404);
      return c.json({ error: "Post ko'rib chiqishda emas" }, 409);
    }

    return c.json(toLifecycleSummary(result.post));
  })
  .post("/:id/request-changes", async (c) => {
    const forbidden = forbidUnlessAdmin(c);
    if (forbidden) return forbidden;
    const adminUser = c.get("adminUser");
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const parsed = RequestChangesBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Izoh (note) majburiy" }, 400);

    const result = await requestPostChanges(id, adminUser.id, parsed.data.note);
    if (!result.ok) {
      if (result.reason === "not_found") return c.json({ error: "Topilmadi" }, 404);
      return c.json({ error: "Post ko'rib chiqishda emas" }, 409);
    }

    return c.json(toLifecycleSummary(result.post));
  })
  .post("/:id/publish", async (c) => {
    const forbidden = forbidUnlessAdmin(c);
    if (forbidden) return forbidden;
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
    const forbidden = forbidUnlessAdmin(c);
    if (forbidden) return forbidden;
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
    const forbidden = forbidUnlessAdmin(c);
    if (forbidden) return forbidden;
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
    const forbidden = forbidUnlessAdmin(c);
    if (forbidden) return forbidden;
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
    const forbidden = forbidUnlessAdmin(c);
    if (forbidden) return forbidden;
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

import { desc, eq, and } from "drizzle-orm";
import { PostSettingsSchema, type PostRevision, type PostRevisionListItem } from "@blog/shared";
import { db } from "../../db/index.js";
import { postRevisions } from "../../db/schema.js";
import { authorNamesForIds, checkCanEdit, checkCanView, loadPost, toAuthorRef, type ConcurrencyOptions } from "./shared.js";
import { updatePost } from "./write.js";
import { fail, ok, type Actor, type ServiceResult } from "./types.js";

type RevisionRow = typeof postRevisions.$inferSelect;

function toListItem(row: RevisionRow, authors: Map<string, string | null>): PostRevisionListItem {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    createdBy: toAuthorRef(row.createdBy, authors),
    via: row.via,
    reason: row.reason,
    title: row.title,
    slug: row.slug,
    status: row.status,
  };
}

async function loadViewablePost(actor: Actor, postId: string): Promise<ServiceResult<null>> {
  const post = await loadPost(db, postId);
  if (!post) return fail("not_found", "Topilmadi");
  const denied = checkCanView(actor, post);
  if (denied) return denied;
  return ok(null);
}

/** `GET /admin/posts/:id/revisions` — kontentsiz, eng yangisi birinchi. Xodim FAQAT o'z postlarini ko'radi. */
export async function listRevisions(actor: Actor, postId: string): Promise<ServiceResult<{ items: PostRevisionListItem[] }>> {
  const access = await loadViewablePost(actor, postId);
  if (!access.ok) return access;

  const rows = await db.select().from(postRevisions).where(eq(postRevisions.postId, postId)).orderBy(desc(postRevisions.seq));
  const authors = await authorNamesForIds(rows.map((row) => row.createdBy));
  return ok({ items: rows.map((row) => toListItem(row, authors)) });
}

async function loadRevision(postId: string, revisionId: string): Promise<RevisionRow | null> {
  const [row] = await db
    .select()
    .from(postRevisions)
    .where(and(eq(postRevisions.id, revisionId), eq(postRevisions.postId, postId)))
    .limit(1);
  return row ?? null;
}

/** `GET /admin/posts/:id/revisions/:rid` — kontent bilan. */
export async function getRevision(actor: Actor, postId: string, revisionId: string): Promise<ServiceResult<PostRevision>> {
  const access = await loadViewablePost(actor, postId);
  if (!access.ok) return access;

  const row = await loadRevision(postId, revisionId);
  if (!row) return fail("not_found", "Revision topilmadi");
  const authors = await authorNamesForIds([row.createdBy]);
  const settings = PostSettingsSchema.partial().safeParse(row.settings);
  return ok({
    ...toListItem(row, authors),
    excerpt: row.excerpt,
    contentJson: row.contentJson,
    coverUrl: row.coverUrl,
    tagSlugs: row.tagSlugs,
    settings: settings.success ? settings.data : {},
  });
}

/**
 * `POST /admin/posts/:id/revisions/:rid/restore` — JORIY holatni suratga oladi, so'ng eski kontentni oddiy
 * `updatePost` yo'li orqali qo'llaydi (render, slug tekshiruvi, teglar, chop etilgan postda ISR/hodisalar bir xil).
 * Post holati (status) o'zgarmaydi. Xodim cheklovlari (o'z posti, draft/changes_requested, `settings`siz) amal qiladi.
 */
export async function restoreRevision(
  actor: Actor,
  postId: string,
  revisionId: string,
  opts: ConcurrencyOptions = {},
): Promise<ServiceResult<{ updatedAt: string }>> {
  const post = await loadPost(db, postId);
  if (!post) return fail("not_found", "Topilmadi");
  const denied = checkCanEdit(actor, post);
  if (denied) return denied;
  const row = await loadRevision(postId, revisionId);
  if (!row) return fail("not_found", "Revision topilmadi");

  const settings = PostSettingsSchema.partial().safeParse(row.settings);
  return updatePost(
    actor,
    postId,
    {
      expectedUpdatedAt: opts.expectedUpdatedAt,
      title: row.title,
      slug: row.slug,
      excerpt: row.excerpt,
      contentJson: row.contentJson,
      coverUrl: row.coverUrl,
      tagSlugs: row.tagSlugs,
      // `settings` xodim uchun tahrirlanmaydi (STAFF_EDITABLE_POST_FIELDS) — admin uchun tiklanadi.
      ...(actor.role !== "staff" && settings.success ? { settings: settings.data } : {}),
    },
    {
      forceSnapshot: true,
      revisionReason: "restore-revision",
      audit: { action: "post.restore_revision", summary: "Post eski versiyadan tiklandi", meta: { revisionId, revisionReason: row.reason } },
    },
  );
}

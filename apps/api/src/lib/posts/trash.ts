import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { TrashListQuery } from "@blog/shared";
import { db } from "../../db/index.js";
import { posts } from "../../db/schema.js";
import { tagsForPostIds } from "../../routes/posts.js";
import { recordAudit } from "../audit.js";
import { adminPostSelectColumns, toAdminListItem } from "./read.js";
import { snapshotPost } from "./revisions.js";
import {
  authorNamesForIds,
  postLabel,
  checkExpectedUpdatedAt,
  requireAdminActor,
  toAuthorRef,
  type ConcurrencyOptions,
  type Executor,
  toLifecycleSummary,
  type LifecycleSummary,
} from "./shared.js";
import { RESERVED_SLUGS } from "@blog/shared";
import { fail, ok, type Actor, type ServiceResult } from "./types.js";

/** Chiqindidagi postning ichki slug'i. `slugify` faqat `[a-z0-9-]` beradi, shu sabab "_" bilan boshlangan slug haqiqiy slug bilan to'qnashmaydi va tasodifan ham yaratib bo'lmaydi. */
export function trashSlugFor(id: string): string {
  return `_trash_${id}`;
}

/** Asl slug band bo'lsa — bo'sh variant (`slug-2`, `slug-3`, ...), oxirida tasodifiy qo'shimcha. */
async function findFreeSlug(executor: Executor, wanted: string): Promise<string> {
  const isFree = async (candidate: string) => {
    if ((RESERVED_SLUGS as readonly string[]).includes(candidate)) return false;
    const [row] = await executor.select({ id: posts.id }).from(posts).where(eq(posts.slug, candidate)).limit(1);
    return !row;
  };
  if (await isFree(wanted)) return wanted;
  for (let n = 2; n <= 50; n++) {
    if (await isFree(`${wanted}-${n}`)) return `${wanted}-${n}`;
  }
  return `${wanted}-${nanoid(6).toLowerCase()}`;
}

/**
 * `DELETE /admin/posts/:id` — endi chiqindi qutisiga ko'chiradi (hech narsa cascade bo'lmaydi). Shartlar eskicha:
 * faqat admin, faqat `draft`/`archived`. Slug BO'SHATILADI: qator `_trash_<id>` ichki slug'iga o'tadi, asl slug `original_slug`da saqlanadi
 * (yangi post shu slug'ni olishi mumkin — avvalgi qattiq o'chirishdagi kabi).
 */
export async function trashPost(actor: Actor, id: string, opts: ConcurrencyOptions = {}): Promise<ServiceResult<null>> {
  const denied = requireAdminActor(actor);
  if (denied) return denied;

  return db.transaction(async (tx): Promise<ServiceResult<null>> => {
    const [post] = await tx
      .select()
      .from(posts)
      .where(and(eq(posts.id, id), isNull(posts.deletedAt)))
      .for("update")
      .limit(1);
    if (!post) return fail("not_found", "Topilmadi");
    if (post.status !== "draft" && post.status !== "archived") {
      return fail("conflict", "Chop etilgan postni o'chirish uchun avval uni qoralamaga qaytaring yoki arxivlang");
    }
    const conflict = await checkExpectedUpdatedAt(tx, post, opts.expectedUpdatedAt);
    if (conflict) return conflict;

    await snapshotPost(tx, post, actor, "trash");
    const now = new Date();
    await tx
      .update(posts)
      .set({
        deletedAt: now,
        deletedBy: actor.userId,
        originalSlug: post.slug,
        slug: trashSlugFor(post.id),
        updatedAt: now,
        updatedBy: actor.userId,
        updatedVia: actor.via,
      })
      .where(eq(posts.id, id));
    await recordAudit(tx, actor, {
      action: "post.trash",
      entityType: "post",
      entityId: id,
      summary: `Post chiqindi qutisiga ko'chirildi: ${postLabel(post)}`,
      meta: { status: post.status, slug: post.slug },
    });
    return ok(null);
  });
}

/** `GET /admin/posts/trash` — chiqindi qutisi (admin), eng oxirgi o'chirilgani birinchi. */
export async function listTrash(actor: Actor, input: TrashListQuery) {
  const denied = requireAdminActor(actor);
  if (denied) return denied;

  const { page, limit } = input;
  const offset = (page - 1) * limit;
  const [rows, countRows] = await Promise.all([
    db
      .select({ ...adminPostSelectColumns, originalSlug: posts.originalSlug, deletedAt: posts.deletedAt, deletedBy: posts.deletedBy })
      .from(posts)
      .where(isNotNull(posts.deletedAt))
      .orderBy(desc(posts.deletedAt), desc(posts.id))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`count(*)::int` }).from(posts).where(isNotNull(posts.deletedAt)),
  ]);

  const tagMap = await tagsForPostIds(rows.map((row) => row.id));
  const authorMap = await authorNamesForIds(rows.flatMap((row) => [row.createdBy, row.deletedBy]));
  const total = countRows[0]?.count ?? 0;

  return ok({
    items: rows.map((row) => ({
      ...toAdminListItem(row, tagMap, authorMap),
      // Ichki `_trash_` slug emas, asl slug ko'rsatiladi.
      slug: row.originalSlug ?? row.slug,
      deletedAt: (row.deletedAt as Date).toISOString(),
      deletedBy: toAuthorRef(row.deletedBy, authorMap),
    })),
    page,
    limit,
    total,
    hasMore: page * limit < total,
  });
}

/** `POST /admin/posts/trash/:id/restore` — postni chiqindi qutisidan avvalgi holatida (status o'zgarmagan) qaytaradi. */
export type RestoreFromTrashResult = LifecycleSummary & {
  /** `true` — asl slug qaytarildi; `false` — u band bo'lgani uchun `slug` bo'sh variantga o'tdi. */
  slugRestored: boolean;
  /** Postning trashga tushgan paytdagi slug'i. */
  originalSlug: string;
};

export async function restoreFromTrash(
  actor: Actor,
  id: string,
  opts: ConcurrencyOptions = {},
): Promise<ServiceResult<RestoreFromTrashResult>> {
  const denied = requireAdminActor(actor);
  if (denied) return denied;

  return db.transaction(async (tx): Promise<ServiceResult<RestoreFromTrashResult>> => {
    const [post] = await tx
      .select()
      .from(posts)
      .where(and(eq(posts.id, id), isNotNull(posts.deletedAt)))
      .for("update")
      .limit(1);
    if (!post) return fail("not_found", "Topilmadi");
    const conflict = await checkExpectedUpdatedAt(tx, post, opts.expectedUpdatedAt);
    if (conflict) return conflict;

    const originalSlug = post.originalSlug ?? post.slug;
    const slug = await findFreeSlug(tx, originalSlug);
    const slugRestored = slug === originalSlug;

    const now = new Date();
    const [after] = await tx
      .update(posts)
      .set({ deletedAt: null, deletedBy: null, originalSlug: null, slug, updatedAt: now, updatedBy: actor.userId, updatedVia: actor.via })
      .where(eq(posts.id, id))
      .returning();
    if (!after) return fail("not_found", "Topilmadi");

    await recordAudit(tx, actor, {
      action: "post.restore_trash",
      entityType: "post",
      entityId: id,
      summary: `Post chiqindi qutisidan qaytarildi: ${postLabel(after)}${slugRestored ? "" : ` (slug band edi, yangi slug: ${slug})`}`,
      meta: { status: after.status, slug: after.slug, originalSlug, slugRestored },
    });
    return ok({ ...toLifecycleSummary(after), slugRestored, originalSlug });
  });
}

/**
 * `DELETE /admin/posts/trash/:id` — FAQAT chiqindi qutisidagi postni butunlay o'chiradi (eski qattiq o'chirish:
 * teglar, izohlar, Telegram havolalari, kanal versiyalari va revision'lar cascade bo'ladi). Jurnal yozuvi qoladi.
 */
export async function purgePost(actor: Actor, id: string, opts: ConcurrencyOptions = {}): Promise<ServiceResult<null>> {
  const denied = requireAdminActor(actor);
  if (denied) return denied;

  return db.transaction(async (tx): Promise<ServiceResult<null>> => {
    const [post] = await tx
      .select()
      .from(posts)
      .where(and(eq(posts.id, id), isNotNull(posts.deletedAt)))
      .for("update")
      .limit(1);
    if (!post) return fail("not_found", "Topilmadi");
    const conflict = await checkExpectedUpdatedAt(tx, post, opts.expectedUpdatedAt);
    if (conflict) return conflict;

    await tx.delete(posts).where(eq(posts.id, id));
    await recordAudit(tx, actor, {
      action: "post.purge",
      entityType: "post",
      entityId: id,
      summary: `Post butunlay o'chirildi: ${postLabel(post)}`,
      meta: { status: post.status, slug: post.originalSlug ?? post.slug },
    });
    return ok(null);
  });
}

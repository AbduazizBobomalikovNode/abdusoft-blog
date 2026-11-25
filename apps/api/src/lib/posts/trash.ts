import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
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
  toLifecycleSummary,
  type LifecycleSummary,
} from "./shared.js";
import { fail, ok, type Actor, type ServiceResult } from "./types.js";

/**
 * `DELETE /admin/posts/:id` — endi chiqindi qutisiga ko'chiradi (hech narsa cascade bo'lmaydi). Shartlar eskicha:
 * faqat admin, faqat `draft`/`archived`. Slug chiqindi qutisida ham band qoladi.
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
      .set({ deletedAt: now, deletedBy: actor.userId, updatedAt: now, updatedBy: actor.userId, updatedVia: actor.via })
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
      .select({ ...adminPostSelectColumns, deletedAt: posts.deletedAt, deletedBy: posts.deletedBy })
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
export async function restoreFromTrash(
  actor: Actor,
  id: string,
  opts: ConcurrencyOptions = {},
): Promise<ServiceResult<LifecycleSummary>> {
  const denied = requireAdminActor(actor);
  if (denied) return denied;

  return db.transaction(async (tx): Promise<ServiceResult<LifecycleSummary>> => {
    const [post] = await tx
      .select()
      .from(posts)
      .where(and(eq(posts.id, id), isNotNull(posts.deletedAt)))
      .for("update")
      .limit(1);
    if (!post) return fail("not_found", "Topilmadi");
    const conflict = await checkExpectedUpdatedAt(tx, post, opts.expectedUpdatedAt);
    if (conflict) return conflict;

    const now = new Date();
    const [after] = await tx
      .update(posts)
      .set({ deletedAt: null, deletedBy: null, updatedAt: now, updatedBy: actor.userId, updatedVia: actor.via })
      .where(eq(posts.id, id))
      .returning();
    if (!after) return fail("not_found", "Topilmadi");

    await recordAudit(tx, actor, {
      action: "post.restore_trash",
      entityType: "post",
      entityId: id,
      summary: `Post chiqindi qutisidan qaytarildi: ${postLabel(after)}`,
      meta: { status: after.status, slug: after.slug },
    });
    return ok(toLifecycleSummary(after));
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
      meta: { status: post.status, slug: post.slug },
    });
    return ok(null);
  });
}

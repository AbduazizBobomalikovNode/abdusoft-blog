import { and, eq, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  DEFAULT_POST_SETTINGS,
  RESERVED_SLUGS,
  STAFF_EDITABLE_POST_FIELDS,
  slugify,
  type UpdatePostBody,
} from "@blog/shared";
import { db } from "../../db/index.js";
import { postTags, posts, tags } from "../../db/schema.js";
import { renderPost } from "../content/render.js";
import { recordAudit, recordAuditCoalesced } from "../audit.js";
import { announceUpdated } from "./effects.js";
import { preparePlan } from "./plan.js";
import { shouldSnapshotForUpdate, snapshotPost, type RevisionReason } from "./revisions.js";
import { checkCanEdit, loadPost, postLabel, resolveSettings, type PostRow } from "./shared.js";
import { fail, ok, type Actor, type ServiceResult } from "./types.js";

const SLUG_ID_LENGTH = 6;
/** Avtosaqlash PATCH'lari jurnalda bitta yozuvga birlashtiriladigan oyna (aktyor + kanal bir xil bo'lsa). */
const AUDIT_COALESCE_MS = 10 * 60_000;

async function generateDraftSlug(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `nomsiz-post-${nanoid(SLUG_ID_LENGTH).toLowerCase()}`;
    const [existing] = await db.select({ id: posts.id }).from(posts).where(eq(posts.slug, candidate)).limit(1);
    if (!existing) return candidate;
  }
  throw new Error("Unikal slug generatsiya qilib bo'lmadi");
}

/** Slug tozalanadi, band qilingan/bo'sh/boshqa postga tegishli bo'lsa xato qaytaradi (slug unikal — o'chirilganlar uchun ham band). */
async function validateSlug(rawSlug: string, postId: string): Promise<ServiceResult<string>> {
  const clean = slugify(rawSlug);
  if (!clean) return fail("bad_request", "Slug bo'sh bo'lishi mumkin emas");
  if ((RESERVED_SLUGS as readonly string[]).includes(clean)) {
    return fail("bad_request", `"${clean}" — band qilingan slug, boshqasini tanlang`);
  }

  const [existing] = await db.select({ id: posts.id }).from(posts).where(eq(posts.slug, clean)).limit(1);

  if (existing && existing.id !== postId) {
    return fail("bad_request", `"${clean}" slug allaqachon band`);
  }

  return ok(clean);
}

async function resolveTagIds(tagSlugs: string[]): Promise<{ id: string; slug: string }[]> {
  if (tagSlugs.length === 0) return [];
  return db.select({ id: tags.id, slug: tags.slug }).from(tags).where(inArray(tags.slug, tagSlugs));
}

/** `POST /admin/posts` — bo'sh qoralama yaratadi. */
export async function createPost(
  actor: Actor,
  input: { title?: string },
): Promise<ServiceResult<{ id: string; slug: string }>> {
  const title = input.title?.trim() || "Nomsiz post";
  const slug = await generateDraftSlug();
  // Bo'sh `content: []` — sxemaga (`block+`) mos kelmaydigan haqiqatan ham
  // bo'sh hujjat: Tiptap/ProseMirror uni bitta ham textblock tugunisiz
  // render qiladi, shu sabab Placeholder kengaytmasi hech narsaga
  // ilova qiladigan tugun topa olmaydi va bo'sh muharrir joy egallovchisiz
  // ko'rinadi. Bitta bo'sh paragraf — minimal to'g'ri hujjat.
  const emptyDoc = { type: "doc", content: [{ type: "paragraph" }] };
  const rendered = await renderPost(emptyDoc);

  const created = await db.transaction(async (tx) => {
    const [row] = await tx
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
        createdBy: actor.userId,
        updatedBy: actor.userId,
        updatedVia: actor.via,
      })
      .returning();
    if (row) {
      await recordAudit(tx, actor, {
        action: "post.create",
        entityType: "post",
        entityId: row.id,
        summary: `Post yaratildi: ${postLabel(row)}`,
        meta: { slug: row.slug },
      });
    }
    return row;
  });

  if (!created) return fail("bad_request", "Post yaratib bo'lmadi");
  return ok({ id: created.id, slug: created.slug });
}

/**
 * Tahrirlash huquqini tekshiradi (404 -> xodim: egasi 403 -> holat 409). Route tana (body) xatosini
 * qaytarishdan OLDIN shuni chaqiradi — shunda eski tartib (404/403/409 > 400) saqlanadi.
 */
export async function authorizeEdit(actor: Actor, id: string): Promise<ServiceResult<PostRow>> {
  const post = await loadPost(db, id);
  if (!post) return fail("not_found", "Topilmadi");
  const denied = checkCanEdit(actor, post);
  if (denied) return denied;
  return ok(post);
}

export type UpdatePostFields = UpdatePostBody;

/** Ichki parametrlar (revision tiklash kabi xizmat ichidagi chaqiruvlar uchun) — HTTP tanasidan KELMAYDI. */
export interface UpdateInternalOptions {
  /** Oraliq/aktyor qoidasidan qat'i nazar, yozishdan oldin surat olish. */
  forceSnapshot?: boolean;
  revisionReason?: RevisionReason;
  /** Berilsa, `post.update` o'rniga shu jurnal yozuvi (birlashtirilmasdan) yoziladi. */
  audit?: { action: string; summary: string; meta?: Record<string, unknown> };
}

/** `PATCH /admin/posts/:id` — qisman yangilash. Xodim cheklovlari shu yerda majburlanadi. */
export async function updatePost(
  actor: Actor,
  id: string,
  data: UpdatePostFields,
  internal: UpdateInternalOptions = {},
): Promise<ServiceResult<{ updatedAt: string }>> {
  const authorized = await authorizeEdit(actor, id);
  if (!authorized.ok) return authorized;
  const post = authorized.data;

  if (actor.role === "staff") {
    const disallowedKeys = Object.keys(data).filter(
      (key) => !(STAFF_EDITABLE_POST_FIELDS as readonly string[]).includes(key),
    );
    if (disallowedKeys.length > 0) {
      return fail("forbidden", `Xodim quyidagi maydonlarni o'zgartira olmaydi: ${disallowedKeys.join(", ")}`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle partial update payload, mixed column types
  const update: Record<string, any> = {};

  if (data.title !== undefined) update.title = data.title;

  if (data.slug !== undefined) {
    const result = await validateSlug(data.slug, id);
    if (!result.ok) return result;
    update.slug = result.data;
  }

  if (data.coverUrl !== undefined) update.coverUrl = data.coverUrl;
  if (data.pinned !== undefined) update.pinned = data.pinned;
  if (data.scheduledAt !== undefined) {
    update.scheduledAt = data.scheduledAt ? new Date(data.scheduledAt) : null;
    // Rejalashtirish olib tashlansa — kanal rejasi ham o'chadi.
    if (!data.scheduledAt && data.channelPlan === undefined) {
      update.channelPlan = null;
      update.channelSendAt = null;
    }
  }
  if (data.channelPlan !== undefined) {
    if (data.channelPlan === null) {
      update.channelPlan = null;
      update.channelSendAt = null;
    } else {
      if (post.status !== "scheduled") {
        return fail("conflict", "Kanal rejasi faqat rejalashtirilgan postga o'rnatiladi");
      }
      const prepared = await preparePlan(id, data.channelPlan);
      if (!prepared.ok) return prepared;
      update.channelPlan = prepared.data;
    }
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

  const tagRows = data.tagSlugs !== undefined ? await resolveTagIds(data.tagSlugs) : null;

  const outcome = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(posts)
      .where(and(eq(posts.id, id), isNull(posts.deletedAt)))
      .for("update")
      .limit(1);
    if (!locked) return fail("not_found", "Topilmadi");

    if (data.settings !== undefined) {
      update.settings = resolveSettings(locked.settings, data.settings);
    }

    if (data.excerpt !== undefined) {
      if (data.excerpt === null) {
        if (renderedExcerpt === null) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rendered = await renderPost((update.contentJson ?? locked.contentJson) as any);
          renderedExcerpt = rendered.excerpt;
        }
        update.excerpt = renderedExcerpt;
      } else {
        update.excerpt = data.excerpt;
      }
    }

    const hasColumnChanges = Object.keys(update).length > 0;
    const now = new Date();
    if (
      (hasColumnChanges || tagRows) &&
      (internal.forceSnapshot || (await shouldSnapshotForUpdate(tx, id, actor, now)))
    ) {
      await snapshotPost(tx, locked, actor, internal.revisionReason ?? "update");
    }
    if (hasColumnChanges) {
      update.updatedAt = new Date();
      update.updatedBy = actor.userId;
      update.updatedVia = actor.via;
      await tx.update(posts).set(update).where(eq(posts.id, id));
    }

    if (tagRows) {
      await tx.delete(postTags).where(eq(postTags.postId, id));
      if (tagRows.length > 0) {
        await tx
          .insert(postTags)
          .values(tagRows.map((tag) => ({ postId: id, tagId: tag.id })))
          .onConflictDoNothing();
      }
      if (!hasColumnChanges) {
        await tx.update(posts).set({ updatedAt: new Date(), updatedBy: actor.userId, updatedVia: actor.via }).where(eq(posts.id, id));
      }
    }

    const [fresh] = await tx.select().from(posts).where(eq(posts.id, id)).limit(1);

    if (fresh && (hasColumnChanges || tagRows) && internal.audit) {
      await recordAudit(tx, actor, {
        action: internal.audit.action,
        entityType: "post",
        entityId: id,
        summary: `${internal.audit.summary}: ${postLabel(fresh)}`,
        meta: { status: fresh.status, fields: Object.keys(data), ...(internal.audit.meta ?? {}) },
      });
    } else if (fresh && (hasColumnChanges || tagRows)) {
      const fields = Object.keys(data);
      await recordAuditCoalesced(
        tx,
        actor,
        {
          action: "post.update",
          entityType: "post",
          entityId: id,
          summary: `Post tahrirlandi: ${postLabel(fresh)}`,
          meta: { status: fresh.status },
          fields,
        },
        AUDIT_COALESCE_MS,
      );
    }

    return ok({ fresh: fresh ?? null, previousSlug: locked.slug });
  });
  if (!outcome.ok) return outcome;

  const { fresh, previousSlug } = outcome.data;
  if (fresh?.status === "published") {
    await announceUpdated(fresh, {
      tagSlugs: tagRows ? tagRows.map((tag) => tag.slug) : null,
      previousSlug: update.slug && update.slug !== previousSlug ? previousSlug : null,
    });
  }

  return ok({ updatedAt: fresh?.updatedAt.toISOString() ?? new Date().toISOString() });
}

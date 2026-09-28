import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { posts } from "../db/schema.js";
import { user } from "../db/auth-schema.js";
import { events } from "./events.js";
import { pathsForPost, revalidateWeb } from "./revalidate.js";
import { tagsForPostIds } from "../routes/posts.js";

type PostRow = typeof posts.$inferSelect;

async function loadPost(id: string): Promise<PostRow | null> {
  const [row] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
  return row ?? null;
}

export type SubmitPostResult =
  | { ok: true; post: PostRow }
  | { ok: false; reason: "not_found" | "not_owner" | "invalid_status" };

/**
 * Xodim (staff) "Ko'rib chiqishga yuborish" bosganda — `draft`/`changes_requested`
 * dan `in_review`ga o'tkazadi, `post.submitted` hodisasini chiqaradi (Telegram
 * admin chatga xabar yuborish shu hodisaga obuna bo'ladi).
 */
export async function submitPostForReview(postId: string, authorId: string): Promise<SubmitPostResult> {
  const post = await loadPost(postId);
  if (!post) return { ok: false, reason: "not_found" };
  if (post.createdBy !== authorId) return { ok: false, reason: "not_owner" };
  if (post.status !== "draft" && post.status !== "changes_requested") {
    return { ok: false, reason: "invalid_status" };
  }

  const now = new Date();
  await db
    .update(posts)
    .set({ status: "in_review", submittedAt: now, reviewNote: null, updatedAt: now })
    .where(eq(posts.id, postId));

  const fresh = await loadPost(postId);
  if (!fresh) return { ok: false, reason: "not_found" };

  const [author] = await db
    .select({ name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, authorId))
    .limit(1);

  events.emit("post.submitted", {
    id: fresh.id,
    slug: fresh.slug,
    title: fresh.title,
    authorName: author?.name || author?.email || "Xodim",
  });

  return { ok: true, post: fresh };
}

export type ApprovePostResult = { ok: true; post: PostRow } | { ok: false; reason: "not_found" | "not_in_review" };

/**
 * `in_review -> published` — HTTP (`POST /admin/posts/:id/approve`) va Telegram
 * (`pr:ok:<id>` callback) IKKALASI HAM shu funksiyani chaqiradi, shuning uchun
 * "mavjud publish yo'li orqali sayt + Telegraph + kanal" bir xil ishlaydi.
 */
export async function approvePost(postId: string, reviewerId: string): Promise<ApprovePostResult> {
  const post = await loadPost(postId);
  if (!post) return { ok: false, reason: "not_found" };
  if (post.status !== "in_review") return { ok: false, reason: "not_in_review" };

  const now = new Date();
  await db
    .update(posts)
    .set({
      status: "published",
      publishedAt: post.publishedAt ?? now,
      updatedAt: now,
      reviewedBy: reviewerId,
      reviewedAt: now,
      reviewNote: null,
    })
    .where(eq(posts.id, postId));

  const fresh = await loadPost(postId);
  if (!fresh) return { ok: false, reason: "not_found" };

  events.emit("post.published", { id: fresh.id, slug: fresh.slug });
  const tagSlugs = (await tagsForPostIds([postId])).get(postId)?.map((t) => t.slug) ?? [];
  revalidateWeb(pathsForPost(fresh.slug, tagSlugs));

  return { ok: true, post: fresh };
}

export type RequestChangesResult = { ok: true; post: PostRow } | { ok: false; reason: "not_found" | "not_in_review" };

/** `in_review -> changes_requested` — admin izohi (`reviewNote`) xodimga admin panelda ko'rinadi. */
export async function requestPostChanges(
  postId: string,
  reviewerId: string,
  note: string,
): Promise<RequestChangesResult> {
  const post = await loadPost(postId);
  if (!post) return { ok: false, reason: "not_found" };
  if (post.status !== "in_review") return { ok: false, reason: "not_in_review" };

  const now = new Date();
  await db
    .update(posts)
    .set({ status: "changes_requested", reviewNote: note, reviewedBy: reviewerId, reviewedAt: now, updatedAt: now })
    .where(eq(posts.id, postId));

  const fresh = await loadPost(postId);
  if (!fresh) return { ok: false, reason: "not_found" };
  return { ok: true, post: fresh };
}

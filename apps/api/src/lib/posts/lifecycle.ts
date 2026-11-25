import { and, eq, lte } from "drizzle-orm";
import { ChannelPlanSchema, type ChannelPlan } from "@blog/shared";
import { db } from "../../db/index.js";
import { user } from "../../db/auth-schema.js";
import { posts } from "../../db/schema.js";
import { events } from "../events.js";
import { announcePublished, announceUnpublished } from "./effects.js";
import { preparePlan } from "./plan.js";
import {
  loadPost,
  requireAdminActor,
  toLifecycleSummary,
  type LifecycleSummary,
  type PostRow,
} from "./shared.js";
import { fail, ok, SCHEDULER_ACTOR, type Actor, type ServiceResult } from "./types.js";

type PostPatch = Partial<typeof posts.$inferInsert>;

interface TransitionSpec {
  /** Qulflangan (joriy) qator ustida tekshiruv — xato qaytarsa, hech narsa o'zgarmaydi. */
  guard?: (post: PostRow) => ServiceResult<never> | null;
  /** O'zgartiriladigan ustunlar (`updatedAt` har doim `now`). */
  buildPatch: (post: PostRow, now: Date) => PostPatch;
}

interface TransitionData {
  before: PostRow;
  after: PostRow;
}

/**
 * Barcha holat o'tishlari (publish/unpublish/archive/schedule/approve/request-changes/submit/...) uchun
 * YAGONA yo'l: qatorni qulflaydi (`FOR UPDATE`), tekshiradi, yangilaydi. Yon ta'sirlar (hodisalar, ISR)
 * chaqiruvchi tomonidan tranzaksiya COMMIT bo'lgandan keyin ishga tushiriladi.
 */
async function transition(
  _actor: Actor,
  id: string,
  spec: TransitionSpec,
): Promise<ServiceResult<TransitionData>> {
  return db.transaction(async (tx): Promise<ServiceResult<TransitionData>> => {
    const [before] = await tx.select().from(posts).where(eq(posts.id, id)).for("update").limit(1);
    if (!before) return fail("not_found", "Topilmadi");

    const guarded = spec.guard?.(before);
    if (guarded) return guarded;

    const now = new Date();
    const [after] = await tx
      .update(posts)
      .set({ ...spec.buildPatch(before, now), updatedAt: now })
      .where(eq(posts.id, id))
      .returning();
    if (!after) return fail("not_found", "Topilmadi");

    return ok({ before, after });
  });
}

/** `{ admin tekshiruvi -> 404 }` — route'lar tana (body) tekshiruvidan OLDIN shuni chaqiradi (eski tartibni saqlash uchun). */
export async function checkAdminPost(actor: Actor, id: string): Promise<ServiceResult<PostRow>> {
  const denied = requireAdminActor(actor);
  if (denied) return denied;
  const post = await loadPost(db, id);
  if (!post) return fail("not_found", "Topilmadi");
  return ok(post);
}

/** Tana (body) tekshiruvi uchun route'ga kerak bo'ladigan oddiy qidiruv. */
export async function findPost(id: string): Promise<PostRow | null> {
  return loadPost(db, id);
}

// ---------------------------------------------------------------------------
// Chop etish — YAGONA funksiya (admin route, approve, scheduler)
// ---------------------------------------------------------------------------

export type PublishKind = "manual" | "approve" | "scheduled";

interface PublishArgs {
  kind: PublishKind;
  /** `approve` uchun: tasdiqlovchi foydalanuvchi. */
  reviewerId?: string | null;
}

/**
 * Postni `published`ga o'tkazadi VA yon ta'sirlarni (post.published hodisasi, ISR revalidate) bajaradi.
 * Uch xil chop etish yo'li (qo'lda / tasdiqlash / rejalashtirilgan) FAQAT ustun to'plamida farq qiladi —
 * yon ta'sirlar bir joyda.
 */
async function executePublish(
  actor: Actor,
  id: string,
  args: PublishArgs,
  guard?: TransitionSpec["guard"],
): Promise<ServiceResult<PostRow>> {
  const result = await transition(actor, id, {
    guard,
    buildPatch: (post, now) => {
      switch (args.kind) {
        case "approve":
          return {
            status: "published",
            publishedAt: post.publishedAt ?? now,
            reviewedBy: args.reviewerId ?? null,
            reviewedAt: now,
            reviewNote: null,
          };
        case "scheduled": {
          const plan = ChannelPlanSchema.safeParse(post.channelPlan);
          return {
            status: "published",
            publishedAt: now,
            scheduledAt: null,
            // Kanal rejasi bor bo'lsa — chop etilgan vaqt + kechikish.
            ...(plan.success
              ? {
                  channelPlan: { ...plan.data, attempts: 0 },
                  channelSendAt: new Date(now.getTime() + plan.data.delayMinutes * 60_000),
                }
              : { channelPlan: null, channelSendAt: null }),
          };
        }
        default:
          return {
            status: "published",
            publishedAt: post.publishedAt ?? now,
            // Qo'lda chop etilsa — rejalashtirilgan kanal rejasi bekor (kanalga yuborish qo'lda).
            ...(post.status === "scheduled" ? { channelPlan: null, channelSendAt: null } : {}),
          };
      }
    },
  });
  if (!result.ok) return result;

  await announcePublished(result.data.after);
  return ok(result.data.after);
}

/** `POST /admin/posts/:id/publish` — holatidan qat'i nazar chop etadi (eski xatti-harakat saqlangan). */
export async function publishPost(actor: Actor, id: string): Promise<ServiceResult<LifecycleSummary>> {
  const denied = requireAdminActor(actor);
  if (denied) return denied;
  const result = await executePublish(actor, id, { kind: "manual" });
  return result.ok ? ok(toLifecycleSummary(result.data)) : result;
}

/** `in_review -> published` — HTTP va Telegram (`pr:ok:<id>`) ikkalasi ham shu funksiyani chaqiradi. */
export async function approvePost(actor: Actor, id: string): Promise<ServiceResult<PostRow>> {
  const denied = requireAdminActor(actor);
  if (denied) return denied;
  return executePublish(actor, id, { kind: "approve", reviewerId: actor.userId }, (post) =>
    post.status !== "in_review" ? fail("conflict", "Post ko'rib chiqishda emas") : null,
  );
}

/** Scheduler: vaqti kelgan `scheduled` postlarni chop etadi. Har biri alohida tranzaksiya. */
export async function publishDuePosts(now: Date = new Date()): Promise<void> {
  const due = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.status, "scheduled"), lte(posts.scheduledAt, now)));

  for (const { id } of due) {
    const result = await executePublish(SCHEDULER_ACTOR, id, { kind: "scheduled" }, (post) =>
      post.status !== "scheduled" ? fail("conflict", "Post endi rejalashtirilmagan") : null,
    );
    if (result.ok) console.log(`Rejalashtirilgan post chop etildi: ${result.data.slug}`);
  }
}

// ---------------------------------------------------------------------------
// Boshqa o'tishlar
// ---------------------------------------------------------------------------

async function leavePublished(
  actor: Actor,
  id: string,
  buildPatch: TransitionSpec["buildPatch"],
): Promise<ServiceResult<LifecycleSummary>> {
  const denied = requireAdminActor(actor);
  if (denied) return denied;
  const result = await transition(actor, id, { buildPatch });
  if (!result.ok) return result;
  if (result.data.before.status === "published") await announceUnpublished(result.data.after);
  return ok(toLifecycleSummary(result.data.after));
}

export function unpublishPost(actor: Actor, id: string) {
  return leavePublished(actor, id, () => ({ status: "draft", channelPlan: null, channelSendAt: null }));
}

export function archivePost(actor: Actor, id: string) {
  return leavePublished(actor, id, () => ({ status: "archived", channelPlan: null, channelSendAt: null }));
}

export interface ScheduleInput {
  scheduledAt: string;
  channelPlan?: ChannelPlan | null;
}

export async function schedulePost(
  actor: Actor,
  id: string,
  input: ScheduleInput,
): Promise<ServiceResult<LifecycleSummary>> {
  const denied = requireAdminActor(actor);
  if (denied) return denied;
  const post = await loadPost(db, id);
  if (!post) return fail("not_found", "Topilmadi");

  const scheduledAt = new Date(input.scheduledAt);
  if (Number.isNaN(scheduledAt.getTime())) return fail("bad_request", "Noto'g'ri sana");

  let storedPlan: ChannelPlan | null = null;
  if (input.channelPlan) {
    const prepared = await preparePlan(id, input.channelPlan);
    if (!prepared.ok) return prepared;
    storedPlan = prepared.data;
  }

  const result = await transition(actor, id, {
    buildPatch: () => ({ status: "scheduled", scheduledAt, channelPlan: storedPlan, channelSendAt: null }),
  });
  if (!result.ok) return result;
  if (result.data.before.status === "published") await announceUnpublished(result.data.after);
  return ok(toLifecycleSummary(result.data.after));
}

// ---------------------------------------------------------------------------
// Ko'rib chiqish (xodim -> admin)
// ---------------------------------------------------------------------------

/**
 * Xodim "Ko'rib chiqishga yuborish" bosganda — `draft`/`changes_requested`dan `in_review`ga o'tkazadi,
 * `post.submitted` hodisasini chiqaradi (Telegram admin chatga xabar shu hodisaga obuna).
 * Faqat postning MUALLIFI yubora oladi (admin ham).
 */
export async function submitPostForReview(
  actor: Actor,
  id: string,
): Promise<ServiceResult<{ id: string; status: PostRow["status"]; submittedAt: Date | null }>> {
  const result = await transition(actor, id, {
    guard: (post) => {
      if (!actor.userId || post.createdBy !== actor.userId) {
        return fail("forbidden", "Faqat o'z postlaringizni ko'rib chiqishga yubora olasiz");
      }
      if (post.status !== "draft" && post.status !== "changes_requested") {
        return fail("conflict", "Post allaqachon ko'rib chiqilmoqda yoki chop etilgan");
      }
      return null;
    },
    buildPatch: (_post, now) => ({ status: "in_review", submittedAt: now, reviewNote: null }),
  });
  if (!result.ok) return result;
  const fresh = result.data.after;

  const [author] = await db
    .select({ name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, actor.userId ?? ""))
    .limit(1);

  events.emit("post.submitted", {
    id: fresh.id,
    slug: fresh.slug,
    title: fresh.title,
    authorName: author?.name || author?.email || "Xodim",
  });

  return ok({ id: fresh.id, status: fresh.status, submittedAt: fresh.submittedAt });
}

/** `in_review -> changes_requested` — admin izohi (`reviewNote`) xodimga admin panelda ko'rinadi. */
export async function requestPostChanges(
  actor: Actor,
  id: string,
  note: string,
): Promise<ServiceResult<LifecycleSummary>> {
  const denied = requireAdminActor(actor);
  if (denied) return denied;
  const result = await transition(actor, id, {
    guard: (post) => (post.status !== "in_review" ? fail("conflict", "Post ko'rib chiqishda emas") : null),
    buildPatch: (_post, now) => ({
      status: "changes_requested",
      reviewNote: note,
      reviewedBy: actor.userId,
      reviewedAt: now,
    }),
  });
  return result.ok ? ok(toLifecycleSummary(result.data.after)) : (result);
}

/** `DELETE /admin/posts/:id` — faqat `draft`/`archived` (admin). */
export async function deletePost(actor: Actor, id: string): Promise<ServiceResult<null>> {
  const denied = requireAdminActor(actor);
  if (denied) return denied;
  const post = await loadPost(db, id);
  if (!post) return fail("not_found", "Topilmadi");
  if (post.status !== "draft" && post.status !== "archived") {
    return fail("conflict", "Chop etilgan postni o'chirish uchun avval uni qoralamaga qaytaring yoki arxivlang");
  }
  await db.delete(posts).where(eq(posts.id, id));
  return ok(null);
}

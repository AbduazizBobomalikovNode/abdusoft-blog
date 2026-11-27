import { and, eq, isNull, lte } from "drizzle-orm";
import { ChannelPlanSchema, isAbsoluteChannelPlan, type ChannelPlan } from "@blog/shared";
import { db } from "../../db/index.js";
import { user } from "../../db/auth-schema.js";
import { posts, telegramRefs } from "../../db/schema.js";
import { events } from "../events.js";
import { recordAudit, type AuditEntry } from "../audit.js";
import { actorMayTouchChannel, CHANNEL_REMOVAL_REFUSED, postHasChannelMessage } from "./channel-guard.js";
import { announcePublished, announceUnpublished } from "./effects.js";
import { checkAbsoluteTime, preparePlan } from "./plan.js";
import { planPatchOnPublish } from "./publish-plan.js";
import { snapshotPost, type RevisionReason } from "./revisions.js";
import {
  loadPost,
  checkExpectedUpdatedAt,
  postLabel,
  requireAdminActor,
  toLifecycleSummary,
  type ConcurrencyOptions,
  type LifecycleSummary,
  type PostRow,
} from "./shared.js";
import { fail, ok, SCHEDULER_ACTOR, type Actor, type ServiceResult } from "./types.js";

type PostPatch = Partial<typeof posts.$inferInsert>;

interface TransitionSpec {
  /** Qulflangan (joriy) qator ustida tekshiruv — xato qaytarsa, hech narsa o'zgarmaydi. */
  guard?: (post: PostRow) => ServiceResult<never> | null;
  /** O'zgartiriladigan ustunlar (`updatedAt`, `updatedBy`, `updatedVia` har doim o'rnatiladi). */
  buildPatch: (post: PostRow, now: Date) => PostPatch;
  /** Jurnal yozuvi — o'zgarish bilan BIR tranzaksiyada yoziladi. */
  audit: (before: PostRow, after: PostRow) => AuditEntry;
  /** Berilsa — yozishdan OLDIN joriy holat revision sifatida saqlanadi. */
  revision?: RevisionReason;
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
  actor: Actor,
  id: string,
  spec: TransitionSpec,
  opts: ConcurrencyOptions = {},
): Promise<ServiceResult<TransitionData>> {
  return db.transaction(async (tx): Promise<ServiceResult<TransitionData>> => {
    const [before] = await tx
      .select()
      .from(posts)
      .where(and(eq(posts.id, id), isNull(posts.deletedAt)))
      .for("update")
      .limit(1);
    if (!before) return fail("not_found", "Topilmadi");

    const guarded = spec.guard?.(before);
    if (guarded) return guarded;

    const conflict = await checkExpectedUpdatedAt(tx, before, opts.expectedUpdatedAt);
    if (conflict) return conflict;

    if (spec.revision) await snapshotPost(tx, before, actor, spec.revision);

    const now = new Date();
    const [after] = await tx
      .update(posts)
      .set({
        ...spec.buildPatch(before, now),
        updatedAt: now,
        // Har bir o'tish ijrochini yozadi; scheduler/tizim uchun `updatedBy = null` (foydalanuvchi id'si o'ylab topilmaydi).
        updatedBy: actor.userId,
        updatedVia: actor.via,
      })
      .where(eq(posts.id, id))
      .returning();
    if (!after) return fail("not_found", "Topilmadi");

    await recordAudit(tx, actor, spec.audit(before, after));

    return ok({ before, after });
  });
}

function statusChange(action: string, verb: string, extra: Record<string, unknown> = {}) {
  return (before: PostRow, after: PostRow): AuditEntry => ({
    action,
    entityType: "post",
    entityId: after.id,
    summary: `Post ${verb}: ${postLabel(after)}`,
    meta: { from: before.status, to: after.status, slug: after.slug, ...extra },
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

interface PublishArgs extends ConcurrencyOptions {
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
  // Kanalga allaqachon yuborilganmi — chop etish yangilanishidan OLDIN aniqlanadi (reja `status` bilan bir yangilanishda hisoblanadi).
  const alreadySent = await channelAlreadySent(id);
  const result = await transition(actor, id, {
    guard,
    revision: "publish",
    audit: statusChange(
      args.kind === "approve" ? "post.approve" : args.kind === "scheduled" ? "post.publish_scheduled" : "post.publish",
      args.kind === "approve" ? "tasdiqlandi va chop etildi" : "chop etildi",
    ),
    buildPatch: (post, now) => {
      // Telegram rejasi (har qanday chop etish yo'li): `planPatchOnPublish` — kechikish chop etilgan vaqtdan, aniq vaqt saqlanadi.
      const planPatch = planPatchOnPublish({ stored: post.channelPlan, kind: args.kind, wasPublished: post.status === "published", alreadySent, now });
      switch (args.kind) {
        case "approve":
          return {
            status: "published",
            publishedAt: post.publishedAt ?? now,
            reviewedBy: args.reviewerId ?? null,
            reviewedAt: now,
            reviewNote: null,
            ...planPatch,
          };
        case "scheduled":
          return { status: "published", publishedAt: now, scheduledAt: null, ...planPatch };
        default:
          return { status: "published", publishedAt: post.publishedAt ?? now, ...planPatch };
      }
    },
  }, { expectedUpdatedAt: args.expectedUpdatedAt });
  if (!result.ok) return result;

  await announcePublished(result.data.after, { skipChannel: !actorMayTouchChannel(actor) });
  return ok(result.data.after);
}

/** `POST /admin/posts/:id/publish` — holatidan qat'i nazar chop etadi (eski xatti-harakat saqlangan). */
export async function publishPost(
  actor: Actor,
  id: string,
  opts: ConcurrencyOptions = {},
): Promise<ServiceResult<LifecycleSummary>> {
  const denied = requireAdminActor(actor);
  if (denied) return denied;
  const result = await executePublish(actor, id, { kind: "manual", ...opts });
  return result.ok ? ok(toLifecycleSummary(result.data)) : result;
}

/** `in_review -> published` — HTTP va Telegram (`pr:ok:<id>`) ikkalasi ham shu funksiyani chaqiradi. */
export async function approvePost(
  actor: Actor,
  id: string,
  opts: ConcurrencyOptions = {},
): Promise<ServiceResult<PostRow>> {
  const denied = requireAdminActor(actor);
  if (denied) return denied;
  return executePublish(actor, id, { kind: "approve", reviewerId: actor.userId, ...opts }, (post) =>
    post.status !== "in_review" ? fail("conflict", "Post ko'rib chiqishda emas") : null,
  );
}

/** Scheduler: vaqti kelgan `scheduled` postlarni chop etadi. Har biri alohida tranzaksiya. */
export async function publishDuePosts(now: Date = new Date()): Promise<void> {
  const due = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.status, "scheduled"), isNull(posts.deletedAt), lte(posts.scheduledAt, now)));

  for (const { id } of due) {
    // Har bir post ALOHIDA: bittasining xatosi (DB, hodisa, ...) qolganlarini va keyingi tick'larni to'smasin.
    try {
      const result = await executePublish(SCHEDULER_ACTOR, id, { kind: "scheduled" }, (post) =>
        post.status !== "scheduled" ? fail("conflict", "Post endi rejalashtirilmagan") : null,
      );
      if (result.ok) console.log(`Rejalashtirilgan post chop etildi: ${result.data.slug}`);
    } catch (error: unknown) {
      console.error(`Rejalashtirilgan postni chop etib bo'lmadi (${id}):`, error instanceof Error ? error.message : error);
    }
  }
}

// ---------------------------------------------------------------------------
// Boshqa o'tishlar
// ---------------------------------------------------------------------------

/**
 * Ulangan yordamchi `channels:send` ruxsatisiz kanalga yuborilgan postni saytdan olib tashlay olmaydi: bu kanal xabarini
 * o'chirib yuborardi. Panel/tizim aktyorlari uchun hech narsa o'zgarmaydi.
 */
async function refuseChannelRemoval(actor: Actor, id: string) {
  if (actorMayTouchChannel(actor)) return null;
  const post = await findPost(id);
  if (post?.status !== "published") return null;
  if (!(await postHasChannelMessage(id))) return null;
  return fail("forbidden", CHANNEL_REMOVAL_REFUSED);
}

async function leavePublished(
  actor: Actor,
  id: string,
  buildPatch: TransitionSpec["buildPatch"],
  audit: TransitionSpec["audit"],
  revision: RevisionReason,
  opts: ConcurrencyOptions,
): Promise<ServiceResult<LifecycleSummary>> {
  const denied = requireAdminActor(actor);
  if (denied) return denied;
  const blocked = await refuseChannelRemoval(actor, id);
  if (blocked) return blocked;
  const result = await transition(actor, id, { buildPatch, audit, revision }, opts);
  if (!result.ok) return result;
  if (result.data.before.status === "published") await announceUnpublished(result.data.after, { skipChannel: !actorMayTouchChannel(actor) });
  return ok(toLifecycleSummary(result.data.after));
}

export function unpublishPost(actor: Actor, id: string, opts: ConcurrencyOptions = {}) {
  return leavePublished(
    actor,
    id,
    // Telegram rejasi SAQLANADI (boshqa kanallar kabi), faqat navbat vaqti olinadi: qayta chop etilganda qayta hisoblanadi.
    // Yuborilayotgan (claim qilingan) yuborishga tegilmaydi — ishchi o'zi tugatadi yoki `not_published` bilan to'xtaydi.
    () => ({ status: "draft", channelSendAt: null }),
    statusChange("post.unpublish", "qoralamaga qaytarildi"),
    "unpublish",
    opts,
  );
}

export function archivePost(actor: Actor, id: string, opts: ConcurrencyOptions = {}) {
  return leavePublished(
    actor,
    id,
    // Arxiv — deyarli yakuniy holat: Telegram rejasi tozalanadi (qoralamaga qaytarilsa reja qayta qo'yiladi).
    () => ({ status: "archived", channelPlan: null, channelSendAt: null }),
    statusChange("post.archive", "arxivlandi"),
    "archive",
    opts,
  );
}

/** Saqlangan (qayta rejalashtirishda) aniq vaqtli reja yangi chop etish vaqtidan oldin bo'lsa `true` (kechikishli rejada doim `false`). */
function keptAbsoluteTooEarly(plan: ChannelPlan, scheduledAt: Date): boolean {
  return isAbsoluteChannelPlan(plan) && new Date(plan.sendAt).getTime() < scheduledAt.getTime();
}

export interface ScheduleInput extends ConcurrencyOptions {
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
  if (input.channelPlan === undefined) {
    // Reja berilmagan (masalan MCP `schedule_post`) — qoralamaga qaytarilganda saqlangan Telegram rejasi YO'QOLMAYDI.
    // Saqlangan aniq vaqt yangi chop etish vaqtidan oldin bo'lsa (yoki yaroqsiz bo'lsa) — olib tashlanadi.
    const kept = ChannelPlanSchema.safeParse(post.channelPlan);
    if (kept.success && !keptAbsoluteTooEarly(kept.data, scheduledAt)) storedPlan = kept.data;
  } else if (input.channelPlan) {
    // Aniq vaqt: kanal vaqti post saytga chiqishidan oldin bo'lmasin (qoralamada ham shu yerda — rejalashtirishda — tekshiriladi).
    const timeError = checkAbsoluteTime(input.channelPlan, scheduledAt);
    if (timeError) return fail("bad_request", timeError);
    const prepared = await preparePlan(id, input.channelPlan);
    if (!prepared.ok) return prepared;
    storedPlan = prepared.data;
  }

  const blocked = await refuseChannelRemoval(actor, id);
  if (blocked) return blocked;
  const result = await transition(actor, id, {
    revision: "schedule",
    audit: statusChange("post.schedule", "rejalashtirildi", {
      scheduledAt: scheduledAt.toISOString(),
      hasChannelPlan: storedPlan !== null,
    }),
    buildPatch: () => ({ status: "scheduled", scheduledAt, channelPlan: storedPlan, channelSendAt: null }),
  }, { expectedUpdatedAt: input.expectedUpdatedAt });
  if (!result.ok) return result;
  if (result.data.before.status === "published") await announceUnpublished(result.data.after, { skipChannel: !actorMayTouchChannel(actor) });
  return ok(toLifecycleSummary(result.data.after));
}

// ---------------------------------------------------------------------------
// Kanalga aniq vaqtda yuborish (CHOP ETILGAN post) — mavjud `runDueChannelSends` ishchisidan foydalanadi
// ---------------------------------------------------------------------------

/** Post kanalga allaqachon yuborilganmi (idempotentlik: ikki marta yuborish yo'q). */
async function channelAlreadySent(postId: string): Promise<boolean> {
  const [ref] = await db.select({ sentAt: telegramRefs.channelSentAt }).from(telegramRefs).where(eq(telegramRefs.postId, postId)).limit(1);
  return ref?.sentAt != null;
}

/** Ishchi rejani "claim" qilgan, yuborish tugamagan (reja bor, `channel_send_at` NULL) — shu paytda tegilmaydi. */
const IN_FLIGHT_MESSAGE = "Hozir kanalga yuborilmoqda — biroz kutib qayta urinib ko'ring";

/** Chop etilgan postga aniq vaqtli reja qo'yish mumkinmi (dry-run va haqiqiy chaqiruv bir xil tekshiradi): rad sababi yoki `null`. */
export async function channelScheduleBlocker(post: PostRow): Promise<ServiceResult<never> | null> {
  if (await channelAlreadySent(post.id)) {
    return fail("conflict", "Post kanalga allaqachon yuborilgan — qayta yuborish uchun «Qayta yuborish» ishlating");
  }
  if (post.channelPlan != null && post.channelSendAt == null) return fail("conflict", IN_FLIGHT_MESSAGE);
  return null;
}

export interface ScheduleChannelSendInput extends ConcurrencyOptions {
  /** `sendAt` bor reja (kanal tanlovi `useChoice` / `mode`+`variant` / `versionId`). */
  plan: ChannelPlan;
}

/**
 * CHOP ETILGAN postni kanalga ANIQ vaqtda yuborishga rejalashtiradi: `channel_send_at = sendAt`, reja `channel_plan`da (`sendAt`).
 * Yuborishni mavjud ishchi (`runDueChannelSends`) bajaradi — yangi supurgi yo'q. Rad etiladi: chop etilmagan post, vaqt o'tgan/juda uzoq,
 * allaqachon kanalga yuborilgan, hozir yuborilayotgan, Telegram cheklovlari bajarilmagan.
 */
export async function scheduleChannelSend(actor: Actor, id: string, input: ScheduleChannelSendInput): Promise<ServiceResult<LifecycleSummary>> {
  const denied = requireAdminActor(actor);
  if (denied) return denied;
  if (!actorMayTouchChannel(actor)) return fail("forbidden", "Kanalga yuborish uchun 'channels:send' ruxsati kerak");
  const post = await loadPost(db, id);
  if (!post) return fail("not_found", "Topilmadi");
  if (post.status !== "published") {
    return fail(
      "conflict",
      post.status === "scheduled"
        ? "Rejalashtirilgan postda kanal vaqti post rejasi bilan birga o'rnatiladi"
        : "Aniq vaqtda kanalga yuborish faqat chop etilgan postga o'rnatiladi",
    );
  }
  const parsed = ChannelPlanSchema.safeParse(input.plan);
  if (!parsed.success || !isAbsoluteChannelPlan(parsed.data)) return fail("bad_request", "Noto'g'ri kanal rejasi");
  const timeError = checkAbsoluteTime(parsed.data, new Date());
  if (timeError) return fail("bad_request", timeError);
  const blocker = await channelScheduleBlocker(post);
  if (blocker) return blocker;
  const prepared = await preparePlan(id, parsed.data);
  if (!prepared.ok) return prepared;
  const storedPlan: ChannelPlan = { ...prepared.data, attempts: 0 };
  const sendAt = new Date(prepared.data.sendAt!);

  const result = await transition(actor, id, {
    guard: (locked) =>
      locked.status !== "published"
        ? fail("conflict", "Post endi chop etilgan emas")
        : locked.channelPlan != null && locked.channelSendAt == null
          ? fail("conflict", IN_FLIGHT_MESSAGE)
          : null,
    audit: (before, after) => ({
      action: "post.channel_schedule",
      entityType: "post",
      entityId: after.id,
      summary: `Kanalga yuborish vaqti belgilandi: ${postLabel(after)}`,
      meta: { sendAt: sendAt.toISOString(), replaced: before.channelPlan != null },
    }),
    buildPatch: () => ({ channelPlan: storedPlan, channelSendAt: sendAt }),
  }, { expectedUpdatedAt: input.expectedUpdatedAt });
  return result.ok ? ok(toLifecycleSummary(result.data.after)) : result;
}

/** Chop etilgan postning kutayotgan kanal rejasini (kechikishli ham, aniq vaqtli ham) bekor qiladi. Hech narsa yuborilmaydi/o'chirilmaydi. */
export async function cancelChannelSend(actor: Actor, id: string, opts: ConcurrencyOptions = {}): Promise<ServiceResult<LifecycleSummary>> {
  const denied = requireAdminActor(actor);
  if (denied) return denied;
  if (!actorMayTouchChannel(actor)) return fail("forbidden", "Kanalga yuborish uchun 'channels:send' ruxsati kerak");
  const post = await loadPost(db, id);
  if (!post) return fail("not_found", "Topilmadi");
  if (post.status !== "published") return fail("conflict", "Faqat chop etilgan postning kanal rejasi shu yerda bekor qilinadi");
  if (post.channelPlan == null) return ok(toLifecycleSummary(post));
  const result = await transition(actor, id, {
    guard: (locked) =>
      locked.status !== "published"
        ? fail("conflict", "Post endi chop etilgan emas")
        : locked.channelPlan != null && locked.channelSendAt == null
          ? fail("conflict", IN_FLIGHT_MESSAGE)
          : null,
    audit: (_before, after) => ({
      action: "post.channel_schedule_cancel",
      entityType: "post",
      entityId: after.id,
      summary: `Kanalga yuborish rejasi bekor qilindi: ${postLabel(after)}`,
    }),
    // Reja bekor qilinishi = oxirgi (muvaffaqiyatsiz) urinish xatosini ham ko'rib chiqilgan deb hisoblaymiz.
    buildPatch: () => ({ channelPlan: null, channelSendAt: null, channelLastError: null, channelLastErrorAt: null }),
  }, opts);
  return result.ok ? ok(toLifecycleSummary(result.data.after)) : result;
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
  opts: ConcurrencyOptions = {},
): Promise<ServiceResult<{ id: string; status: PostRow["status"]; submittedAt: Date | null; updatedAt: Date }>> {
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
    audit: statusChange("post.submit", "ko'rib chiqishga yuborildi"),
    buildPatch: (_post, now) => ({ status: "in_review", submittedAt: now, reviewNote: null }),
  }, opts);
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

  return ok({ id: fresh.id, status: fresh.status, submittedAt: fresh.submittedAt, updatedAt: fresh.updatedAt });
}

/** `in_review -> changes_requested` — admin izohi (`reviewNote`) xodimga admin panelda ko'rinadi. */
export async function requestPostChanges(
  actor: Actor,
  id: string,
  note: string,
  opts: ConcurrencyOptions = {},
): Promise<ServiceResult<LifecycleSummary>> {
  const denied = requireAdminActor(actor);
  if (denied) return denied;
  const result = await transition(actor, id, {
    guard: (post) => (post.status !== "in_review" ? fail("conflict", "Post ko'rib chiqishda emas") : null),
    audit: statusChange("post.request_changes", "tuzatish uchun qaytarildi", { noteLength: note.length }),
    buildPatch: (_post, now) => ({
      status: "changes_requested",
      reviewNote: note,
      reviewedBy: actor.userId,
      reviewedAt: now,
    }),
  }, opts);
  return result.ok ? ok(toLifecycleSummary(result.data.after)) : (result);
}

import { ChannelPlanSchema, isAbsoluteChannelPlan, type ChannelPublishOutcome } from "@blog/shared";

/** Chop etish yo'li: qo'lda / tasdiqlash / scheduler (`lifecycle.ts` bilan bir xil). */
export type PublishPlanKind = "manual" | "approve" | "scheduled";

export interface PublishPlanInput {
  /** `posts.channel_plan` (xom). */
  stored: unknown;
  kind: PublishPlanKind;
  /** Post chop etishdan OLDIN allaqachon `published` edi (qo'lda qayta chop etish) — reja o'zgarmaydi. */
  wasPublished: boolean;
  /** Post kanalga allaqachon yuborilgan (`telegram_refs.channel_sent_at`) — qayta yuborilmaydi, reja olib tashlanadi. */
  alreadySent: boolean;
  /** Aktyor kanalga tega oladimi (`actorMayTouchChannel`): yo'q bo'lsa reja ishga TUSHIRILMAYDI (tashlanadi). */
  mayTouchChannel?: boolean;
  now: Date;
}

export interface PublishPlanPatch {
  channelPlan?: unknown;
  channelSendAt?: Date | null;
}

export interface PublishPlanResult {
  patch: PublishPlanPatch;
  outcome: ChannelPublishOutcome;
}

const DROP: PublishPlanPatch = { channelPlan: null, channelSendAt: null };

/**
 * Har qanday chop etishda (qo'lda, tasdiqlash, scheduler, qoralamaga qaytarilgandan keyin qayta chop etish) Telegram rejasini
 * `status` bilan BIR yangilanishda yangi `channel_send_at`ga aylantiradi (shu sababli `recoverInterruptedChannelSends`
 * qayta chop etilgan postni darhol yubormaydi). Invariant: chop etilgan postda reja bor bo'lsa, `channel_send_at` ham bor —
 * har bir tarmoq yo yuboradi, yo rejani TOZALAYDI:
 * - reja yo'q — hech narsa o'zgarmaydi; post allaqachon chop etilgan edi — reja o'zgarmaydi;
 * - aktyorda kanal huquqi yo'q — reja tashlanadi (ruxsatsiz kanalga yuborish ishga tushmasin);
 * - allaqachon kanalga yuborilgan — reja tozalanadi (qayta yuborilmaydi; almashtirish oqimi alohida);
 * - kechikishli reja — `now + kechikish` (HAQIQIY chop etish vaqtidan);
 * - aniq vaqtli reja — kelajakdagi `sendAt` saqlanadi; o'tib ketgan bo'lsa scheduler chop etishida `now` (kech scheduler),
 *   qo'lda/tasdiqlashda reja tashlanadi (kutilmagan darhol yuborishdan saqlanish).
 * `outcome` chaqiruvchiga reja nima bo'lganini aytadi (natija/dry-run/toast uchun).
 */
export function planOnPublish({ stored, kind, wasPublished, alreadySent, mayTouchChannel = true, now }: PublishPlanInput): PublishPlanResult {
  if (stored == null || wasPublished) return { patch: {}, outcome: { state: "none" } };
  const parsed = ChannelPlanSchema.safeParse(stored);
  if (!parsed.success) return { patch: DROP, outcome: { state: "dropped", reason: "invalid" } };
  if (!mayTouchChannel) return { patch: DROP, outcome: { state: "dropped", reason: "no_permission" } };
  if (alreadySent) return { patch: DROP, outcome: { state: "dropped", reason: "already_sent" } };
  const plan = parsed.data;
  const arm = (at: Date): PublishPlanResult => ({ patch: { channelPlan: { ...plan, attempts: 0 }, channelSendAt: at }, outcome: { state: "armed", at: at.toISOString() } });
  if (!isAbsoluteChannelPlan(plan)) return arm(new Date(now.getTime() + plan.delayMinutes * 60_000));
  const at = new Date(plan.sendAt);
  if (at.getTime() > now.getTime()) return arm(at);
  if (kind === "scheduled") return arm(now);
  return { patch: DROP, outcome: { state: "dropped", reason: "past_time" } };
}

/** Faqat ustun o'zgarishi kerak bo'lganda (`planOnPublish().patch`). */
export function planPatchOnPublish(input: PublishPlanInput): PublishPlanPatch {
  return planOnPublish(input).patch;
}

import { ChannelPlanSchema, isAbsoluteChannelPlan } from "@blog/shared";

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
  now: Date;
}

export interface PublishPlanPatch {
  channelPlan?: unknown;
  channelSendAt?: Date | null;
}

/**
 * Har qanday chop etishda (qo'lda, tasdiqlash, scheduler, qoralamaga qaytarilgandan keyin qayta chop etish) Telegram rejasini
 * `status` bilan BIR yangilanishda yangi `channel_send_at`ga aylantiradi (shu sababli `recoverInterruptedChannelSends`
 * qayta chop etilgan postni darhol yubormaydi):
 * - reja yo'q — hech narsa o'zgarmaydi; post allaqachon chop etilgan edi — reja o'zgarmaydi;
 * - allaqachon kanalga yuborilgan — reja tozalanadi (qayta yuborilmaydi; almashtirish oqimi alohida);
 * - kechikishli reja — `now + kechikish` (HAQIQIY chop etish vaqtidan);
 * - aniq vaqtli reja — kelajakdagi `sendAt` saqlanadi; o'tib ketgan bo'lsa scheduler chop etishida `now` (kech scheduler),
 *   qo'lda/tasdiqlashda reja tashlanadi (kutilmagan darhol yuborishdan saqlanish).
 */
export function planPatchOnPublish({ stored, kind, wasPublished, alreadySent, now }: PublishPlanInput): PublishPlanPatch {
  if (stored == null || wasPublished) return {};
  const parsed = ChannelPlanSchema.safeParse(stored);
  if (!parsed.success || alreadySent) return { channelPlan: null, channelSendAt: null };
  const plan = parsed.data;
  if (!isAbsoluteChannelPlan(plan)) {
    return { channelPlan: { ...plan, attempts: 0 }, channelSendAt: new Date(now.getTime() + plan.delayMinutes * 60_000) };
  }
  const at = new Date(plan.sendAt);
  if (at.getTime() > now.getTime()) return { channelPlan: { ...plan, attempts: 0 }, channelSendAt: at };
  if (kind === "scheduled") return { channelPlan: { ...plan, attempts: 0 }, channelSendAt: now };
  return { channelPlan: null, channelSendAt: null };
}

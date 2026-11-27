import { eq } from "drizzle-orm";
import { isAbsoluteChannelPlan, type ChannelStatus } from "@blog/shared";
import { db } from "../../db/index.js";
import { telegramRefs } from "../../db/schema.js";
import { parseStoredPlan, type PostRow } from "./shared.js";

/**
 * Faqat o'qish uchun Telegram holati (`posts` + `telegram_refs`dan; tarqatish jadvallariga tegmaydi, `DISTRIBUTION_ENABLED`ga bog'liq emas).
 * Holat: reja bor + `channel_send_at` bor = planned; reja bor, `channel_send_at` yo'q (chop etilgan) = ishchi hozir yuboryapti;
 * yuborilgan (`channel_sent_at`) = sent (kutayotgan reja bo'lsa ham planned ustun — masalan "qayta yuborish" rejasi).
 */
export async function getChannelStatus(post: PostRow): Promise<ChannelStatus> {
  const [ref] = await db
    .select({ sentAt: telegramRefs.channelSentAt, ids: telegramRefs.channelMessageIds, id: telegramRefs.channelMessageId })
    .from(telegramRefs)
    .where(eq(telegramRefs.postId, post.id))
    .limit(1);
  const plan = parseStoredPlan(post.channelPlan);
  const sentAt = ref?.sentAt?.toISOString() ?? null;
  const messageIds = ref?.ids?.length ? ref.ids : ref?.id != null ? [ref.id] : [];
  const hasPlan = plan !== null || post.channelPlan != null;
  const queued = hasPlan && post.channelSendAt != null;
  const inFlight = hasPlan && post.channelSendAt == null && post.status === "published";
  const state: ChannelStatus["state"] = queued ? "planned" : inFlight ? "sending" : sentAt ? "sent" : post.status === "scheduled" && hasPlan ? "planned" : "none";
  return {
    state,
    plan: plan ? { kind: isAbsoluteChannelPlan(plan) ? "at" : "delay", delayMinutes: isAbsoluteChannelPlan(plan) ? null : plan.delayMinutes, attempts: plan.attempts ?? 0 } : null,
    sendAt: queued ? post.channelSendAt!.toISOString() : plan && isAbsoluteChannelPlan(plan) && post.status === "scheduled" ? plan.sendAt : null,
    sentAt,
    messageIds,
    attempts: plan?.attempts ?? 0,
  };
}

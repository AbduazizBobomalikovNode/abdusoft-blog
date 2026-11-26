import type { ChannelChoice, CreateChannelVersionBody, UpdateChannelVersionBody } from "@blog/shared";
import { recordAuditSafe } from "../lib/audit.js";
import type { Actor } from "../lib/posts/types.js";
import type { PostRow } from "../lib/posts/index.js";
import { findPost } from "../lib/posts/index.js";
import { ChannelPlanSchema, type ChannelPlan } from "@blog/shared";
import { editChannelCaptionForPost, loadTelegramRef } from "./channel-send.js";
import { clearChannelChoice, parseStoredChoice, resolveChannelChoice, setChannelChoice } from "./channel-choice.js";
import { createChannelVersion, deleteChannelVersion, updateChannelVersion } from "./channel-version-service.js";

/**
 * Kanal versiyalari / belgi / matn sinxroni: xizmat + jurnal yozuvi — HTTP marshrutlari VA MCP vositalari uchun YAGONA yo'l
 * (jurnal harakat nomlari va matnlari o'zgarmagan).
 */
export async function createChannelVersionAudited(actor: Actor, post: PostRow, body: CreateChannelVersionBody) {
  const result = await createChannelVersion(post, body, actor.userId);
  if (result.ok) await recordAuditSafe(actor, { action: "post.channel_version_create", entityType: "post", entityId: post.id, summary: "Kanal versiyasi yaratildi" });
  return result;
}

export async function updateChannelVersionAudited(actor: Actor, post: PostRow, versionId: string, body: UpdateChannelVersionBody) {
  const result = await updateChannelVersion(post, versionId, body);
  if (result.ok) await recordAuditSafe(actor, { action: "post.channel_version_update", entityType: "post", entityId: post.id, summary: "Kanal versiyasi tahrirlandi", meta: { versionId } });
  return result;
}

export async function deleteChannelVersionAudited(actor: Actor, post: PostRow, versionId: string) {
  const result = await deleteChannelVersion(post, versionId);
  if (result.ok) {
    await recordAuditSafe(actor, { action: "post.channel_version_delete", entityType: "post", entityId: post.id, summary: "Kanal versiyasi o'chirildi", meta: { versionId, clearedChoice: result.data.clearedChoice } });
  }
  return result;
}

export async function setChannelChoiceAudited(actor: Actor, post: PostRow, choice: ChannelChoice, userId: string) {
  const result = await setChannelChoice(post.id, choice, userId);
  if (!result.ok) return result;
  await recordAuditSafe(actor, { action: "post.channel_choice_set", entityType: "post", entityId: post.id, summary: "Kanal versiyasi belgilandi" });
  const fresh = await findPost(post.id);
  return { ok: true as const, choice: fresh ? await resolveChannelChoice(fresh) : null };
}

export async function clearChannelChoiceAudited(actor: Actor, post: PostRow) {
  await clearChannelChoice(post.id);
  await recordAuditSafe(actor, { action: "post.channel_choice_clear", entityType: "post", entityId: post.id, summary: "Kanal versiyasi belgisi olib tashlandi" });
}

export async function resyncChannelCaptionAudited(actor: Actor, postId: string) {
  await editChannelCaptionForPost(postId);
  await recordAuditSafe(actor, { action: "post.channel_resync", entityType: "post", entityId: postId, summary: "Kanal xabari matni yangilandi" });
}

/**
 * Kanalga yuboriladigan (ommaviy) matnga ta'sir: bu versiya yoki belgi kutilayotgan reja / yuborilgan xabar tomonidan ishlatilsa —
 * sabab matnini qaytaradi, aks holda `null`. Faqat MCP ruxsat tekshiruvi uchun (panel xatti-harakati o'zgarmaydi).
 */
export async function channelSendImpact(post: PostRow, target: { versionId: string } | { choiceChange: true }): Promise<string | null> {
  const parsed = post.channelPlan == null ? null : ChannelPlanSchema.safeParse(post.channelPlan);
  // Tahlil qilib bo'lmaydigan reja — eng ehtiyotkor talqin: belgidan foydalanadi deb hisoblanadi.
  const plan: ChannelPlan | null = parsed?.success ? parsed.data : post.channelPlan != null ? { useChoice: true, delayMinutes: 0 } : null;
  if ("choiceChange" in target) {
    if (plan?.useChoice) return "a scheduled channel send of this post uses the marked version, so changing the mark changes what will be posted publicly";
    return null;
  }
  const { versionId } = target;
  if (plan?.versionId === versionId) return "a scheduled channel send of this post uses this version";
  if (plan?.useChoice) {
    const marked = parseStoredChoice(post.channelChoice);
    if (marked?.kind === "version" && marked.versionId === versionId) return "this version is the one marked on the post and a scheduled channel send uses the marked version";
  }
  const ref = await loadTelegramRef(post.id);
  if (ref?.channelMessageId && ref.channelVersionId === versionId) return "the post's existing channel message was sent from this version";
  return null;
}

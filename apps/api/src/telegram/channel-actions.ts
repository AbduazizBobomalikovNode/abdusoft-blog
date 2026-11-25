import type { ChannelSelection, ChannelSendRequest, PublishChannelSendResult } from "@blog/shared";
import { recordAuditSafe } from "../lib/audit.js";
import type { Actor } from "../lib/posts/types.js";
import { getChannelInfo } from "./channel-info.js";
import { sendMarkedChoiceNow } from "./channel-plan.js";
import {
  computeChannelPost,
  computeChannelVersionPost,
  getChannelAlreadySent,
  sendPostToChannel,
  sendVersionToChannel,
  type ChannelComputed,
  type ComputeChannelPostResult,
  type SendChannelPostResult,
} from "./channel-send.js";

/**
 * Kanal amallari — HTTP marshrutlari (`routes/admin-posts.ts`) va MCP vositalari uchun YAGONA yo'l. Marshrut/vosita faqat
 * kirishni tekshiradi va natijani o'z formatiga o'giradi.
 */

const CHANNEL_SEND_WAIT_MS = 20_000;

/** Rejani (kechikishsiz) qo'yib, Telegraph'dan keyin yuboradi; natija javobga (toast) qo'shiladi. Uzoq cho'zilsa — fonda davom etadi (admin chatga xabar boradi). */
export async function queueChannelSend(postId: string): Promise<PublishChannelSendResult> {
  const work = sendMarkedChoiceNow(postId).then(
    (outcome): PublishChannelSendResult => {
      if (outcome.state === "sent") return { state: "sent", messageUrl: outcome.messageUrl, error: null };
      if (outcome.state === "failed") {
        return {
          state: "failed",
          messageUrl: null,
          error: outcome.willRetry ? `${outcome.reason} (keyinroq qayta uriniladi)` : outcome.reason,
        };
      }
      return { state: "failed", messageUrl: null, error: "Kanalga yuborilmadi (allaqachon yuborilgan bo'lishi mumkin)" };
    },
    (error: unknown): PublishChannelSendResult => ({
      state: "failed",
      messageUrl: null,
      error: error instanceof Error ? error.message : "Noma'lum xato",
    }),
  );
  const timeout = new Promise<PublishChannelSendResult>((resolve) => {
    setTimeout(() => resolve({ state: "pending", messageUrl: null, error: null }), CHANNEL_SEND_WAIT_MS).unref?.();
  });
  return Promise.race([work, timeout]);
}

/**
 * `POST /admin/posts/:id/channel/send` va MCP `send_to_channel`: preflight `send*ToChannel` ichida server tomonida ishlaydi —
 * o'tmasa HECH NARSA yuborilmaydi (`reason: "preflight_failed"` + hisobot). Muvaffaqiyatda jurnalga yoziladi.
 */
export async function sendToChannelAudited(
  actor: Actor,
  postId: string,
  request: ChannelSendRequest,
): Promise<SendChannelPostResult> {
  const result =
    "versionId" in request
      ? await sendVersionToChannel(postId, request.versionId, { replaceExisting: request.replaceExisting })
      : await sendPostToChannel(postId, request.mode, request.variant, { replaceExisting: request.replaceExisting });

  if (result.ok) {
    await recordAuditSafe(actor, {
      action: request.replaceExisting ? "post.channel_replace" : "post.channel_send",
      entityType: "post",
      entityId: postId,
      summary: request.replaceExisting ? "Post kanalga qayta yuborildi (almashtirildi)" : "Post kanalga yuborildi",
      meta:
        "versionId" in request
          ? { versionId: request.versionId, replaceExisting: Boolean(request.replaceExisting) }
          : { mode: request.mode, variant: request.variant, replaceExisting: Boolean(request.replaceExisting) },
    });
  }
  return result;
}

export type ChannelPreviewResult =
  | {
      ok: true;
      computed: ChannelComputed;
      alreadySent: Awaited<ReturnType<typeof getChannelAlreadySent>>;
      channel: Awaited<ReturnType<typeof getChannelInfo>>;
    }
  | { ok: false; reason: Extract<ComputeChannelPostResult, { ok: false }>["reason"] };

/** `POST /admin/posts/:id/channel/preview` va MCP `preview_channel_post`. Post chop etilmagan bo'lsa ham ko'rinish quriladi. */
export async function previewChannelPost(postId: string, selection: ChannelSelection): Promise<ChannelPreviewResult> {
  const computed =
    "versionId" in selection
      ? await computeChannelVersionPost(postId, selection.versionId, { allowUnpublished: true, allowEmptyMedia: true })
      : await computeChannelPost(postId, selection.mode, selection.variant, { allowUnpublished: true });
  if (!computed.ok) return { ok: false, reason: computed.reason };
  const [alreadySent, channel] = await Promise.all([getChannelAlreadySent(postId), getChannelInfo()]);
  return { ok: true, computed: computed.data, alreadySent, channel };
}

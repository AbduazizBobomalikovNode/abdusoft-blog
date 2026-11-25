import type { ChannelPlan, ChannelSelection } from "@blog/shared";
import { computeChannelPreflight, summarizePreflightErrors } from "../../telegram/channel-preflight.js";
import { loadVersion } from "../../telegram/channel-versions.js";
import { resolveChoiceForSend } from "../../telegram/channel-choice.js";
import { fail, ok, type ServiceResult } from "./types.js";

/** Klientdan kelgan rejadan `attempts` (server hisoblagichi)ni olib tashlaydi. */
function cleanPlan(plan: ChannelPlan): ChannelPlan {
  if (plan.useChoice) return { useChoice: true, delayMinutes: plan.delayMinutes };
  return plan.versionId
    ? { mode: plan.mode, versionId: plan.versionId, delayMinutes: plan.delayMinutes }
    : { mode: plan.mode, variant: plan.variant, delayMinutes: plan.delayMinutes };
}

/**
 * Kanal rejasini saqlashdan oldin preflight (post chop etilganligi talab qilinmaydi).
 * Muvaffaqiyatli bo'lsa — tozalangan reja (versiya bo'lsa `mode` versiyadan olinadi);
 * aks holda 404/400/422 xatosi (+ tekshiruvlar).
 */
export async function preparePlan(postId: string, plan: ChannelPlan): Promise<ServiceResult<ChannelPlan>> {
  let cleaned = cleanPlan(plan);
  let selection: ChannelSelection;
  if (plan.useChoice) {
    // Tekshiruv hozirgi belgiga nisbatan (yo'q bo'lsa — standart tanlov); yuborish paytida belgi qayta hal qilinadi.
    const resolved = await resolveChoiceForSend(postId);
    if (!resolved) return fail("not_found", "Topilmadi");
    selection = resolved.selection;
  } else {
    if (plan.versionId) {
      const version = await loadVersion(postId, plan.versionId);
      if (!version) return fail("not_found", "Versiya topilmadi");
      cleaned = { ...cleaned, mode: version.mode };
    }
    selection = cleaned.versionId ? { versionId: cleaned.versionId } : { mode: cleaned.mode!, variant: cleaned.variant! };
  }
  const result = await computeChannelPreflight(postId, selection, {
    requirePublished: false,
    planFallback: !("versionId" in selection),
  });
  if (!result.ok) {
    return result.reason === "not_found" ? fail("not_found", "Topilmadi") : fail("bad_request", "Noto'g'ri kanal rejasi");
  }
  if (!result.preflight.canSend) {
    return fail("unprocessable", `Telegram cheklovlari bajarilmagan: ${summarizePreflightErrors(result.preflight)}`, {
      preflight: result.preflight,
    });
  }
  return ok(cleaned);
}

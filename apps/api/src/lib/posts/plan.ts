import { CHANNEL_SEND_AT_MAX_DAYS, isAbsoluteChannelPlan, type ChannelPlan, type ChannelSelection } from "@blog/shared";
import { computeChannelPreflight, summarizePreflightErrors } from "../../telegram/channel-preflight.js";
import { loadVersion } from "../../telegram/channel-versions.js";
import { resolveChoiceForSend } from "../../telegram/channel-choice.js";
import { fail, ok, type ServiceResult } from "./types.js";

/** Klientdan kelgan rejadan `attempts` (server hisoblagichi)ni olib tashlaydi. */
function cleanPlan(plan: ChannelPlan): ChannelPlan {
  // Aniq vaqt: ISO normallashtiriladi, kechikish doim 0 (ikkalasi bir-birini inkor etadi).
  const timing = isAbsoluteChannelPlan(plan)
    ? { delayMinutes: 0, sendAt: new Date(plan.sendAt).toISOString() }
    : { delayMinutes: plan.delayMinutes };
  if (plan.useChoice) return { useChoice: true, ...timing };
  return plan.versionId
    ? { mode: plan.mode, versionId: plan.versionId, ...timing }
    : { mode: plan.mode, variant: plan.variant, ...timing };
}

/**
 * Aniq vaqtli rejaning vaqtini tekshiradi (kechikishli rejada hech narsa qilmaydi).
 * `notBefore` — vaqt shundan oldin bo'lmasin (chop etilgan post: hozir; rejalashtirilgan post: chop etilish vaqti).
 * Eng ko'pi `CHANNEL_SEND_AT_MAX_DAYS` kun keyin. Xato matni yoki `null`.
 */
export function checkAbsoluteTime(plan: ChannelPlan, notBefore: Date, now: Date = new Date()): string | null {
  if (!isAbsoluteChannelPlan(plan)) return null;
  const at = new Date(plan.sendAt).getTime();
  if (Number.isNaN(at)) return "Noto'g'ri yuborish vaqti";
  if (at <= now.getTime()) return "Yuborish vaqti kelajakda bo'lishi kerak";
  if (at < notBefore.getTime()) return "Kanalga yuborish vaqti post saytga chiqish vaqtidan oldin bo'lmasin";
  if (at > now.getTime() + CHANNEL_SEND_AT_MAX_DAYS * 86_400_000) return `Yuborish vaqti ${CHANNEL_SEND_AT_MAX_DAYS} kundan uzoq bo'lmasin`;
  return null;
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

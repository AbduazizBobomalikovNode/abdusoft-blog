import type { PostConflictResponse } from "@blog/shared";
import { changedByText } from "@/lib/admin-labels";

/**
 * Banner matni: kim va qaysi kanaldan o'zgartirgani. O'zimiz boshqa oyna/qurilmadan o'zgartirgan bo'lsak — buni aytamiz
 * (bir xil foydalanuvchining ikki tabi ham haqiqiy to'qnashuv: qaysi biri yangi ekanini bilmaymiz).
 */
export function conflictSummary(
  conflict: Pick<PostConflictResponse, "updatedBy" | "via">,
  meId?: string,
): { who: string; by: string; own: boolean } {
  const own = !!meId && conflict.updatedBy?.id === meId && (!conflict.via || conflict.via === "web");
  if (own) return { who: "Siz boshqa oyna yoki qurilmada o'zgartirgansiz", by: "sizning boshqa oynangiz", own: true };
  if (!conflict.updatedBy && !conflict.via) return { who: "Kim o'zgartirgani noma'lum", by: "noma'lum", own: false };
  const by = changedByText(conflict.updatedBy, conflict.via);
  return { who: `O'zgartirgan: ${by}`, by, own: false };
}

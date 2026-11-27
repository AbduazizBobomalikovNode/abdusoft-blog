import {
  DISTRIBUTION_PLAN_MAX_DELAY_MINUTES,
  DISTRIBUTION_PLAN_PRESETS,
  type AdminPostStatus,
  type DistributionItemDto,
  type DistributionProviderId,
} from "@blog/shared";

/**
 * "Saytga chiqqach N daqiqadan keyin" (Telegram rejasi kabi) — tarqatish rejasining sof yordamchilari: kechikish matni,
 * reja holati, qaysi post holatida reja qo'yiladi. Serverdagi mantiq bilan bir xil (server baribir tekshiradi).
 */

export { DISTRIBUTION_PLAN_MAX_DELAY_MINUTES, DISTRIBUTION_PLAN_PRESETS };

/** Reja faqat hali chop etilmagan postga qo'yiladi (qoralama, ko'rib chiqishda, rejalashtirilgan). Chop etilgan postda — aniq vaqt. */
export function canPlanForPost(status: AdminPostStatus | string): boolean {
  return status === "draft" || status === "in_review" || status === "scheduled";
}

/** Tarqatish tugmasi/dialogi: chop etilgan post (yuborish) yoki reja qo'yish mumkin bo'lgan post. */
export function distributionAvailableFor(status: AdminPostStatus | string): boolean {
  return status === "published" || canPlanForPost(status);
}

/** Kiritilgan qiymatni 0..10080 butun songa keltiradi (bo'sh/noto'g'ri — 0). */
export function clampDelay(value: number | string): number {
  const n = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return 0;
  return Math.min(DISTRIBUTION_PLAN_MAX_DELAY_MINUTES, Math.max(0, Math.trunc(n)));
}

export function isPresetDelay(minutes: number): boolean {
  return DISTRIBUTION_PLAN_PRESETS.includes(minutes);
}

/** Qisqa yorliq: 0 -> "chop etilishi bilan", 15 -> "15 daq", 90 -> "1 soat 30 daq", 1440 -> "1 kun". */
export function delayText(minutes: number): string {
  if (minutes <= 0) return "chop etilishi bilan";
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  return [d ? `${d} kun` : "", h ? `${h} soat` : "", m ? `${m} daq` : ""].filter(Boolean).join(" ");
}

/** "chiqqach 15 daq" / "chop etilishi bilan" (muharrir kartasi va dialog uchun). */
export function planPhrase(minutes: number): string {
  return minutes <= 0 ? "chop etilishi bilan" : `chiqqach ${delayText(minutes)}`;
}

export type PlanState = "none" | "waiting" | "scheduled" | "failed" | "sent" | "active";

/** Qatorning reja holati: kutmoqda (post chop etilmagan), rejalashtirilgan, xato, yuborilgan yoki yuborilmoqda. */
export function planStateOf(item: Pick<DistributionItemDto, "status" | "planDelayMinutes" | "planMaterializedAt"> | null): PlanState {
  if (!item || item.planDelayMinutes === null) return "none";
  if (item.status === "sent") return "sent";
  if (item.status === "failed" || item.status === "needs_checking") return "failed";
  if (item.status === "sending") return "active";
  if (item.status === "scheduled") return "scheduled";
  return item.status === "draft" ? "waiting" : "none";
}

export const PLAN_STATE_LABEL: Record<Exclude<PlanState, "none">, string> = {
  waiting: "post chop etilishini kutmoqda",
  scheduled: "rejalashtirildi",
  failed: "bajarilmadi",
  sent: "yuborildi",
  active: "yuborilmoqda",
};

export interface PlanSummaryLine {
  provider: DistributionProviderId;
  label: string;
  phrase: string;
  state: Exclude<PlanState, "none">;
  stateLabel: string;
  scheduledAt: string | null;
  error: string | null;
}

const PROVIDER_ORDER: readonly DistributionProviderId[] = ["linkedin", "x", "threads", "instagram", "github"];

/** Muharrir kartasi uchun: har bir kanalning (faol) rejasi — "LinkedIn · chiqqach 15 daq". Rejasi yo'q kanallar tushiriladi. */
export function planSummaryLines(items: DistributionItemDto[], nameOf: (provider: DistributionProviderId) => string): PlanSummaryLine[] {
  const active = items.filter((d) => d.status !== "cancelled");
  const out: PlanSummaryLine[] = [];
  for (const provider of PROVIDER_ORDER) {
    // Faol qator birinchi (draft/scheduled/...), bo'lmasa so'nggi yuborilgan.
    const rows = active.filter((d) => d.provider === provider && d.planDelayMinutes !== null);
    const item = rows.find((d) => d.status !== "sent") ?? rows[0];
    if (!item) continue;
    const state = planStateOf(item);
    if (state === "none") continue;
    out.push({
      provider,
      label: nameOf(provider),
      phrase: planPhrase(item.planDelayMinutes ?? 0),
      state,
      stateLabel: PLAN_STATE_LABEL[state],
      scheduledAt: item.status === "scheduled" ? item.scheduledAt : null,
      error: state === "failed" ? item.lastErrorMessage : null,
    });
  }
  return out;
}

/** Tab nuqtasi: kutayotgan reja (qoralama + reja) alohida rang oladi; qolgan holatlar o'z rangida. */
export function isWaitingPlan(item: Pick<DistributionItemDto, "status" | "planDelayMinutes"> | null): boolean {
  return item !== null && item.status === "draft" && item.planDelayMinutes !== null;
}

import type { AdminPostStatus, ChannelPlan, ChannelSelection, ResolvedChannelChoice } from "@blog/shared";
import { canPlanForPost, planPhrase } from "./distribution-plan";

/** "Tarqatish" dialogidagi Telegram yorlig'i uchun xulosa qatorlari (sof; ma'lumot tahrirlagichda allaqachon bor). */
export interface TelegramTabSummary {
  choice: string;
  plan: string;
  sent: string;
}

export function telegramTabSummary(input: {
  choice: ResolvedChannelChoice | null;
  plan: ChannelPlan | null;
  sent: boolean;
}): TelegramTabSummary {
  const { choice, plan, sent } = input;
  return {
    choice: choice ? `⭐ ${choice.label} · ${choice.visibleLength} / ${choice.limit} · ${choice.passes ? "cheklovlardan o'tadi" : "cheklovlarga mos emas"}` : "belgilanmagan (standart)",
    plan: plan ? `saytga ${planPhrase(plan.delayMinutes)}` : "reja yo'q",
    sent: sent ? "kanalga yuborilgan" : "hali yuborilmagan",
  };
}

/** Belgilangan tanlovdan oldindan ko'rish so'rovi tanlovi (belgi yo'q bo'lsa `null` — ko'rinish so'ralmaydi). */
export function previewSelectionOf(choice: ResolvedChannelChoice | null): ChannelSelection | null {
  if (!choice) return null;
  return choice.choice.kind === "version" ? { versionId: choice.choice.versionId } : { mode: choice.choice.mode, variant: choice.choice.variant };
}

/** Telegram panelining "Tarqatish" dialogidagi rejimi: chop etilgan post — yuborish; aks holda — tayyorlash (belgi + reja). Server qoidalari o'zgarmagan. */
export function telegramPanelMode(postStatus: AdminPostStatus | string): "send" | "prepare" {
  return postStatus === "published" ? "send" : "prepare";
}

/** Telegram rejasi (saytga chiqqach N daq) faqat hali chop etilmagan postga qo'yiladi — chop etilgan postda reja bloki ko'rsatilmaydi. */
export function telegramPlanEditable(postStatus: AdminPostStatus | string): boolean {
  return canPlanForPost(postStatus);
}

/** Reja qayerda saqlanishi haqida bir qatorli izoh: rejalashtirilgan postda avtosaqlash, aks holda "Rejalashtirish" bosilganda. */
export function telegramPlanStorageHint(postStatus: AdminPostStatus | string): string {
  return postStatus === "scheduled" ? "Reja avtomatik saqlanadi." : "Reja post rejalashtirilganda («Nashr» kartasi) saqlanadi.";
}

/** Oldindan ko'rish hech qachon bo'sh qolmasligi uchun: belgi bo'lmasa — standart ko'rinish (rasm bo'lsa 🖼/m, aks holda 📝/m). */
export function telegramDefaultSelection(canUseMedia: boolean | null): ChannelSelection {
  return { mode: canUseMedia === false ? "text" : "media", variant: "m" };
}

/** "Nashr" kartasidagi bir qatorli Telegram reja xulosasi. */
export function telegramPlanLine(plan: ChannelPlan | null): string {
  return plan ? `Telegram · saytga ${planPhrase(plan.delayMinutes)}` : "Telegram rejasi yo'q — post chop etilgach kanalga hech narsa yuborilmaydi.";
}

import type { ChannelPlan, ChannelSelection, ResolvedChannelChoice } from "@blog/shared";
import { planPhrase } from "./distribution-plan";

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

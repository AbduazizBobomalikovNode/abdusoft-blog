"use client";

import type { ChannelPlan, ResolvedChannelChoice } from "@blog/shared";
import { Button } from "@/components/ui/button";
import { telegramPlanLine } from "@/lib/distribution-telegram";
import { ChannelChecklistSummary } from "./channel-checklist";
import { channelPlanSummary, useChannelPlanMedia, useChannelPlanPreflight } from "./channel-plan-fields";

/**
 * "Nashr" kartasidagi Telegram rejasi xulosasi (bir qator + «Tarqatishda sozlash»). Tahrir "Tarqatish" dialogining Telegram yorlig'ida.
 * Reja bo'lsa Telegram cheklovlari tekshiruvi shu yerda DOIM ishlaydi (dialog yopiq bo'lsa ham) va xato bo'lsa `onBlockingChange(true)` —
 * "Rejalashtirish" tugmasi avvalgidek o'chadi.
 */
export function TelegramPlanSummary({ postId, plan, scheduledAtLocal, markedChoice, onBlockingChange, onOpen }: { postId: string; plan: ChannelPlan | null; scheduledAtLocal: string; markedChoice: ResolvedChannelChoice | null; onBlockingChange?: (blocked: boolean) => void; onOpen: () => void }) {
  const { canUseMedia } = useChannelPlanMedia(postId, plan, markedChoice);
  const { planPreflight, checking } = useChannelPlanPreflight({ postId, value: plan, markedChoice, canUseMedia, onBlockingChange });
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5" data-testid="telegram-plan-summary">
      <p className="text-xs font-medium">Telegram kanal rejasi</p>
      <p className="text-xs text-muted-foreground">{telegramPlanLine(plan)}</p>
      {plan ? <p className="text-xs leading-relaxed break-words text-muted-foreground">{channelPlanSummary(plan, scheduledAtLocal, null, markedChoice?.label ?? null)}</p> : null}
      {plan && checking && !planPreflight ? <p className="text-xs text-muted-foreground">Telegram cheklovlari tekshirilmoqda…</p> : null}
      {plan && planPreflight ? <ChannelChecklistSummary preflight={planPreflight} /> : null}
      <div>
        <Button type="button" variant="outline" size="sm" className="max-md:h-11 max-md:w-full" onClick={onOpen}>
          Tarqatishda sozlash
        </Button>
      </div>
    </div>
  );
}

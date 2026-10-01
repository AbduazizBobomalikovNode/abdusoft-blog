"use client";

import type { ResolvedChannelChoice } from "@blog/shared";
import { Button } from "@/components/ui/button";
import { cn } from "cn";

/**
 * Bir qatorli xulosa: "Kanal versiyasi: ⭐ Rasmli · O'rtacha · 812 / 1024 · ✓" + "O'zgartirish".
 * Admin uchun, xodim belgilagan bo'lsa, "Xodim taklifi" nishoni ko'rinadi.
 */
export function ChannelChoiceSummary({
  choice,
  onOpen,
  viewerIsStaff = false,
}: {
  choice: ResolvedChannelChoice | null;
  onOpen: () => void;
  viewerIsStaff?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5" data-testid="channel-choice-summary">
      <p className="text-xs leading-relaxed break-words">
        <span className="text-muted-foreground">Kanal versiyasi: </span>
        {choice ? (
          <>
            <span className="font-medium">⭐ {choice.label}</span>
            <span className="text-muted-foreground">
              {" "}
              · <span className={cn(choice.visibleLength > choice.limit && "font-semibold text-destructive")}>{choice.visibleLength} / {choice.limit}</span> ·{" "}
            </span>
            <span
              className={choice.passes ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}
              title={choice.passes ? "Telegram cheklovlaridan o'tadi" : "Telegram cheklovlariga mos emas"}
            >
              {choice.passes ? "✓" : "✗"}
            </span>
            {choice.suggestedByStaff && !viewerIsStaff ? (
              <span className="ml-1.5 rounded-full bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                Xodim taklifi
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-muted-foreground">belgilanmagan</span>
        )}
      </p>
      <div>
        <Button type="button" variant="outline" size="sm" className="max-md:h-11 max-md:w-full" onClick={onOpen}>
          {choice ? "O'zgartirish" : "Belgilash"}
        </Button>
      </div>
    </div>
  );
}

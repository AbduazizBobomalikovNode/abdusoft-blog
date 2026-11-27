"use client";

import type { ResolvedChannelChoice } from "@blog/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "cn";
import { TelegramPreviewCard } from "./channel-preview";
import { useChannelSend, type ChannelDialogMode, type Step } from "./channel-send-controller";
import { ChannelCheckStep, ChannelEditStep, ChannelSendAlerts, ChannelVersionStep } from "./channel-send-steps";

export type { ChannelDialogMode };

function stepLabels(mode: ChannelDialogMode): { value: Step; label: string }[] {
  return [
    { value: 1, label: "Versiya" },
    { value: 2, label: "Tahrirlash" },
    { value: 3, label: mode === "send" ? "Tekshiruv va yuborish" : "Tekshiruv va belgilash" },
  ];
}

/**
 * "Kanalga yuborish" dialogi — 3 qadam: 1) Versiya (avtomatik yoki "Mening versiyalarim"),
 * 2) Tahrirlash (faqat maxsus versiya), 3) Tekshiruv va yuborish (Telegram cheklovlari).
 * BOSHQARILADIGAN (controlled) komponent: chaqiruvchi o'z tugmasini render qiladi.
 * Mantiq `useChannelSend`da, qadam tanalari `channel-send-steps.tsx`da — "Tarqatish" dialogidagi Telegram paneli ham shularni ishlatadi.
 */
export function ChannelSendDialog({
  postId,
  open,
  onOpenChange,
  mode: dialogMode = "send",
  readOnly = false,
  onChoiceChange,
}: {
  postId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Standart `send` — eski chaqiruvchilar o'zgarmaydi. */
  mode?: ChannelDialogMode;
  /** Xodim uchun `in_review`da — versiyalarni faqat ko'rish (tahrirlash/belgilash yo'q). */
  readOnly?: boolean;
  /** Belgilangan versiya o'zgarganda (yoki yuklanganda) chaqiriladi — tashqi xulosa yangilanishi uchun. */
  onChoiceChange?: (choice: ResolvedChannelChoice | null) => void;
}) {
  const c = useChannelSend({ postId, active: open, mode: dialogMode, readOnly, onChoiceChange, onClose: () => onOpenChange(false) });
  const { step, choice, preview, loading, preflight, checking, marking, sending, resyncing, sending_, channelHandle, currentIsMarked, sendBlocked, goToStep, handleResync, applyMark, handleSend, setConfirmReplaceOpen, setStep, selectVersion } = c;
  const backStep: Step = step === 3 ? (choice.kind === "version" ? 2 : 1) : 1;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton
          className="flex max-h-[90vh] w-full max-w-2xl flex-col gap-4 overflow-y-auto sm:max-w-4xl max-sm:fixed max-sm:inset-0 max-sm:h-dvh max-sm:max-h-none max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none"
        >
          <DialogHeader>
            <DialogTitle>{sending_ ? "Kanalga yuborish" : "Kanal versiyasi"}</DialogTitle>
          </DialogHeader>

          <ol className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1 text-xs font-medium">
            {stepLabels(dialogMode).map((s) => {
              const disabled = s.value === 2 && (choice.kind !== "version" || readOnly);
              return (
                <li key={s.value}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => void goToStep(s.value)}
                    className={cn(
                      "w-full rounded-md px-2 py-1.5 transition-colors max-sm:min-h-11",
                      step === s.value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                      disabled && "cursor-not-allowed opacity-50",
                    )}
                  >
                    {s.value}. {s.label}
                  </button>
                </li>
              );
            })}
          </ol>

          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="flex min-w-0 flex-col gap-3 sm:w-1/2">{step === 1 ? (
                <ChannelVersionStep c={c} onEdit={(v) => { selectVersion(v); setStep(2); }} />
              ) : step === 2 ? (
                <ChannelEditStep c={c} />
              ) : (
                <ChannelCheckStep c={c} />
              )}</div>
            <div className="min-w-0 flex-1 overflow-hidden rounded-xl sm:sticky sm:top-0 sm:self-start">
              <TelegramPreviewCard channelName={channelHandle} preview={preview} loading={loading} />
            </div>
          </div>

          <DialogFooter className="sticky -bottom-4 z-10 flex-row items-center justify-between gap-2 bg-popover max-sm:rounded-none max-sm:pb-[max(1rem,env(safe-area-inset-bottom))]">
            <div className="flex items-center gap-2">
              {step > 1 ? (
                <Button type="button" variant="outline" size="sm" className="max-sm:h-11" onClick={() => void goToStep(backStep)}>
                  Orqaga
                </Button>
              ) : null}
              {step === 3 && sending_ && preview?.alreadySent && !preview.alreadySent.versionId ? (
                <Button type="button" variant="outline" size="sm" className="max-sm:h-11" disabled={resyncing} onClick={() => void handleResync()}>
                  {resyncing ? "Yangilanmoqda…" : "Caption'ni yangilash"}
                </Button>
              ) : null}
            </div>
            {step < 3 ? (
              <Button type="button" className="max-sm:h-11" disabled={loading || !preview} onClick={() => void goToStep(3)}>
                {sending_ ? "Tekshirish va yuborish" : "Tekshirish"}
              </Button>
            ) : !sending_ ? (
              readOnly ? null : (
                <Button
                  type="button"
                  className="max-sm:h-11"
                  disabled={marking || checking || !preflight || currentIsMarked}
                  onClick={() => void applyMark(choice, true)}
                >
                  {currentIsMarked
                    ? "★ Belgilangan"
                    : marking
                      ? "Belgilanmoqda…"
                      : dialogMode === "suggest"
                        ? "⭐ Taklif sifatida belgilash"
                        : "⭐ Asosiy qilib belgilash"}
                </Button>
              )
            ) : preview?.alreadySent ? (
              <Button type="button" variant="destructive" className="max-sm:h-11" disabled={sendBlocked} onClick={() => setConfirmReplaceOpen(true)}>
                Qayta yuborish
              </Button>
            ) : (
              <Button type="button" className="max-sm:h-11" disabled={sendBlocked} onClick={() => void handleSend(false)}>
                {sending ? "Yuborilmoqda…" : "Kanalga yuborish"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ChannelSendAlerts c={c} />
    </>
  );
}

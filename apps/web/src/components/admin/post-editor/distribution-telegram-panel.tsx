"use client";

import { useEffect } from "react";
import { ExternalLink } from "lucide-react";
import type { AdminPostStatus, ChannelPlan, ChannelStatus, ResolvedChannelChoice } from "@blog/shared";
import { Button } from "@/components/ui/button";
import { FLUSH_SAVED_HINT, sendGate, telegramErrorLine, telegramStatusLine, telegramPanelMode, telegramPlanEditable, telegramPlanStorageHint, telegramTabSummary } from "@/lib/distribution-telegram";
import { ChannelPlanFields } from "./channel-plan-fields";
import { TelegramPreviewCard } from "./channel-preview";
import { toSelection, useChannelSend } from "./channel-send-controller";
import { TelegramSendAt } from "./telegram-send-at";
import { ChannelCheckStep, ChannelEditStep, ChannelSendAlerts, ChannelVersionStep } from "./channel-send-steps";

export interface DistributionTelegramInfo {
  choice: ResolvedChannelChoice | null;
  plan: ChannelPlan | null;
  sent: boolean;
  sentUrl: string | null;
  channelHandle: string | null;
  /** Ixtiyoriy: post muharriridagi "rejalashtirish vaqti" (reja xulosasida kanal vaqtini ko'rsatish uchun). */
  scheduledAtLocal?: string;
  /** Ixtiyoriy: berilsa panelda "Saytga chiqqach" reja boshqaruvi chiqadi (post muharriri holatiga yoziladi). */
  onPlanChange?: (plan: ChannelPlan | null) => void;
  /** Ixtiyoriy: belgilangan versiya o'zgarganda (muharrir xulosasi yangilanadi). */
  onChoiceChange?: (choice: ResolvedChannelChoice | null) => void;
  /** Ixtiyoriy: serverdagi Telegram holati (`GET /channel/status`) — berilsa holat qatori va (chop etilgan postda) "Aniq vaqt" bloki chiqadi. */
  status?: ChannelStatus | null;
  /** Ixtiyoriy: holat o'zgargach (reja qo'yildi/bekor qilindi) qayta yuklash. */
  onStatusRefresh?: () => void;
}

/**
 * "Tarqatish" dialogidagi Telegram yorlig'i — boshqa kanal panellari bilan bir xil maket: chapda versiya tanlash, tahrirlagich,
 * tekshiruv, yuborish va reja; o'ngda (sticky) jonli Telegram ko'rinishi. Mantiq `ChannelSendDialog` bilan bir xil (`useChannelSend`).
 */
export function DistributionTelegramPanel({ postId, postStatus, info }: { postId: string; postStatus: AdminPostStatus; info: DistributionTelegramInfo }) {
  const mode = telegramPanelMode(postStatus);
  const c = useChannelSend({ postId, active: true, mode, onChoiceChange: info.onChoiceChange });
  const { preview, loading, runPreflight, choiceRef, flushOutcome, sendGuard, notice, setNotice, handleSend, setConfirmReplaceOpen, sendBlocked, sending, resyncing, handleResync } = c;

  // Belgilanmagan bo'lsa ham `useChannelSend` standart ko'rinishni yuklaydi (rasm bo'lsa 🖼/m, aks holda 📝/m) — oldindan ko'rish bo'sh qolmaydi.
  // Tekshiruv har yangi ko'rinishdan keyin (tanlov o'zgargani yoki tahrir saqlangani) avtomatik qayta ishga tushadi.
  useEffect(() => {
    if (preview) void runPreflight(toSelection(choiceRef.current));
  }, [preview, runPreflight, choiceRef]);

  const summary = telegramTabSummary({ choice: info.choice, plan: info.plan, sent: info.sent });
  const sendMode = mode === "send";
  const errorLine = info.status ? telegramErrorLine(info.status) : null;
  const planEditable = telegramPlanEditable(postStatus) && Boolean(info.onPlanChange);

  // Saqlash (flush) + yuborish `handleSend` ichida, sinxron qo'riqchi bilan: ikki marta bosish ikki yuborish bermaydi.
  async function sendNow() {
    await handleSend(false);
  }
  async function askReplace() {
    if (sending || !sendGuard.tryEnter()) return;
    try {
      const gate = sendGate(await flushOutcome());
      if (gate === "send") setConfirmReplaceOpen(true);
      else if (gate === "stop-saved") setNotice(FLUSH_SAVED_HINT);
    } finally {
      sendGuard.leave();
    }
  }

  return (
    <div className="grid shrink-0 gap-5 lg:grid-cols-2" data-testid="dist-telegram-panel">
      <div className="flex min-w-0 flex-col gap-4">
        <p className="text-xs text-muted-foreground">
          {info.status !== undefined ? telegramStatusLine(info.status) : summary.sent}
          {info.sentUrl ? (
            <a href={info.sentUrl} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-1 underline">Postni ochish <ExternalLink className="size-3" /></a>
          ) : null}
        </p>
        {errorLine ? <p className="text-xs break-words text-red-700 dark:text-red-400" data-testid="dist-telegram-last-error">{errorLine}</p> : null}

        <ChannelVersionStep c={c} />

        {c.selectedVersion ? (
          <section className="flex flex-col gap-2" data-testid="dist-telegram-editor">
            <h3 className="text-sm font-semibold">Tahrirlash</h3>
            <ChannelEditStep c={c} />
          </section>
        ) : (
          <p className="text-xs text-muted-foreground">Matnni tahrirlash uchun maxsus versiyani tanlang yoki «Shu ko&apos;rinishdan yangi versiya» yarating.</p>
        )}

        <ChannelCheckStep c={c} showSentNote={false} />

        {sendMode && notice ? <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="dist-telegram-notice">{notice}</p> : null}
        {sendMode ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3" data-testid="dist-telegram-send">
            {preview?.alreadySent && !preview.alreadySent.versionId ? (
              <Button type="button" variant="outline" size="sm" disabled={resyncing} onClick={() => void handleResync()}>
                {resyncing ? "Yangilanmoqda…" : "Caption'ni yangilash"}
              </Button>
            ) : null}
            {preview?.alreadySent ? (
              <Button type="button" size="sm" variant="destructive" disabled={sendBlocked || loading} onClick={() => void askReplace()}>Qayta yuborish</Button>
            ) : (
              <Button type="button" size="sm" disabled={sendBlocked || loading} onClick={() => void sendNow()}>{sending ? "Yuborilmoqda…" : "Kanalga yuborish"}</Button>
            )}
          </div>
        ) : null}

        {sendMode && info.status !== undefined && info.onStatusRefresh ? (
          <TelegramSendAt postId={postId} status={info.status} onChanged={info.onStatusRefresh} />
        ) : null}

        {planEditable && info.onPlanChange ? (
          <section className="flex flex-col gap-2 border-t border-border pt-3" data-testid="dist-telegram-plan">
            <h3 className="text-sm font-semibold">Telegram rejasi · saytga chiqqach</h3>
            <ChannelPlanFields
              postId={postId}
              value={info.plan}
              onChange={info.onPlanChange}
              scheduledAtLocal={info.scheduledAtLocal ?? ""}
              markedChoice={c.versions ? c.markedChoice : info.choice}
              allowAbsolute
            />
            <p className="text-xs text-muted-foreground">
              {telegramPlanStorageHint(postStatus)} «Aniq vaqt» tanlansa, post chiqqach ham o&apos;sha paytgacha kutiladi.
            </p>
          </section>
        ) : null}
      </div>
      <aside className="min-w-0 lg:sticky lg:top-0 lg:self-start" aria-label="Oldindan ko'rish">
        <TelegramPreviewCard channelName={c.channelHandle ?? info.channelHandle} preview={preview} loading={loading} />
      </aside>
      <ChannelSendAlerts c={c} />
    </div>
  );
}

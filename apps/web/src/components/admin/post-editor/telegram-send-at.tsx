"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { ChannelStatus } from "@blog/shared";
import { Button } from "@/components/ui/button";
import { AdminApiError, adminApi } from "@/lib/admin-client";
import { absoluteTimeError, canEditSendAt, isoToLocalInput, telegramStatusLine } from "@/lib/distribution-telegram";
import { AbsoluteTimeField } from "./delay-plan-picker";

/**
 * CHOP ETILGAN postni kanalga ANIQ vaqtda yuborish ("Aniq vaqt"): vaqt tanlanadi, server `channel_send_at`ni qo'yadi va mavjud ishchi
 * o'sha paytda yuboradi. Holat qatori ("Kanalga 28.11 14:30 da yuboriladi") va «Bekor qilish». Yuborilgan postda — faqat holat
 * (qayta yuborish alohida tugma orqali).
 */
export function TelegramSendAt({ postId, status, onChanged }: { postId: string; status: ChannelStatus | null; onChanged: () => void }) {
  const [sendAt, setSendAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = sendAt ?? (status?.state === "planned" ? status.sendAt : null);
  const error = shown ? absoluteTimeError(isoToLocalInput(shown)) : null;
  const blocked = !canEditSendAt(status);

  async function run(action: () => Promise<unknown>, done: string) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      toast.success(done);
      setSendAt(null);
      onChanged();
    } catch (e) {
      toast.error(e instanceof AdminApiError ? e.message : "Amal bajarilmadi");
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-2 border-t border-border pt-3" data-testid="dist-telegram-send-at">
      <h3 className="text-sm font-semibold">Kanalga yuborish · aniq vaqt</h3>
      <p className="text-xs text-muted-foreground" data-testid="dist-telegram-status">{telegramStatusLine(status)}</p>
      {blocked ? null : (
        <>
          <AbsoluteTimeField sendAt={shown} onChange={setSendAt} disabled={busy} testId="dist-telegram-absolute" />
          <p className="text-xs text-muted-foreground">Yuborish paytida belgilangan versiya (yo&apos;q bo&apos;lsa standart ko&apos;rinish) olinadi va Telegram cheklovlari qayta tekshiriladi.</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={busy || !sendAt || error !== null} onClick={() => void run(() => adminApi.channelSchedule(postId, sendAt!), "Kanalga yuborish rejalashtirildi")}>
              {status?.state === "planned" ? "Vaqtni o'zgartirish" : "Rejalashtirish"}
            </Button>
            {status?.state === "planned" ? (
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => adminApi.channelScheduleCancel(postId), "Reja bekor qilindi")}>Bekor qilish</Button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

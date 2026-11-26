"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import type { DistributionPostResponse } from "@blog/shared";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AdminApiError, adminApi } from "@/lib/admin-client";
import { ERROR_KIND_TEXT, channelShortName, isHttpsUrl, own, statusPill, trashedItemActions, trashedVisibleItems } from "@/lib/distribution-ui";
import { formatDateTime } from "@/lib/format";
import { cn } from "cn";

function errMsg(e: unknown, fallback: string): string {
  return e instanceof AdminApiError ? e.message : fallback;
}

/**
 * Post savatda: ro'yxat faqat O'QISH uchun (matn tahriri, yuborish va rejalashtirish yo'q). Barcha qatorlar ko'rinadi (qoralama,
 * rejalashtirilgan, tekshirish kerak, yuborilgan). Mumkin amallar: rejalashtirilganni bekor qilish, "tekshirish kerak"ni hal qilish
 * (qayta urinishsiz) va yuborilganni (platforma qo'llasa) olib tashlash.
 */
export function TrashedPanel({ data, onChanged }: { data: DistributionPostResponse; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [resolveUrl, setResolveUrl] = useState<Record<string, string>>({});
  const items = trashedVisibleItems(data.distributions);

  async function run(fn: () => Promise<unknown>, ok: string, fallback: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
    } catch (e) {
      toast.error(errMsg(e, fallback));
    } finally {
      setBusy(false);
      setConfirmId(null);
      await onChanged().catch(() => undefined);
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="dist-trashed">
      <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm">Post savatda. Yangi yuborib yoki rejalashtirib bo&apos;lmaydi; rejalashtirilganni bekor qilish, noma&apos;lum natijani hal qilish va yuborilganlarni platformadan olib tashlash mumkin.</p>
      {items.length === 0 ? <p className="text-sm text-muted-foreground">Bu post hech qaysi tarmoqqa yuborilmagan.</p> : null}
      {items.map((d) => {
        const ch = data.channels.find((c) => c.id === d.provider);
        const act = trashedItemActions(d, ch?.capabilities ?? null);
        const pill = d.removedAt ? { className: statusPill("cancelled").className, label: "Olib tashlangan" } : statusPill(d.status);
        const url = resolveUrl[d.id] ?? "";
        return (
          <div key={d.id} className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2 text-sm" data-testid={`dist-trashed-${d.provider}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {channelShortName(data.channels, d.provider)}
                  <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", pill.className)} data-testid="dist-trashed-status">{pill.label}</span>
                </p>
                {d.status === "scheduled" && d.scheduledAt ? <p className="text-xs text-muted-foreground">Rejalashtirilgan: {formatDateTime(d.scheduledAt)}</p> : null}
                {d.status === "sent" || d.removedAt ? (
                  <p className="text-xs text-muted-foreground">
                    Yuborilgan: {formatDateTime(d.sentAt)}{" "}
                    {d.externalUrl ? <a href={d.externalUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">Postni ko&apos;rish <ExternalLink className="size-3" /></a> : null}
                    {d.removedAt ? " · platformadan olib tashlangan" : ""}
                  </p>
                ) : null}
                {d.status === "failed" || d.status === "needs_checking" ? (
                  <p className="text-xs text-muted-foreground break-words">{own(ERROR_KIND_TEXT, d.lastErrorKind, "Xato")}{d.lastErrorMessage ? ` — ${d.lastErrorMessage}` : ""}</p>
                ) : null}
                {d.status === "sent" && !act.remove && !d.removedAt && ch?.capabilities?.deleteNote ? <p className="text-xs text-muted-foreground">{ch.capabilities.deleteNote}</p> : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {act.cancel ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => adminApi.distributionCancel(d.id), "Bekor qilindi", "Bekor qilib bo'lmadi")}>Bekor qilish</Button> : null}
                {act.remove ? <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => setConfirmId(d.id)}>Platformadan olib tashlash</Button> : null}
              </div>
            </div>
            {act.resolve ? (
              <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 p-2" data-testid="dist-trashed-resolve">
                <p className="text-xs font-medium">Natija noma&apos;lum. Platformada postni qidiring.</p>
                <div className="flex flex-wrap gap-2">
                  <Input aria-label="Post havolasi" placeholder="https://…" value={url} onChange={(e) => setResolveUrl((m) => ({ ...m, [d.id]: e.target.value }))} className="min-w-0 flex-1" />
                  <Button size="sm" disabled={busy || !isHttpsUrl(url)} onClick={() => void run(() => adminApi.distributionResolve(d.id, { action: "mark_sent", url: url.trim() }), "Yuborilgan deb belgilandi", "Hal qilib bo'lmadi")}>Yuborilgan deb belgilash</Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => adminApi.distributionResolve(d.id, { action: "not_posted" }), "Yopildi", "Hal qilib bo'lmadi")}>Platformada yo&apos;q — yopish</Button>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
      <AlertDialog open={confirmId !== null} onOpenChange={(o) => !o && setConfirmId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Platformadan olib tashlansinmi?</AlertDialogTitle>
            <AlertDialogDescription>Ommaviy post o&apos;chiriladi. Bu amalni qaytarib bo&apos;lmaydi.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground" onClick={() => confirmId && void run(() => adminApi.distributionRemove(confirmId), "Olib tashlandi", "Olib tashlab bo'lmadi")}>Olib tashlash</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

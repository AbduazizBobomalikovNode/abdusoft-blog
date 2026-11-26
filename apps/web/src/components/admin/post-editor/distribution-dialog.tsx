"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import type { DistributionChannelDto, DistributionItemDto, DistributionPostResponse, DistributionPreviewResponse, DistributionProviderId } from "@blog/shared";
import { DISTRIBUTION_STATUS_LABELS } from "@blog/shared";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AdminApiError, adminApi } from "@/lib/admin-client";
import {
  ERROR_KIND_TEXT, IMAGE_CHOICE_LABEL, LINK_MODE_LABEL, NO_AUTO_POST_NOTICE, STATUS_TONE, TONE_CLASS, UNIT_LABEL,
  counterView, isFutureEnough, isHttpsUrl, itemActions, localInputToIso, minScheduleInput, textForSave, tokenLine,
} from "@/lib/distribution-ui";
import { formatDateTime } from "@/lib/format";
import { cn } from "cn";

function errMsg(e: unknown, fallback: string): string {
  return e instanceof AdminApiError ? e.message : fallback;
}

const selectClass = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

function StatusPill({ item }: { item: DistributionItemDto | null }) {
  if (!item) return <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", TONE_CLASS.neutral)}>Hali yuborilmagan</span>;
  return <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", TONE_CLASS[STATUS_TONE[item.status]])}>{DISTRIBUTION_STATUS_LABELS[item.status]}</span>;
}

function Checklist({ checks }: { checks: DistributionPreviewResponse["checks"] }) {
  const icon = { ok: "✓", warn: "⚠", error: "✗" } as const;
  const cls = { ok: "text-emerald-600 dark:text-emerald-400", warn: "text-amber-600 dark:text-amber-400", error: "text-destructive" } as const;
  return (
    <ul className="flex flex-col gap-1" data-testid="dist-checklist">
      {checks.map((c) => (
        <li key={c.id} className="flex gap-2 text-sm">
          <span className={cn("w-4 shrink-0 text-center font-semibold", cls[c.status])} aria-hidden>{icon[c.status]}</span>
          <p className="min-w-0 break-words"><span className="font-medium">{c.title}</span><span className="text-muted-foreground"> — {c.message}</span></p>
        </li>
      ))}
    </ul>
  );
}

function ChannelPanel({ postId, channel, item, onChanged }: { postId: string; channel: DistributionChannelDto; item: DistributionItemDto | null; onChanged: () => Promise<void> }) {
  const provider = channel.id as DistributionProviderId;
  const caps = channel.capabilities;
  const isGithub = provider === "github";
  const actions = itemActions(item, channel.ready, caps);
  const [preview, setPreview] = useState<DistributionPreviewResponse | null>(null);
  const [text, setText] = useState("");
  const [touched, setTouched] = useState(false);
  const [imageChoice, setImageChoice] = useState<"auto" | "cover" | "og" | "none">(item?.imageChoice ?? "auto");
  const [linkMode, setLinkMode] = useState<"article" | "text">(item?.linkMode ?? "article");
  const [busy, setBusy] = useState(false);
  const [when, setWhen] = useState("");
  const [confirmSend, setConfirmSend] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [resolveUrl, setResolveUrl] = useState("");
  const [riskOk, setRiskOk] = useState(false);
  const seq = useRef(0);

  const body = useCallback(() => ({ text: isGithub ? undefined : textForSave(text, preview?.defaultText ?? ""), imageChoice, ...(provider === "linkedin" ? { linkMode } : {}) }), [text, preview?.defaultText, imageChoice, linkMode, provider, isGithub]);

  // Oldindan ko'rish: tahrirdan keyin biroz kutib (debounce) tekshiruvlar yangilanadi.
  useEffect(() => {
    const mine = ++seq.current;
    const t = setTimeout(
      async () => {
        try {
          const overrides = touched ? { text: textForSave(text, preview?.defaultText ?? ""), imageChoice, ...(provider === "linkedin" ? { linkMode } : {}) } : { imageChoice, ...(provider === "linkedin" ? { linkMode } : {}) };
          const p = await adminApi.distributionPreview(postId, provider, isGithub ? { imageChoice } : overrides);
          if (mine !== seq.current) return;
          setPreview(p);
          if (!touched) setText(p.text);
        } catch (e) {
          if (mine === seq.current) toast.error(errMsg(e, "Oldindan ko'rib bo'lmadi"));
        }
      },
      touched ? 500 : 0,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- preview.defaultText atayin kuzatilmaydi (aylanma)
  }, [postId, provider, text, touched, imageChoice, linkMode, item?.id, item?.status, item?.updatedAt, isGithub]);

  const counter = counterView(provider, text, caps?.textMax ?? null);
  const blocked = !preview || preview.errorCount > 0 || (!isGithub && counter.level === "over");

  async function run<T>(fn: () => Promise<T>, ok: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      await onChanged();
    } catch (e) {
      if (e instanceof AdminApiError && e.status === 422) toast.error(e.message);
      else toast.error(errMsg(e, "Amal bajarilmadi"));
      await onChanged().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  const again = item?.status === "sent" || preview?.previouslySent ? { again: true } : {};
  const sentAlready = Boolean(preview?.previouslySent) && !isGithub;

  if (channel.readOnly) {
    return <p className="rounded-lg border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">{channel.notReadyReason}</p>;
  }

  return (
    <div className="flex shrink-0 flex-col gap-4" data-testid={`dist-panel-${provider}`}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill item={item} />
        {channel.account ? <span className="text-xs text-muted-foreground">{channel.account.displayName} · {tokenLine(channel.account).text}</span> : null}
      </div>

      {!channel.ready ? (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          {channel.notReadyReason} · <Link href="/admin/sozlamalar?tab=tarqatish" className="underline">Sozlamalar → Tarqatish</Link>
        </p>
      ) : null}

      {item?.status === "failed" || item?.status === "needs_checking" || (item?.status === "scheduled" && item.attempts > 0) ? (
        <div className={cn("rounded-lg px-3 py-2 text-sm", TONE_CLASS[item.status === "failed" ? "danger" : "warn"])} data-testid="dist-error">
          <p className="font-medium">{item.lastErrorKind ? ERROR_KIND_TEXT[item.lastErrorKind] : "Xato"}</p>
          {item.lastErrorMessage ? <p className="mt-0.5 text-xs break-words opacity-90">{item.lastErrorMessage}</p> : null}
          <p className="mt-0.5 text-xs opacity-80">
            Urinishlar: {item.attempts}
            {item.nextAttemptAt ? ` · keyingi: ${formatDateTime(item.nextAttemptAt)}` : ""}
            {item.canResume ? " · to'xtagan joyidan davom etadi" : ""}
          </p>
        </div>
      ) : null}

      {item?.status === "scheduled" && item.scheduledAt ? <p className="text-sm">Rejalashtirilgan: <b>{formatDateTime(item.scheduledAt)}</b></p> : null}
      {item?.status === "sent" ? (
        <p className="text-sm">
          Yuborilgan: {formatDateTime(item.sentAt)}{" "}
          {item.externalUrl ? (
            <a href={item.externalUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">Postni ko&apos;rish <ExternalLink className="size-3" /></a>
          ) : null}
          {item.removedAt ? " · platformadan olib tashlangan" : ""}
        </p>
      ) : null}

      {/* Matn */}
      {isGithub ? (
        <div className="flex flex-col gap-1.5">
          <Label>README&apos;ga yoziladigan blok (so&apos;nggi maqolalar)</Label>
          <pre className="max-h-48 overflow-auto rounded-md bg-muted px-3 py-2 text-xs break-words whitespace-pre-wrap">{preview?.text ?? "…"}</pre>
          <p className="text-xs text-muted-foreground">«Yuborish» README ichidagi markerlar orasini shu ro&apos;yxat bilan almashtiradi (qolgan qism o&apos;zgarmaydi).</p>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={`dist-text-${provider}`}>Matn</Label>
            <span className={cn("text-xs tabular-nums", counter.className)} data-testid="dist-counter" title={caps ? UNIT_LABEL[caps.textUnit] : ""}>{counter.label}</span>
          </div>
          <Textarea id={`dist-text-${provider}`} rows={7} value={text} disabled={!actions.edit || busy} onChange={(e) => { setText(e.target.value); setTouched(true); }} className="min-h-32 text-sm" />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{caps ? UNIT_LABEL[caps.textUnit] : ""}</span>
            {preview && text !== preview.defaultText ? (
              <button type="button" className="underline" disabled={!actions.edit} onClick={() => { setText(preview.defaultText); setTouched(true); }}>Standart matnga qaytarish</button>
            ) : <span>Standart shablon</span>}
          </div>
        </div>
      )}

      {/* Rasm va rejim */}
      {caps?.image ? (
        <div className="grid grid-cols-[6rem_1fr] gap-3 sm:grid-cols-[8rem_1fr]">
          <div className="flex aspect-[1.91/1] items-center justify-center overflow-hidden rounded-md border border-border bg-muted text-xs text-muted-foreground">
            {preview?.image.previewUrl && !preview.image.error ? (
              // eslint-disable-next-line @next/next/no-img-element -- tashqi (OG/muqova) rasm: oldindan ko'rish
              <img src={preview.image.previewUrl} alt="" className="size-full object-cover" onError={(e) => { e.currentTarget.style.display = "none"; }} />
            ) : (
              <span className="px-2 text-center">{preview?.image.error ? "Rasm yo'q" : "Rasmsiz"}</span>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label className="text-xs">Rasm</Label>
            <select className={selectClass} value={imageChoice} disabled={!actions.edit || busy} onChange={(e) => setImageChoice(e.target.value as typeof imageChoice)} aria-label="Rasm tanlovi">
              {(Object.keys(IMAGE_CHOICE_LABEL) as Array<keyof typeof IMAGE_CHOICE_LABEL>).map((k) => <option key={k} value={k}>{IMAGE_CHOICE_LABEL[k]}</option>)}
            </select>
            {preview?.image.width ? <p className="text-xs text-muted-foreground">{preview.image.source === "og" ? "Sayt OG rasmi" : "Muqova"} · {preview.image.width}×{preview.image.height}</p> : null}
            {provider === "linkedin" ? (
              <>
                <Label className="text-xs">LinkedIn post turi</Label>
                <select className={selectClass} value={linkMode} disabled={!actions.edit || busy} onChange={(e) => setLinkMode(e.target.value as typeof linkMode)} aria-label="Havola rejimi">
                  {(Object.keys(LINK_MODE_LABEL) as Array<keyof typeof LINK_MODE_LABEL>).map((k) => <option key={k} value={k}>{LINK_MODE_LABEL[k]}</option>)}
                </select>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {preview ? (
        <div className="flex flex-col gap-1.5">
          <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Tekshiruv</h4>
          <Checklist checks={preview.checks} />
        </div>
      ) : <div className="h-16 animate-pulse rounded-md bg-muted" aria-busy />}

      {sentAlready && actions.send ? <p className="text-xs text-amber-700 dark:text-amber-300">Bu post shu kanalga allaqachon yuborilgan — yana yuborish dublikat yaratadi.</p> : null}

      {/* needs_checking */}
      {actions.resolve && item ? (
        <div className="flex flex-col gap-3 rounded-lg border border-amber-500/40 p-3" data-testid="dist-resolve">
          <p className="text-sm font-medium">Natija noma&apos;lum. Avval platformada postni qidiring.</p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dist-resolve-url" className="text-xs">Post chiqqan bo&apos;lsa — havolasi</Label>
            <div className="flex flex-wrap gap-2">
              <Input id="dist-resolve-url" placeholder="https://…" value={resolveUrl} onChange={(e) => setResolveUrl(e.target.value)} className="min-w-0 flex-1" />
              <Button size="sm" disabled={busy || !isHttpsUrl(resolveUrl)} onClick={() => void run(() => adminApi.distributionResolve(item.id, { action: "mark_sent", url: resolveUrl.trim() }), "Yuborilgan deb belgilandi")}>Yuborilgan deb belgilash</Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => adminApi.distributionResolve(item.id, { action: "not_posted" }), "Yopildi")}>Platformada yo&apos;q — yopish</Button>
            <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={riskOk} onChange={(e) => setRiskOk(e.target.checked)} /> Postning yo&apos;qligini tekshirdim, dublikat xavfini tushundim</label>
            <Button size="sm" variant="outline" disabled={busy || !riskOk} onClick={() => void run(() => adminApi.distributionResolve(item.id, { action: "retry", confirmDuplicateRisk: true }), "Qayta urinish navbatda")}>Bilib turib qayta urinish</Button>
          </div>
        </div>
      ) : null}

      {/* Amallar */}
      <div className="flex flex-col gap-3 border-t border-border pt-3">
        {actions.schedule ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`dist-when-${provider}`} className="text-xs">Rejalashtirish vaqti</Label>
              <Input id={`dist-when-${provider}`} type="datetime-local" min={minScheduleInput()} value={when} onChange={(e) => setWhen(e.target.value)} className="w-auto" />
            </div>
            <Button size="sm" variant="outline" disabled={busy || blocked || !isFutureEnough(localInputToIso(when))} onClick={() => void run(() => adminApi.distributionSchedule(postId, provider, localInputToIso(when)!, { ...body(), ...again }), "Rejalashtirildi")}>Rejalashtirish</Button>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {actions.send || actions.sendAgain ? <Button size="sm" disabled={busy || blocked || !channel.ready} onClick={() => setConfirmSend(true)}>{actions.sendAgain ? "Yana yuborish" : "Yuborish"}</Button> : null}
          {actions.save ? <Button size="sm" variant="outline" disabled={busy || isGithub} onClick={() => void run(() => adminApi.distributionSaveDraft(postId, provider, body()), "Qoralama saqlandi")}>Saqlash</Button> : null}
          {actions.retry && item ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => adminApi.distributionRetry(item.id), "Qayta urinish navbatda")}>Qayta urinish</Button> : null}
          {actions.cancel && item ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => adminApi.distributionCancel(item.id), "Bekor qilindi")}>Bekor qilish</Button> : null}
          {actions.remove && item ? <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => setConfirmRemove(true)}>Platformadan olib tashlash</Button> : null}
        </div>
        {item?.status === "sent" && caps && !caps.delete && caps.deleteNote ? <p className="text-xs text-muted-foreground">{caps.deleteNote}</p> : null}
        {item?.status === "sending" ? <p className="text-xs text-muted-foreground">Yuborilmoqda… (fonda; sahifani yopishingiz mumkin)</p> : null}
      </div>

      <AlertDialog open={confirmSend} onOpenChange={setConfirmSend}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{channel.name}ga yuborilsinmi?</AlertDialogTitle>
            <AlertDialogDescription>Bu OMMAVIY post sizning akkauntingizdan chiqadi. Yuborish fonda bajariladi (bir daqiqagacha). Noaniq natija bo&apos;lsa avtomatik qayta urinilmaydi.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction onClick={() => void run(() => adminApi.distributionSend(postId, provider, { ...body(), ...again }), "Yuborish navbatga qo'yildi")}>Yuborish</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Platformadan olib tashlansinmi?</AlertDialogTitle>
            <AlertDialogDescription>Ommaviy post o&apos;chiriladi. Bu amalni qaytarib bo&apos;lmaydi.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground" onClick={() => item && void run(() => adminApi.distributionRemove(item.id), "Olib tashlandi")}>Olib tashlash</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Post savatda: faqat O'QISH. Avval yuborilganlar ko'rinadi va (platforma qo'llasa) olib tashlash mumkin; matn tahriri,
 * yuborish va rejalashtirish yo'q.
 */
function TrashedPanel({ data, onChanged }: { data: DistributionPostResponse; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const sent = data.distributions.filter((d) => d.status === "sent" || d.removedAt);
  async function remove(id: string) {
    setBusy(true);
    try {
      await adminApi.distributionRemove(id);
      toast.success("Olib tashlandi");
    } catch (e) {
      toast.error(errMsg(e, "Olib tashlab bo'lmadi"));
    } finally {
      setBusy(false);
      setConfirmId(null);
      await onChanged().catch(() => undefined);
    }
  }
  return (
    <div className="flex flex-col gap-3" data-testid="dist-trashed">
      <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm">Post savatda. Yangi yuborib bo&apos;lmaydi; avval yuborilganlarni platformadan olib tashlash mumkin.</p>
      {sent.length === 0 ? <p className="text-sm text-muted-foreground">Bu post hech qaysi tarmoqqa yuborilmagan.</p> : null}
      {sent.map((d) => {
        const ch = data.channels.find((c) => c.id === d.provider);
        const can = itemActions(d, false, ch?.capabilities ?? null).remove;
        return (
          <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm" data-testid={`dist-trashed-${d.provider}`}>
            <div className="min-w-0">
              <p className="font-medium">{ch?.name ?? d.provider}</p>
              <p className="text-xs text-muted-foreground">
                Yuborilgan: {formatDateTime(d.sentAt)}{" "}
                {d.externalUrl ? <a href={d.externalUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">Postni ko&apos;rish <ExternalLink className="size-3" /></a> : null}
                {d.removedAt ? " · platformadan olib tashlangan" : ""}
              </p>
              {!can && !d.removedAt && ch?.capabilities?.deleteNote ? <p className="text-xs text-muted-foreground">{ch.capabilities.deleteNote}</p> : null}
            </div>
            {can ? <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => setConfirmId(d.id)}>Platformadan olib tashlash</Button> : null}
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
            <AlertDialogAction className="bg-destructive text-destructive-foreground" onClick={() => confirmId && void remove(confirmId)}>Olib tashlash</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Post tahrirlagichidagi "Tarqatish" dialogi (Telegram yuborish dialogi yonida). Faqat bayroq yoqilganda ochiladi. */
export function DistributionDialog({ postId, open, onOpenChange }: { postId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [data, setData] = useState<DistributionPostResponse | null>(null);
  const [active, setActive] = useState<DistributionProviderId>("linkedin");

  const load = useCallback(async () => {
    setData(await adminApi.distributionForPost(postId));
  }, [postId]);

  useEffect(() => {
    if (!open) return;
    adminApi
      .distributionForPost(postId)
      .then(setData)
      .catch((e) => toast.error(errMsg(e, "Tarqatish ma'lumotini yuklab bo'lmadi")));
  }, [open, postId]);

  // "Yuborilmoqda/rejalashtirilgan" holatlar fonda o'zgaradi — ochiq dialog holatni vaqti-vaqti bilan yangilaydi.
  useEffect(() => {
    if (!open || !data?.distributions.some((d) => d.status === "sending" || d.status === "scheduled")) return;
    const t = setInterval(() => void load().catch(() => undefined), 8000);
    return () => clearInterval(t);
  }, [open, data, load]);

  const channel = data?.channels.find((c) => c.id === active);
  const itemFor = (id: string) => data?.distributions.find((d) => d.provider === id && ["draft", "scheduled", "sending", "failed", "needs_checking"].includes(d.status)) ?? data?.distributions.find((d) => d.provider === id && d.status === "sent") ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton className="flex max-h-[90vh] w-full max-w-2xl flex-col gap-4 overflow-y-auto sm:max-w-3xl max-sm:fixed max-sm:inset-0 max-sm:h-dvh max-sm:max-h-none max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none">
        <DialogHeader>
          <DialogTitle>Tarqatish</DialogTitle>
        </DialogHeader>
        <p className="shrink-0 rounded-lg bg-sky-500/10 px-3 py-2 text-xs" data-testid="dist-dialog-notice">{NO_AUTO_POST_NOTICE}</p>
        {!data ? <div className="h-40 animate-pulse rounded-md bg-muted" aria-busy /> : data.postDeleted ? (
          <TrashedPanel data={data} onChanged={load} />
        ) : (
          <>
            <div className="flex shrink-0 gap-1 overflow-x-auto rounded-lg bg-muted p-1" role="tablist">
              {data.channels.map((c) => {
                const it = itemFor(c.id);
                return (
                  <button key={c.id} type="button" role="tab" aria-selected={active === c.id} onClick={() => setActive(c.id as DistributionProviderId)}
                    className={cn("flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium", active === c.id ? "bg-background shadow-sm" : "text-muted-foreground")}>
                    {c.name.replace(/ \(.*\)/, "")}
                    <span className={cn("size-1.5 rounded-full", it ? { sent: "bg-emerald-500", failed: "bg-destructive", needs_checking: "bg-amber-500", scheduled: "bg-sky-500", sending: "bg-sky-500", draft: "bg-muted-foreground", cancelled: "bg-muted-foreground/40" }[it.status] : c.ready ? "bg-muted-foreground/30" : "bg-transparent")} />
                  </button>
                );
              })}
            </div>
            {channel ? <ChannelPanel key={`${channel.id}-${itemFor(channel.id)?.id ?? "new"}-${itemFor(channel.id)?.status ?? ""}`} postId={postId} channel={channel} item={itemFor(channel.id)} onChanged={load} /> : null}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

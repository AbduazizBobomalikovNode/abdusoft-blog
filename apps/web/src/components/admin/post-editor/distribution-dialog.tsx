"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { splitXThread, type AdminPostStatus, type ChannelStatus, DistributionChannelDto, DistributionChannelId, DistributionItemDto, DistributionPostResponse, DistributionPreviewResponse, DistributionProviderId, DistributionVersionDto } from "@blog/shared";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AdminApiError, adminApi } from "@/lib/admin-client";
import {
  ERROR_KIND_TEXT, IMAGE_CHOICE_LABEL, LINK_MODE_LABEL, NO_AUTO_POST_NOTICE, TONE_CLASS, UNIT_LABEL,
  counterDetail, counterView, threadCounterView, isFutureEnough, isHttpsUrl, itemActions, localInputToIso, minScheduleInput, own, statusPill, textForSave, tokenLine,
} from "@/lib/distribution-ui";
import { PLAN_STATE_LABEL, canPlanForPost, isWaitingPlan, planPhrase, planStateOf } from "@/lib/distribution-plan";
import { telegramDotTone } from "@/lib/distribution-telegram";
import { DelayPlanPicker } from "./delay-plan-picker";
import { initialVersionId, isVersionDirty, markPrimary, removeVersion, replaceVersion, versionsOf, type VersionSaveState } from "@/lib/distribution-versions";
import { DistributionVersionStrip } from "./distribution-version-strip";
import { TrashedPanel } from "./distribution-trashed-panel";
import { SocialPreview } from "./social-preview";
import { DistributionTelegramPanel, type DistributionTelegramInfo } from "./distribution-telegram-panel";
import { domainOf } from "./social-preview/text";
import { formatDateTime } from "@/lib/format";
import { cn } from "cn";

function errMsg(e: unknown, fallback: string): string {
  return e instanceof AdminApiError ? e.message : fallback;
}

const STATUS_DOT: Record<string, string> = { sent: "bg-emerald-500", failed: "bg-destructive", needs_checking: "bg-amber-500", scheduled: "bg-sky-500", sending: "bg-sky-500", draft: "bg-muted-foreground", cancelled: "bg-muted-foreground/40" };

const TELEGRAM_DOT: Record<"planned" | "sending" | "sent", string> = { planned: "bg-violet-500", sending: "bg-sky-500", sent: "bg-emerald-500" };
const TELEGRAM_DOT_TITLE: Record<"planned" | "sending" | "sent", string> = { planned: "Telegram: kanalga yuborish rejalashtirilgan", sending: "Telegram: yuborilmoqda", sent: "Telegram: kanalga yuborilgan" };

const selectClass = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

function StatusPill({ item }: { item: DistributionItemDto | null }) {
  if (!item) return <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", TONE_CLASS.neutral)}>Hali yuborilmagan</span>;
  const pill = statusPill(item.status);
  return <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", pill.className)}>{pill.label}</span>;
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

function ChannelPanel({ postId, postStatus, channel, item, initialVersions, onChanged }: { postId: string; postStatus: AdminPostStatus; channel: DistributionChannelDto; item: DistributionItemDto | null; initialVersions: DistributionVersionDto[]; onChanged: () => Promise<void> }) {
  const provider = channel.id as DistributionProviderId;
  const caps = channel.capabilities;
  const isGithub = provider === "github";
  const postPublished = postStatus === "published";
  const baseActions = itemActions(item, channel.ready, caps);
  // Chop etilmagan postda darhol yuborish/aniq vaqt yo'q (server ham rad etadi): faqat "Saytga chiqqach" rejasi.
  const actions = postPublished ? baseActions : { ...baseActions, send: false, schedule: false, sendAgain: false };
  const canPlan = !postPublished && canPlanForPost(postStatus) && baseActions.edit && (item === null || item.status === "draft");
  const planState = planStateOf(item);
  const [delay, setDelay] = useState(() => item?.planDelayMinutes ?? 15);
    const [versions, setVersions] = useState<DistributionVersionDto[]>(() => (isGithub ? [] : versionsOf(initialVersions, provider)));
  // Dialog asosiy versiyada ochiladi (bo'lsa va qator tahrirlanadigan bo'lsa); aks holda avvalgidek "Standart".
  const [selectedId, setSelectedId] = useState<string | null>(() => (isGithub ? null : initialVersionId(versions, item, actions.edit)));
  const startVersion = versions.find((v) => v.id === selectedId) ?? null;
  const [saveState, setSaveState] = useState<VersionSaveState>("idle");
  const [preview, setPreview] = useState<DistributionPreviewResponse | null>(null);
  const [text, setText] = useState(startVersion?.text ?? "");
  const [touched, setTouched] = useState(Boolean(startVersion));
  const [imageChoice, setImageChoice] = useState<"auto" | "cover" | "og" | "none">(startVersion?.imageChoice ?? item?.imageChoice ?? "auto");
  const [linkMode, setLinkMode] = useState<"article" | "text">(startVersion?.linkMode ?? item?.linkMode ?? "article");
  // X zanjiri (thread): faqat X, standart o'chiq (bitta tvit). Versiyaga EMAS, qatorga saqlanadi.
  const isX = provider === "x";
  const [xThread, setXThread] = useState(Boolean(item?.xThread));
  const [xThreadNumbering, setXThreadNumbering] = useState(Boolean(item?.xThreadNumbering));
  // Zanjirning bir qismi allaqachon platformada: matn va rejim muzlatilgan (qayta urinish qolgan qismlardan davom etadi).
  const threadFrozen = isX && (item?.threadPosted ?? 0) > 0 && item?.status !== "sent";
  const xModeBody = useMemo(() => (isX ? { xThread, xThreadNumbering } : {}), [isX, xThread, xThreadNumbering]);
  const [busy, setBusy] = useState(false);
  const [when, setWhen] = useState("");
  const [confirmSend, setConfirmSend] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [resolveUrl, setResolveUrl] = useState("");
  const [riskOk, setRiskOk] = useState(false);
  const seq = useRef(0);
  const savingRef = useRef(false);
  const selected = versions.find((v) => v.id === selectedId) ?? null;

  const body = useCallback(() => ({ text: isGithub ? undefined : textForSave(text, preview?.defaultText ?? ""), imageChoice, ...(provider === "linkedin" ? { linkMode } : {}), ...xModeBody }), [text, preview?.defaultText, imageChoice, linkMode, provider, isGithub, xModeBody]);

  // Oldindan ko'rish: tahrirdan keyin biroz kutib (debounce) tekshiruvlar yangilanadi.
  useEffect(() => {
    const mine = ++seq.current;
    const t = setTimeout(
      async () => {
        try {
          const overrides = touched ? { text: textForSave(text, preview?.defaultText ?? ""), imageChoice, ...(provider === "linkedin" ? { linkMode } : {}), ...xModeBody } : { imageChoice, ...(provider === "linkedin" ? { linkMode } : {}), ...xModeBody };
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
  }, [postId, provider, text, touched, imageChoice, linkMode, item?.id, item?.status, item?.updatedAt, isGithub, xModeBody]);

  // Tanlangan versiya: tahrirdan 800 ms keyin avtomatik saqlanadi (Telegram versiya tahrirlagichidagidek).
  useEffect(() => {
    if (!selected || !actions.edit) return;
    const editor = { text, imageChoice, linkMode: provider === "linkedin" ? linkMode : null };
    if (!isVersionDirty(selected, editor)) return;
    const t = setTimeout(async () => {
      if (savingRef.current) return;
      savingRef.current = true;
      setSaveState("saving");
      try {
        const updated = await adminApi.distributionVersionUpdate(selected.id, { text: editor.text, imageChoice: editor.imageChoice, ...(provider === "linkedin" ? { linkMode: editor.linkMode } : {}), expectedUpdatedAt: selected.updatedAt });
        setVersions((list) => replaceVersion(list, updated));
        setSaveState("saved");
      } catch (e) {
        setSaveState("error");
        toast.error(errMsg(e, "Versiyani saqlab bo'lmadi"));
        if (e instanceof AdminApiError && e.status === 409) {
          const fresh = await adminApi.distributionVersions(postId, provider).catch(() => null);
          if (fresh) setVersions(fresh.versions);
        }
      } finally {
        savingRef.current = false;
      }
    }, 800);
    return () => clearTimeout(t);
  }, [selected, actions.edit, text, imageChoice, linkMode, provider, postId]);

  function chooseVersion(id: string | null) {
    setSelectedId(id);
    setSaveState("idle");
    setTouched(true);
    const v = versions.find((x) => x.id === id);
    if (v) {
      setText(v.text);
      setImageChoice(v.imageChoice);
      if (provider === "linkedin") setLinkMode(v.linkMode ?? "article");
    } else if (preview) {
      setText(preview.defaultText);
    }
  }

  async function versionOp<T>(fn: () => Promise<T>, apply: (r: T) => void, fallback: string) {
    try {
      apply(await fn());
    } catch (e) {
      toast.error(errMsg(e, fallback));
    }
  }

  const createVersion = () =>
    versionOp(
      () => adminApi.distributionVersionCreate(postId, provider, { text, imageChoice, ...(provider === "linkedin" ? { linkMode } : {}) }),
      (created) => { setVersions((l) => [...l, created]); setSelectedId(created.id); setSaveState("idle"); },
      "Versiya yaratib bo'lmadi",
    );
  const renameVersion = (id: string, name: string) =>
    versionOp(() => adminApi.distributionVersionUpdate(id, { name }), (u) => setVersions((l) => replaceVersion(l, u)), "Nomini o'zgartirib bo'lmadi");
  const primaryVersion = (id: string) =>
    versionOp(() => adminApi.distributionVersionPrimary(id), (u) => setVersions((l) => markPrimary(l, u.id)), "Asosiy qilib bo'lmadi");
  const clearPrimary = () =>
    versionOp(() => adminApi.distributionPrimaryClear(postId, provider), () => setVersions((l) => markPrimary(l, null)), "Asosiylikni olib tashlab bo'lmadi");
  const deleteVersion = (id: string) =>
    versionOp(
      () => adminApi.distributionVersionDelete(id),
      () => { setVersions((l) => removeVersion(l, id)); chooseVersion(null); },
      "Versiyani o'chirib bo'lmadi",
    );

  // Zanjir: web ko'rinishi ham, API yuborishi ham BIR XIL `splitXThread` (packages/shared) dan; chegara har bir tvitga alohida.
  const thread = useMemo(() => (isX && xThread ? splitXThread(text, { numbering: xThreadNumbering }) : null), [isX, xThread, xThreadNumbering, text]);
  const counter = thread ? threadCounterView(thread) : counterView(provider, text, caps?.textMax ?? null);
  const blocked = !preview || preview.errorCount > 0 || (!isGithub && counter.level === "over");
  // Reja uchun "post chop etilgan" tekshiruvi kutilmagan emas (hali chop etilmagan) — yuborish paytida baribir qayta tekshiriladi.
  const shownChecks = preview ? (postPublished ? preview.checks : preview.checks.filter((c) => c.id !== "dist.published")) : [];
  const planBlocked = !preview || shownChecks.some((c) => c.status === "error") || (!isGithub && counter.level === "over");

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

  /** Yuborish/rejalashtirish tanasi: tanlangan versiya id'si faqat qayd uchun (matn baribir tahrirlagichdagi matn). */
  const queueBody = () => ({ ...body(), ...(selectedId ? { versionId: selectedId } : {}) });
  const again = item?.status === "sent" || preview?.previouslySent ? { again: true } : {};
  const sentAlready = Boolean(preview?.previouslySent) && !isGithub;

  if (channel.readOnly) {
    return <p className="rounded-lg border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">{channel.notReadyReason}</p>;
  }

  const siteName = domainOf(preview?.postUrl ?? "") || "Blog";
  const previewModel = {
    provider,
    text: isGithub ? (preview?.text ?? "") : text,
    limit: isGithub ? null : (caps?.textMax ?? null),
    authorName: channel.account?.displayName ?? siteName,
    authorHandle: channel.account?.username ? `@${channel.account.username.replace(/^@/, "")}` : null,
    postUrl: preview?.postUrl ?? "",
    postTitle: preview?.postTitle ?? "",
    imageUrl: caps?.image && imageChoice !== "none" && preview?.image.previewUrl && !preview.image.error ? preview.image.previewUrl : null,
    linkMode: provider === "linkedin" ? linkMode : null,
    thread,
  } as const;

  return (
    <div className="grid shrink-0 gap-5 lg:grid-cols-2" data-testid={`dist-panel-${provider}`}>
    <div className="flex min-w-0 flex-col gap-4">
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
          <p className="font-medium">{own(ERROR_KIND_TEXT, item.lastErrorKind, "Xato")}</p>
          {item.lastErrorMessage ? <p className="mt-0.5 text-xs break-words opacity-90">{item.lastErrorMessage}</p> : null}
          <p className="mt-0.5 text-xs opacity-80">
            Urinishlar: {item.attempts}
            {item.nextAttemptAt ? ` · keyingi: ${formatDateTime(item.nextAttemptAt)}` : ""}
            {item.canResume ? " · to'xtagan joyidan davom etadi" : ""}
          </p>
        </div>
      ) : null}

      {planState !== "none" && item?.planDelayMinutes != null ? (
        <p className="rounded-lg bg-violet-500/10 px-3 py-2 text-sm" data-testid="dist-plan-state">
          Reja: <b>{planPhrase(item.planDelayMinutes)}</b> · {PLAN_STATE_LABEL[planState]}
        </p>
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
          <p className="text-xs text-muted-foreground">«Yuborish» README ichidagi markerlar orasini shu ro&apos;yxat bilan almashtiradi (qolgan qism o&apos;zgarmaydi).</p>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <DistributionVersionStrip versions={versions} selectedId={selectedId} disabled={!actions.edit || busy} saveState={saveState}
            onSelect={chooseVersion} onCreate={() => void createVersion()} onRename={(id, name) => void renameVersion(id, name)}
            onSetPrimary={(id) => void primaryVersion(id)} onClearPrimary={() => void clearPrimary()} onDelete={(id) => void deleteVersion(id)} />
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={`dist-text-${provider}`}>Matn</Label>
            <span className={cn("text-xs tabular-nums", counter.className)} data-testid="dist-counter" title={caps ? own(UNIT_LABEL, caps.textUnit, "") : ""}>{counter.label}</span>
          </div>
          <Textarea id={`dist-text-${provider}`} rows={7} value={text} disabled={!actions.edit || busy || threadFrozen} onChange={(e) => { setText(e.target.value); setTouched(true); }} className="min-h-32 text-sm" />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{caps ? counterDetail(caps.textUnit, "remaining" in counter ? counter : { remaining: null }) : ""}</span>
            {preview && text !== preview.defaultText ? (
              <button type="button" className="underline" disabled={!actions.edit} onClick={() => { setText(preview.defaultText); setTouched(true); }}>Standart matnga qaytarish</button>
            ) : <span>Standart shablon</span>}
          </div>
        </div>
      )}

      {/* X zanjiri (thread) */}
      {isX ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3" data-testid="dist-x-thread">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={xThread} disabled={!actions.edit || busy || threadFrozen} onChange={(e) => setXThread(e.target.checked)} data-testid="dist-x-thread-toggle" />
            <span>
              <span className="font-medium">Zanjir (thread)</span>
              <span className="block text-xs text-muted-foreground">Matn ketma-ket javob tvitlariga bo&apos;linadi: «---» satri — yangi tvit; 280 dan uzun qism o&apos;zi bo&apos;linadi (ko&apos;pi bilan {thread?.maxParts ?? 15} ta). O&apos;chiq bo&apos;lsa — bitta tvit.</span>
            </span>
          </label>
          {xThread ? (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5" checked={xThreadNumbering} disabled={!actions.edit || busy || threadFrozen} onChange={(e) => setXThreadNumbering(e.target.checked)} data-testid="dist-x-thread-numbering" />
              <span>Raqamlash (« 1/n » har bir tvit oxiriga; hisobga olinadi)</span>
            </label>
          ) : null}
          {threadFrozen ? <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="dist-x-thread-frozen">Zanjirning {item?.threadPosted} ta tvitu allaqachon platformada — matn va rejim o&apos;zgarmaydi, qayta urinish qolgan qismdan davom etadi.</p> : null}
        </div>
      ) : null}

      {/* Rasm va rejim */}
      {caps?.image ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label className="text-xs">Rasm</Label>
            <select className={selectClass} value={imageChoice} disabled={!actions.edit || busy} onChange={(e) => setImageChoice(e.target.value as typeof imageChoice)} aria-label="Rasm tanlovi">
              {(Object.keys(IMAGE_CHOICE_LABEL) as Array<keyof typeof IMAGE_CHOICE_LABEL>).map((k) => <option key={k} value={k}>{IMAGE_CHOICE_LABEL[k]}</option>)}
            </select>
            {preview?.image.width ? <p className="text-xs text-muted-foreground">{preview.image.source === "og" ? "Sayt OG rasmi" : "Muqova"} · {preview.image.width}×{preview.image.height}</p> : null}
            {preview?.image.error ? <p className="text-xs text-amber-700 dark:text-amber-300">{preview.image.error}</p> : preview && !preview.image.previewUrl ? <p className="text-xs text-muted-foreground">Rasmsiz</p> : null}
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
          <Checklist checks={shownChecks} />
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
        {actions.schedule || canPlan ? (
          <div className="inline-flex w-fit rounded-lg bg-muted p-1" role="group" aria-label="Rejalashtirish rejimi" data-testid="dist-mode-toggle">
            <span className={cn("rounded-md px-2.5 py-1 text-xs font-medium", !postPublished ? "bg-background shadow-sm" : "cursor-not-allowed text-muted-foreground/60")} title={postPublished ? "Post chop etilgan — «Aniq vaqt» ishlating" : undefined} aria-pressed={!postPublished} data-testid="dist-mode-relative">Saytga chiqqach</span>
            <span className={cn("rounded-md px-2.5 py-1 text-xs font-medium", postPublished ? "bg-background shadow-sm" : "cursor-not-allowed text-muted-foreground/60")} title={postPublished ? undefined : "Aniq vaqt post chop etilgandan keyin ochiladi"} aria-pressed={postPublished} data-testid="dist-mode-absolute">Aniq vaqt</span>
          </div>
        ) : null}
        {canPlan ? (
          <div className="flex flex-col gap-2">
            <DelayPlanPicker value={delay} onChange={setDelay} disabled={busy} hint={<>Matn shu paytdagi tanlangan versiyadan olinadi va o&apos;sha paytda qayta tekshiriladi; o&apos;tmasa «Xato» bo&apos;ladi.</>} />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={busy || planBlocked} onClick={() => void run(() => adminApi.distributionSetPlan(postId, provider, { ...queueBody(), delayMinutes: delay }), "Reja saqlandi")}>{item?.planDelayMinutes != null ? "Rejani yangilash" : "Rejani saqlash"}</Button>
              {item?.planDelayMinutes != null ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => adminApi.distributionClearPlan(postId, provider), "Reja olib tashlandi")}>Rejani olib tashlash</Button> : null}
            </div>
          </div>
        ) : null}
        {actions.schedule ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`dist-when-${provider}`} className="text-xs">Rejalashtirish vaqti</Label>
              <Input id={`dist-when-${provider}`} type="datetime-local" min={minScheduleInput()} value={when} onChange={(e) => setWhen(e.target.value)} className="w-auto" />
            </div>
            <Button size="sm" variant="outline" disabled={busy || blocked || !isFutureEnough(localInputToIso(when))} onClick={() => void run(() => adminApi.distributionSchedule(postId, provider, localInputToIso(when)!, { ...queueBody(), ...again }), "Rejalashtirildi")}>Rejalashtirish</Button>
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
            <AlertDialogAction onClick={() => void run(() => adminApi.distributionSend(postId, provider, { ...queueBody(), ...again }), "Yuborish navbatga qo'yildi")}>Yuborish</AlertDialogAction>
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
    <aside className="min-w-0 lg:sticky lg:top-0 lg:self-start" aria-label="Oldindan ko'rish">
      {preview ? <SocialPreview model={previewModel} /> : <div className="h-40 animate-pulse rounded-md bg-muted" aria-busy />}
    </aside>
    </div>
  );
}

/** Post tahrirlagichidagi "Tarqatish" dialogi (Telegram yuborish dialogi yonida). Faqat bayroq yoqilganda ochiladi. */
export function DistributionDialog({ postId, open, onOpenChange, postStatus = "published", telegram, openTab }: { postId: string; open: boolean; onOpenChange: (o: boolean) => void; postStatus?: AdminPostStatus; /** Ixtiyoriy: berilsa Telegram yorlig'i to'liq panel (tahrir, ko'rinish, tekshiruv, yuborish, reja); berilmasa eski salt o'qish matni qoladi. */ telegram?: DistributionTelegramInfo; /** Ixtiyoriy: dialog ochilganda qaysi yorliq tanlansin (masalan "telegram"); berilmasa oxirgi tanlangani. */ openTab?: DistributionChannelId }) {
  const [data, setData] = useState<DistributionPostResponse | null>(null);
  const [active, setActive] = useState<DistributionChannelId>(openTab ?? "linkedin");

  // Tashqaridan (masalan "Nashr" kartasidagi "Tarqatishda sozlash") so'ralgan yorliq dialog ochilganda tanlanadi.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- ochilish paytida tashqi so'rovni holatga ko'chirish
    if (open && openTab) setActive(openTab);
  }, [open, openTab]);

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

  // Telegram holati (faqat o'qish; `posts` + `telegram_refs`) — tarqatish jadvallariga bog'liq emas. Faqat Telegram paneli berilganda.
  const [tgStatus, setTgStatus] = useState<ChannelStatus | null | undefined>(telegram ? null : undefined);
  const loadTgStatus = useCallback(async () => {
    setTgStatus(await adminApi.channelStatus(postId));
  }, [postId]);
  const hasTelegram = Boolean(telegram);
  useEffect(() => {
    if (!open || !hasTelegram) return;
    adminApi.channelStatus(postId).then(setTgStatus).catch(() => undefined);
  }, [open, hasTelegram, postId]);
  // Kutayotgan/yuborilayotgan reja fonda bajariladi — ochiq dialog holatni yangilab turadi.
  const tgActive = tgStatus?.state === "planned" || tgStatus?.state === "sending";
  useEffect(() => {
    if (!open || !hasTelegram || !tgActive) return;
    const t = setInterval(() => void loadTgStatus().catch(() => undefined), 15000);
    return () => clearInterval(t);
  }, [open, hasTelegram, tgActive, loadTgStatus]);
  const telegramInfo = telegram ? { ...telegram, status: tgStatus, onStatusRefresh: () => void loadTgStatus().catch(() => undefined) } : undefined;
  const tgTone = telegramDotTone(tgStatus ?? null);

  const channel = data?.channels.find((c) => c.id === active);
  const itemFor = (id: string) => data?.distributions.find((d) => d.provider === id && ["draft", "scheduled", "sending", "failed", "needs_checking"].includes(d.status)) ?? data?.distributions.find((d) => d.provider === id && d.status === "sent") ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton className="flex max-h-[90vh] w-full max-w-2xl flex-col gap-4 overflow-y-auto sm:max-w-3xl lg:max-w-5xl max-sm:fixed max-sm:inset-0 max-sm:h-dvh max-sm:max-h-none max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none">
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
                  <button key={c.id} type="button" role="tab" aria-selected={active === c.id} onClick={() => setActive(c.id)}
                    className={cn("flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium", active === c.id ? "bg-background shadow-sm" : "text-muted-foreground")}>
                    {c.name.replace(/ \(.*\)/, "")}
                    <span className={cn("size-1.5 rounded-full", c.id === "telegram" && tgTone ? TELEGRAM_DOT[tgTone] : isWaitingPlan(it) ? "bg-violet-500" : it ? own(STATUS_DOT, it.status, "bg-muted-foreground") : c.ready ? "bg-muted-foreground/30" : "bg-transparent")} title={c.id === "telegram" && tgTone ? TELEGRAM_DOT_TITLE[tgTone] : isWaitingPlan(it) ? "Reja: post chop etilishini kutmoqda" : undefined} data-testid={c.id === "telegram" && tgTone ? "dist-tab-telegram-dot" : isWaitingPlan(it) ? "dist-tab-plan-dot" : undefined} />
                  </button>
                );
              })}
            </div>
            {channel?.readOnly && channel.id === "telegram" && telegram ? (
              <DistributionTelegramPanel postId={postId} postStatus={postStatus} info={telegramInfo ?? telegram} />
            ) : channel ? <ChannelPanel key={`${channel.id}-${itemFor(channel.id)?.id ?? "new"}-${itemFor(channel.id)?.status ?? ""}-${postStatus}`} postId={postId} postStatus={postStatus} channel={channel} item={itemFor(channel.id)} initialVersions={data.versions ?? []} onChanged={load} /> : null}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

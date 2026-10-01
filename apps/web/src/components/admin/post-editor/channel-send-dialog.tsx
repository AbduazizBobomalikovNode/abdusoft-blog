"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type {
  ChannelMode,
  ChannelPreflightResponse,
  ChannelPreviewResponse,
  ChannelSelection,
  ChannelVariant,
  ChannelVersion,
  ChannelVersionsResponse,
  ResolvedChannelChoice,
} from "@blog/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AdminApiError, adminApi } from "@/lib/admin-client";
import { formatDateTime } from "@/lib/format";
import { cn } from "cn";
import { ChannelChecklist } from "./channel-checklist";
import { MODE_LABELS, MODE_OPTIONS, TelegramPreviewCard, VARIANT_LABELS, VARIANTS_BY_MODE } from "./channel-preview";
import { ChannelVersionEditor } from "./channel-version-editor";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof AdminApiError ? error.message : fallback;
}

type Step = 1 | 2 | 3;
type Choice = { kind: "auto"; mode: ChannelMode; variant: ChannelVariant } | { kind: "version"; id: string };

/**
 * `send` — chop etilgan post (admin): yuborish tugmasi bor. `prepare` — chop etilmagan post (admin): faqat tayyorlash va
 * "Asosiy qilib belgilash". `suggest` — xodim: yuborish YO'Q, faqat "Taklif sifatida belgilash".
 */
export type ChannelDialogMode = "send" | "prepare" | "suggest";

function stepLabels(mode: ChannelDialogMode): { value: Step; label: string }[] {
  return [
    { value: 1, label: "Versiya" },
    { value: 2, label: "Tahrirlash" },
    { value: 3, label: mode === "send" ? "Tekshiruv va yuborish" : "Tekshiruv va belgilash" },
  ];
}

function choiceFromResolved(resolved: ResolvedChannelChoice["choice"]): Choice {
  return resolved.kind === "version"
    ? { kind: "version", id: resolved.versionId }
    : { kind: "auto", mode: resolved.mode, variant: resolved.variant };
}

function sameChoice(resolved: ResolvedChannelChoice["choice"] | null | undefined, choice: Choice): boolean {
  if (!resolved) return false;
  if (resolved.kind === "version") return choice.kind === "version" && choice.id === resolved.versionId;
  return choice.kind === "auto" && choice.mode === resolved.mode && choice.variant === resolved.variant;
}

function toSelection(choice: Choice): ChannelSelection {
  return choice.kind === "auto" ? { mode: choice.mode, variant: choice.variant } : { versionId: choice.id };
}

/**
 * "Kanalga yuborish" dialogi — 3 qadam: 1) Versiya (avtomatik yoki "Mening versiyalarim"),
 * 2) Tahrirlash (faqat maxsus versiya), 3) Tekshiruv va yuborish (Telegram cheklovlari).
 * BOSHQARILADIGAN (controlled) komponent: chaqiruvchi o'z tugmasini render qiladi.
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
  const sending_ = dialogMode === "send";
  const [marking, setMarking] = useState(false);
  const onChoiceChangeRef = useRef(onChoiceChange);
  useEffect(() => {
    onChoiceChangeRef.current = onChoiceChange;
  }, [onChoiceChange]);
  const [step, setStep] = useState<Step>(1);
  const [choice, setChoice] = useState<Choice>({ kind: "auto", mode: "media", variant: "m" });
  const [canUseMedia, setCanUseMedia] = useState<boolean | null>(null);
  const [versions, setVersions] = useState<ChannelVersionsResponse | null>(null);
  const [preview, setPreview] = useState<ChannelPreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [preflight, setPreflight] = useState<ChannelPreflightResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [ack, setAck] = useState(false);
  const [sending, setSending] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [channelHandle, setChannelHandle] = useState<string | null>(null);
  const [confirmReplaceOpen, setConfirmReplaceOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ChannelVersion | null>(null);
  const flushRef = useRef<(() => Promise<boolean>) | null>(null);
  const registerFlush = useCallback((flush: (() => Promise<boolean>) | null) => {
    flushRef.current = flush;
  }, []);
  // Eskirgan javoblar yangisini bosib ketmasligi uchun (tez-tez almashtirishda) — oxirgi so'rov g'olib.
  const previewSeq = useRef(0);
  const preflightSeq = useRef(0);
  const choiceRef = useRef<Choice>(choice);
  useEffect(() => {
    choiceRef.current = choice;
  }, [choice]);

  const selectedVersion = choice.kind === "version" ? (versions?.versions.find((v) => v.id === choice.id) ?? null) : null;

  const loadVersions = useCallback(async () => {
    try {
      const data = await adminApi.listChannelVersions(postId);
      setVersions(data);
      onChoiceChangeRef.current?.(data.choice);
      return data;
    } catch (error) {
      toast.error(errorMessage(error, "Versiyalarni yuklab bo'lmadi"));
      return null;
    }
  }, [postId]);

  const loadPreview = useCallback(
    async (selection: ChannelSelection) => {
      const seq = ++previewSeq.current;
      setLoading(true);
      try {
        const data = await adminApi.channelPreview(postId, selection);
        if (seq === previewSeq.current) setPreview(data);
      } catch (error) {
        if (seq === previewSeq.current) toast.error(errorMessage(error, "Oldindan ko'rishni yuklab bo'lmadi"));
      } finally {
        if (seq === previewSeq.current) setLoading(false);
      }
    },
    [postId],
  );

  const runPreflight = useCallback(
    async (selection: ChannelSelection) => {
      const seq = ++preflightSeq.current;
      setChecking(true);
      setAck(false);
      try {
        // Chop etilmagan postda (tayyorlash/taklif) "post chop etilgan bo'lishi shart" xatosi chiqmasligi uchun `forPlan` semantikasi.
        const data = await adminApi.channelPreflight(postId, selection, !sending_);
        if (seq === preflightSeq.current) setPreflight(data);
      } catch (error) {
        if (seq !== preflightSeq.current) return;
        setPreflight(null);
        toast.error(errorMessage(error, "Tekshirib bo'lmadi"));
      } finally {
        if (seq === preflightSeq.current) setChecking(false);
      }
    },
    [postId, sending_],
  );

  useEffect(() => {
    // Xodim `/admin/telegram/status`ga kira olmaydi (403) — kanal nomi faqat admin uchun.
    if (!open || dialogMode === "suggest") return;
    adminApi
      .getTelegramStatus()
      .then((status) => {
        if (status.configured) setChannelHandle(status.channel);
      })
      .catch(() => {
        // Telegram holati olinmasa ham dialog ishlaydi.
      });
  }, [open, dialogMode]);

  /** Dialog ochilganda: versiyalarni (va belgini) yuklaymiz; belgi bo'lsa shundan boshlaymiz, aks holda rasm bor-yo'qligiga qarab 🖼/📝 standarti. */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const seq = ++previewSeq.current;
    preflightSeq.current += 1;
    void (async () => {
      setStep(1);
      setPreflight(null);
      setChecking(false);
      setLoading(true);
      const [data, mediaPreview] = await Promise.all([
        adminApi
          .listChannelVersions(postId)
          .then((d) => {
            if (!cancelled) {
              setVersions(d);
              onChoiceChangeRef.current?.(d.choice);
            }
            return d;
          })
          .catch((error: unknown) => {
            if (!cancelled) toast.error(errorMessage(error, "Versiyalarni yuklab bo'lmadi"));
            return null;
          }),
        adminApi.channelPreview(postId, { mode: "media", variant: "m" }).catch(() => null),
      ]);
      if (cancelled || seq !== previewSeq.current) return;
      setCanUseMedia(mediaPreview !== null);

      // Belgilangan versiya bor — dialog shunga oldindan tanlangan holda ochiladi.
      const marked = data?.choice?.choice ?? null;
      if (marked) {
        const next = choiceFromResolved(marked);
        try {
          const markedPreview = await adminApi.channelPreview(postId, toSelection(next));
          if (cancelled || seq !== previewSeq.current) return;
          setChoice(next);
          setPreview(markedPreview);
          setLoading(false);
          return;
        } catch {
          // Belgilangan ko'rinishni qurib bo'lmadi (masalan rasm yo'qolgan) — standart tanlovga tushamiz.
        }
      }

      try {
        if (mediaPreview) {
          setChoice({ kind: "auto", mode: "media", variant: "m" });
          setPreview(mediaPreview);
        } else {
          setChoice({ kind: "auto", mode: "text", variant: "m" });
          const textPreview = await adminApi.channelPreview(postId, { mode: "text", variant: "m" });
          if (!cancelled && seq === previewSeq.current) setPreview(textPreview);
        }
      } catch (error) {
        if (!cancelled) toast.error(errorMessage(error, "Oldindan ko'rishni yuklab bo'lmadi"));
      } finally {
        if (!cancelled && seq === previewSeq.current) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, postId]);

  function selectAuto(mode: ChannelMode, variant: ChannelVariant) {
    const next: Choice = { kind: "auto", mode, variant };
    setChoice(next);
    preflightSeq.current += 1;
    setPreflight(null);
    void loadPreview(toSelection(next));
  }

  function handleModeChange(nextMode: ChannelMode) {
    if (nextMode === "media" && !canUseMedia) return;
    const current = choice.kind === "auto" ? choice : null;
    if (current && current.mode === nextMode) return;
    const allowed = VARIANTS_BY_MODE[nextMode].map((v) => v.value);
    const variant: ChannelVariant = current && allowed.includes(current.variant) ? current.variant : "m";
    selectAuto(nextMode, variant);
  }

  function selectVersion(v: ChannelVersion) {
    const next: Choice = { kind: "version", id: v.id };
    setChoice(next);
    preflightSeq.current += 1;
    setPreflight(null);
    void loadPreview(toSelection(next));
  }

  async function goToStep(next: Step) {
    if (step === 2 && flushRef.current) {
      const saved = await flushRef.current();
      if (!saved) {
        // Saqlanmagan o'zgarishlar bilan oldinga o'tish eskirgan versiyani tekshirib yuborishga olib keladi.
        toast.error("O'zgarishlar saqlanmadi — qayta urinib ko'ring");
        return;
      }
    }
    if (next === 2 && (choice.kind !== "version" || readOnly)) return;
    if (step === 2) void loadVersions();
    setStep(next);
    if (next === 3) await runPreflight(toSelection(choice));
  }

  async function handleFork() {
    const mode: ChannelMode = preview?.mode ?? (choice.kind === "auto" ? choice.mode : "media");
    try {
      const body =
        choice.kind === "version" ? { mode, fromVersionId: choice.id } : { mode, fromVariant: choice.variant };
      const created = await adminApi.createChannelVersion(postId, body);
      await loadVersions();
      setChoice({ kind: "version", id: created.id });
      void loadPreview({ versionId: created.id });
      setStep(2);
      toast.success("Yangi versiya yaratildi");
    } catch (error) {
      toast.error(errorMessage(error, "Versiya yaratib bo'lmadi"));
    }
  }

  async function handleDuplicate(v: ChannelVersion) {
    try {
      await adminApi.createChannelVersion(postId, { mode: v.mode, fromVersionId: v.id });
      await loadVersions();
      toast.success("Nusxa yaratildi");
    } catch (error) {
      toast.error(errorMessage(error, "Nusxalab bo'lmadi"));
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    try {
      const res = await adminApi.deleteChannelVersion(postId, target.id);
      toast.success(res.clearedChoice ? "Versiya o'chirildi — asosiy belgisi ham olib tashlandi" : "Versiya o'chirildi");
      setDeleteTarget(null);
      await loadVersions();
      if (choice.kind === "version" && choice.id === target.id) selectAuto(canUseMedia === false ? "text" : "media", "m");
    } catch (error) {
      toast.error(errorMessage(error, "O'chirib bo'lmadi"));
      setDeleteTarget(null);
    }
  }

  /** ⭐ Asosiy — berilgan tanlovni postning belgilangan versiyasi qiladi (xodim uchun: taklif). */
  async function applyMark(target: Choice, closeAfter = false) {
    setMarking(true);
    try {
      const res = await adminApi.setChannelChoice(
        postId,
        target.kind === "auto"
          ? { kind: "auto", mode: target.mode, variant: target.variant }
          : { kind: "version", versionId: target.id },
      );
      setVersions((prev) => (prev ? { ...prev, choice: res.choice } : prev));
      onChoiceChangeRef.current?.(res.choice);
      toast.success(dialogMode === "suggest" ? "Taklif sifatida belgilandi" : "Asosiy versiya belgilandi");
      if (closeAfter) onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error, "Belgilab bo'lmadi"));
    } finally {
      setMarking(false);
    }
  }

  async function clearMark() {
    setMarking(true);
    try {
      await adminApi.clearChannelChoice(postId);
      setVersions((prev) => (prev ? { ...prev, choice: null } : prev));
      onChoiceChangeRef.current?.(null);
      toast.success("Asosiy belgisi olib tashlandi");
    } catch (error) {
      toast.error(errorMessage(error, "Belgini olib tashlab bo'lmadi"));
    } finally {
      setMarking(false);
    }
  }

  async function handleSend(replaceExisting: boolean) {
    setSending(true);
    try {
      await adminApi.channelSend(postId, toSelection(choice), replaceExisting);
      toast.success(replaceExisting ? "Qayta yuborildi" : "Kanalga yuborildi");
      setConfirmReplaceOpen(false);
      await loadPreview(toSelection(choice));
    } catch (error) {
      if (error instanceof AdminApiError && error.preflight) setPreflight(error.preflight);
      setConfirmReplaceOpen(false);
      toast.error(errorMessage(error, "Yuborib bo'lmadi"));
    } finally {
      setSending(false);
    }
  }

  async function handleResync() {
    setResyncing(true);
    try {
      await adminApi.channelResyncCaption(postId);
      toast.success("Caption yangilandi");
    } catch (error) {
      toast.error(errorMessage(error, "Yangilab bo'lmadi"));
    } finally {
      setResyncing(false);
    }
  }

  const hasErrors = preflight ? !preflight.canSend : true;
  const needsAck = (preflight?.warnCount ?? 0) > 0;
  const sendBlocked = sending || checking || !preflight || hasErrors || (needsAck && !ack);
  const autoChoice = choice.kind === "auto" ? choice : null;
  const markedChoice = versions?.choice ?? null;
  const currentIsMarked = sameChoice(markedChoice?.choice, choice);
  const sortedVersions = versions
    ? [...versions.versions].sort(
        (a, b) =>
          Number(sameChoice(markedChoice?.choice, { kind: "version", id: b.id })) -
          Number(sameChoice(markedChoice?.choice, { kind: "version", id: a.id })),
      )
    : [];

  const modeSwitch = (
    <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
      {MODE_OPTIONS.map((item) => {
        const disabled = item.value === "media" && canUseMedia === false;
        const button = (
          <button
            key={item.value}
            type="button"
            disabled={disabled}
            onClick={() => handleModeChange(item.value)}
            className={cn(
              "w-full rounded-md px-2 py-1.5 text-xs font-medium transition-colors max-sm:min-h-11",
              disabled
                ? "cursor-not-allowed text-muted-foreground/50"
                : autoChoice?.mode === item.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
            )}
          >
            {markedChoice?.choice.kind === "auto" && markedChoice.choice.mode === item.value ? "★ " : ""}
            {item.label}
          </button>
        );
        if (!disabled) return button;
        return (
          <Tooltip key={item.value}>
            <TooltipTrigger asChild>
              <span>{button}</span>
            </TooltipTrigger>
            <TooltipContent>Postda kover yoki band ichida rasm yo&apos;q</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );

  const alreadySentNote = preview?.alreadySent ? (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted/40 p-3 text-xs">
      <p>
        Allaqachon yuborilgan —{" "}
        <span className="font-medium">
          {MODE_LABELS[preview.alreadySent.mode]} ·{" "}
          {preview.alreadySent.variant
            ? VARIANT_LABELS[preview.alreadySent.variant]
            : (preview.alreadySent.versionName ?? "maxsus versiya")}
        </span>
        , {formatDateTime(preview.alreadySent.at)}
      </p>
      {preview.alreadySent.messageUrl ? (
        <a
          href={preview.alreadySent.messageUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 w-fit items-center text-primary underline underline-offset-2 md:min-h-0"
        >
          Kanalda ochish
        </a>
      ) : null}
    </div>
  ) : null;

  const markedStrip = markedChoice ? (
    <section className="flex flex-col gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm" data-testid="channel-marked-strip">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium break-all">⭐ Belgilangan: {markedChoice.label}</span>
        {markedChoice.suggestedByStaff && dialogMode !== "suggest" ? (
          <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
            Xodim taklifi{markedChoice.setBy?.name ? ` · ${markedChoice.setBy.name}` : ""}
          </span>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        <span className={cn(markedChoice.visibleLength > markedChoice.limit && "font-semibold text-destructive")}>
          {markedChoice.visibleLength} / {markedChoice.limit}
        </span>{" "}
        · {markedChoice.passes ? "✓ Telegram cheklovlaridan o'tadi" : "✗ Telegram cheklovlariga mos emas"}
      </p>
      {!readOnly ? (
        <div className="flex flex-wrap gap-1">
          {markedChoice.suggestedByStaff && dialogMode !== "suggest" ? (
            <Button type="button" size="sm" className="max-sm:h-11" disabled={marking} onClick={() => void applyMark(choiceFromResolved(markedChoice.choice))}>
              Tasdiqlash
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="ghost" className="max-sm:h-11" disabled={marking} onClick={() => void clearMark()}>
            Belgini olib tashlash
          </Button>
        </div>
      ) : null}
    </section>
  ) : null;

  const step1 = (
    <div className="flex flex-col gap-4">
      {markedStrip}
      <section className={cn("flex flex-col gap-2 rounded-lg border p-3", autoChoice ? "border-primary" : "border-border")}>
        <h3 className="text-sm font-semibold">Avtomatik</h3>
        {modeSwitch}
        <div
          className={cn(
            "grid gap-1 rounded-lg bg-muted p-1",
            autoChoice && VARIANTS_BY_MODE[autoChoice.mode].length === 2 ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4",
          )}
        >
          {VARIANTS_BY_MODE[autoChoice?.mode ?? "media"].map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => selectAuto(autoChoice?.mode ?? "media", item.value)}
              className={cn(
                "rounded-md px-2 py-1.5 text-xs font-medium transition-colors max-sm:min-h-11",
                autoChoice?.variant === item.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {markedChoice?.choice.kind === "auto" &&
              markedChoice.choice.mode === (autoChoice?.mode ?? "media") &&
              markedChoice.choice.variant === item.value
                ? "★ "
                : ""}
              {item.label}
            </button>
          ))}
        </div>
        {autoChoice && !readOnly ? (
          <Button
            type="button"
            size="sm"
            variant={currentIsMarked ? "secondary" : "outline"}
            className="w-fit max-sm:h-11"
            disabled={marking}
            onClick={() => void (currentIsMarked ? clearMark() : applyMark(autoChoice))}
          >
            {currentIsMarked ? "★ Asosiy" : "⭐ Asosiy"}
          </Button>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Mening versiyalarim</h3>
        {versions && versions.versions.length === 0 ? (
          <p className="text-xs text-muted-foreground">Hali versiya yo&apos;q. Pastdagi tugma bilan yarating.</p>
        ) : null}
        {sortedVersions.map((v) => {
          const selected = choice.kind === "version" && choice.id === v.id;
          const isMarked = sameChoice(markedChoice?.choice, { kind: "version", id: v.id });
          return (
            <div key={v.id} className={cn("flex flex-col gap-2 rounded-lg border p-3", selected ? "border-primary" : "border-border")}>
              <div className="flex flex-wrap items-center justify-between gap-x-2">
                <span className="text-sm font-medium break-all">
                  {isMarked ? <span className="mr-1 text-amber-600 dark:text-amber-400">★</span> : null}
                  {v.name}
                </span>
                <span className="text-xs text-muted-foreground">{MODE_LABELS[v.mode]}</span>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                <span className={cn(v.overLimit && "font-semibold text-destructive")}>
                  {v.visibleLength} / {v.limit}
                </span>
                <span>{v.mode === "media" ? `${v.imageUrls.length} ta rasm` : "rasmsiz"}</span>
                <span>{formatDateTime(v.updatedAt)}</span>
                {v.postChanged ? <span className="text-amber-600 dark:text-amber-400">post o&apos;zgargan</span> : null}
              </div>
              <div className="flex flex-wrap gap-1">
                <Button type="button" size="sm" variant={selected ? "secondary" : "outline"} className="max-sm:h-11" onClick={() => selectVersion(v)}>
                  {selected ? "Tanlangan" : "Tanlash"}
                </Button>
                {!readOnly ? (
                  <Button
                    type="button"
                    size="sm"
                    variant={isMarked ? "secondary" : "outline"}
                    className="max-sm:h-11"
                    disabled={marking}
                    onClick={() => void (isMarked ? clearMark() : applyMark({ kind: "version", id: v.id }))}
                  >
                    {isMarked ? "★ Asosiy" : "⭐ Asosiy"}
                  </Button>
                ) : null}
                {!readOnly ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="max-sm:h-11"
                      onClick={() => {
                        selectVersion(v);
                        setStep(2);
                      }}
                    >
                      Tahrirlash
                    </Button>
                    <Button type="button" size="sm" variant="outline" className="max-sm:h-11" onClick={() => void handleDuplicate(v)}>
                      Nusxalash
                    </Button>
                    <Button type="button" size="sm" variant="ghost" className="text-destructive max-sm:h-11" onClick={() => setDeleteTarget(v)}>
                      O&apos;chirish
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          );
        })}
        {!readOnly ? (
          <Button type="button" variant="outline" size="sm" className="max-sm:h-11" disabled={!preview} onClick={() => void handleFork()}>
            Shu ko&apos;rinishdan yangi versiya
          </Button>
        ) : null}
      </section>

      {preview ? (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>
            {preview.visibleLength} / {preview.limit} belgi
            {preview.truncated ? " (qisqartirilgan)" : ""}
          </span>
          {preview.mode === "media" ? (
            <span>{preview.media.length} ta rasm</span>
          ) : (
            <span>Oddiy matn xabari — rasmsiz, havola oldindan ko&apos;rinishi o&apos;chirilgan</span>
          )}
        </div>
      ) : null}

      {alreadySentNote}
    </div>
  );

  const step2 =
    selectedVersion && versions ? (
      <ChannelVersionEditor
        key={selectedVersion.id}
        postId={postId}
        version={selectedVersion}
        postImages={versions.postImages}
        registerFlush={registerFlush}
        onSaved={(saved) => {
          setVersions((prev) =>
            prev ? { ...prev, versions: prev.versions.map((v) => (v.id === saved.id ? saved : v)) } : prev,
          );
          // Foydalanuvchi shu orada boshqa tanlovga o'tgan bo'lsa, uning ko'rinishini bosib ketmaymiz.
          if (choiceRef.current.kind === "version" && choiceRef.current.id === saved.id) void loadPreview({ versionId: saved.id });
        }}
      />
    ) : (
      <p className="text-sm text-muted-foreground">Tahrirlash uchun avval maxsus versiyani tanlang.</p>
    );

  const step3 = (
    <div className="flex flex-col gap-3">
      {alreadySentNote}
      {dialogMode === "prepare" ? (
        <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          Post chop etilgach yuboriladi (qo&apos;lda yoki rejaga ko&apos;ra).
        </p>
      ) : null}
      {dialogMode === "suggest" ? (
        <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          Bu taklif — kanalga yuborishni admin hal qiladi.
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Telegram cheklovlari</h3>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="max-sm:h-11"
          disabled={checking}
          onClick={() => void runPreflight(toSelection(choice))}
        >
          {checking ? "Tekshirilmoqda…" : "Qayta tekshirish"}
        </Button>
      </div>
      {checking && !preflight ? <p className="text-sm text-muted-foreground">Tekshirilmoqda…</p> : null}
      {preflight ? (
        <>
          <ChannelChecklist preflight={preflight} />
          {!preflight.canSend ? (
            <p className="text-xs text-destructive">
              {sending_ ? "Xatolar tuzatilmaguncha kanalga yuborib bo'lmaydi." : "Xatolarni tuzatmaguncha bu versiya kanalga yuborilmaydi."}
            </p>
          ) : null}
          {sending_ && preflight.canSend && needsAck ? (
            <label className="flex items-center gap-2 text-sm max-sm:min-h-11">
              <input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} />
              Ogohlantirishlarni ko&apos;rdim
            </label>
          ) : null}
        </>
      ) : null}
    </div>
  );

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
            <div className="flex min-w-0 flex-col gap-3 sm:w-1/2">{step === 1 ? step1 : step === 2 ? step2 : step3}</div>
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

      <AlertDialog open={confirmReplaceOpen} onOpenChange={setConfirmReplaceOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Qayta yuborilsinmi?</AlertDialogTitle>
            <AlertDialogDescription>
              Eski kanal posti va uning butun izoh ipi (muhokama guruhidagi barcha izohlar bog&apos;lanishi) o&apos;chirib
              tashlanadi va o&apos;rniga yangisi yuboriladi. Bu amalni ortga qaytarib bo&apos;lmaydi.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction
              disabled={sending}
              onClick={() => void handleSend(true)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Ha, qayta yuborish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Versiya o&apos;chirilsinmi?</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{deleteTarget?.name}&quot; versiyasi o&apos;chiriladi. Kanalga yuborilgan xabarga tegilmaydi.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleDelete()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Ha, o&apos;chirish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

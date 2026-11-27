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
import { AdminApiError, adminApi } from "@/lib/admin-client";
import { VARIANTS_BY_MODE } from "./channel-preview";

/**
 * Telegram kanal versiyasi/yuborish mantig'i — `ChannelSendDialog` (3 qadamli oyna) va "Tarqatish" dialogidagi
 * Telegram paneli BIR XIL shu hook'dan foydalanadi (bir xil API chaqiruvlari va semantika).
 */

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof AdminApiError ? error.message : fallback;
}

export type Step = 1 | 2 | 3;
export type Choice = { kind: "auto"; mode: ChannelMode; variant: ChannelVariant } | { kind: "version"; id: string };

/**
 * `send` — chop etilgan post (admin): yuborish tugmasi bor. `prepare` — chop etilmagan post (admin): faqat tayyorlash va
 * "Asosiy qilib belgilash". `suggest` — xodim: yuborish YO'Q, faqat "Taklif sifatida belgilash".
 */
export type ChannelDialogMode = "send" | "prepare" | "suggest";

export function choiceFromResolved(resolved: ResolvedChannelChoice["choice"]): Choice {
  return resolved.kind === "version"
    ? { kind: "version", id: resolved.versionId }
    : { kind: "auto", mode: resolved.mode, variant: resolved.variant };
}

export function sameChoice(resolved: ResolvedChannelChoice["choice"] | null | undefined, choice: Choice): boolean {
  if (!resolved) return false;
  if (resolved.kind === "version") return choice.kind === "version" && choice.id === resolved.versionId;
  return choice.kind === "auto" && choice.mode === resolved.mode && choice.variant === resolved.variant;
}

export function toSelection(choice: Choice): ChannelSelection {
  return choice.kind === "auto" ? { mode: choice.mode, variant: choice.variant } : { versionId: choice.id };
}

export interface ChannelSendOptions {
  postId: string;
  /** Hook faqat shu `true` bo'lganda yuklaydi (dialog ochiq / panel ko'rinib turibdi). */
  active: boolean;
  mode?: ChannelDialogMode;
  /** Xodim uchun `in_review`da — versiyalarni faqat ko'rish (tahrirlash/belgilash yo'q). */
  readOnly?: boolean;
  /** Belgilangan versiya o'zgarganda (yoki yuklanganda) chaqiriladi — tashqi xulosa yangilanishi uchun. */
  onChoiceChange?: (choice: ResolvedChannelChoice | null) => void;
  /** "Belgilash va yopish" tugagach (faqat dialog uchun). */
  onClose?: () => void;
}

export function useChannelSend({ postId, active, mode: dialogMode = "send", readOnly = false, onChoiceChange, onClose }: ChannelSendOptions) {
  const sending_ = dialogMode === "send";
  const [marking, setMarking] = useState(false);
  const onChoiceChangeRef = useRef(onChoiceChange);
  useEffect(() => {
    onChoiceChangeRef.current = onChoiceChange;
  }, [onChoiceChange]);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
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
  /** Tahrirlagichdagi saqlanmagan o'zgarishlarni saqlatadi (`true` — hammasi saqlangan yoki tahrirlagich yo'q). */
  const flushPending = useCallback(async (): Promise<boolean> => {
    if (!flushRef.current) return true;
    const saved = await flushRef.current();
    // Saqlanmagan o'zgarishlar bilan oldinga o'tish eskirgan versiyani tekshirib yuborishga olib keladi.
    if (!saved) toast.error("O'zgarishlar saqlanmadi — qayta urinib ko'ring");
    return saved;
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
    if (!active || dialogMode === "suggest") return;
    adminApi
      .getTelegramStatus()
      .then((status) => {
        if (status.configured) setChannelHandle(status.channel);
      })
      .catch(() => {
        // Telegram holati olinmasa ham dialog ishlaydi.
      });
  }, [active, dialogMode]);

  /** Dialog ochilganda: versiyalarni (va belgini) yuklaymiz; belgi bo'lsa shundan boshlaymiz, aks holda rasm bor-yo'qligiga qarab 🖼/📝 standarti. */
  useEffect(() => {
    if (!active) return;
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
  }, [active, postId]);

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
    if (step === 2 && !(await flushPending())) return;
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
      if (closeAfter) onCloseRef.current?.();
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

  return {
    postId, dialogMode, readOnly, sending_,
    marking, step, setStep, choice, canUseMedia, versions, setVersions, preview, loading, preflight, setPreflight, checking, ack, setAck,
    sending, resyncing, channelHandle, confirmReplaceOpen, setConfirmReplaceOpen, deleteTarget, setDeleteTarget,
    registerFlush, flushPending, choiceRef,
    selectedVersion, loadVersions, loadPreview, runPreflight, selectAuto, handleModeChange, selectVersion, goToStep,
    handleFork, handleDuplicate, handleDelete, applyMark, clearMark, handleSend, handleResync,
    hasErrors, needsAck, sendBlocked, autoChoice, markedChoice, currentIsMarked, sortedVersions,
  };
}

export type ChannelSendController = ReturnType<typeof useChannelSend>;

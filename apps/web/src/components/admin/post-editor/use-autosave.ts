"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { toast } from "sonner";
import type { UpdatePostBody } from "@blog/shared";
import { adminApi } from "@/lib/admin-client";
import { AutosaveEngine, type FlushOutcome, type LocalFields } from "@/lib/editor/autosave-engine";
import { browserStorage } from "@/lib/editor/draft-backup";
import type { PostSync } from "@/lib/editor/post-sync";

const AUTOSAVE_DELAY_MS = 1500;
const BACKUP_DELAY_MS = 300;
const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 30000;

/**
 * Avtosaqlash + mahalliy zaxira + oflayn qayta urinish: faqat taymerlar, brauzer hodisalari va React holatini
 * `AutosaveEngine` (React'siz holat mashinasi, `lib/editor/autosave-engine.ts`) bilan bog'laydi. Barcha "matn yo'qolmasin"
 * qoidalari dvigatelda va testlangan.
 */
export function useAutosave({
  postId,
  initialUpdatedAt,
  initialLocal,
  enabled,
  sync,
  meId,
  onSlugConflict,
}: {
  postId: string;
  initialUpdatedAt: string;
  /** Muharrir ushlab turgan to'liq boshlang'ich holat (rolga mos maydonlar). */
  initialLocal: LocalFields;
  enabled: boolean;
  sync: PostSync;
  meId?: string;
  onSlugConflict?: (message: string) => void;
}) {
  const onSlugConflictRef = useRef(onSlugConflict);
  useEffect(() => {
    onSlugConflictRef.current = onSlugConflict;
  });
  const [engine] = useState(
    () =>
      new AutosaveEngine({
        postId,
        sync,
        api: { updatePost: (id, body) => adminApi.updatePost(id, body), getPost: (id) => adminApi.getPost(id) },
        storage: browserStorage(),
        initialUpdatedAt,
        initialLocal,
        meId,
        enabled,
        onSlugConflict: (message) => onSlugConflictRef.current?.(message),
      }),
  );
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => engine.subscribe(rerender), [engine]);
  useEffect(() => () => engine.dispose(), [engine]);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(RETRY_BASE_MS);
  const outageNotifiedRef = useRef(false);

  const scheduleBackup = useCallback(() => {
    if (backupTimerRef.current) clearTimeout(backupTimerRef.current);
    backupTimerRef.current = setTimeout(() => engine.writeBackup(), BACKUP_DELAY_MS);
  }, [engine]);

  const runFlushRef = useRef<() => Promise<void>>(async () => undefined);
  const scheduleRetry = useCallback(() => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    const delay = retryDelayRef.current;
    retryDelayRef.current = Math.min(delay * 2, RETRY_MAX_MS);
    retryTimerRef.current = setTimeout(() => void runFlushRef.current(), delay);
  }, []);

  const runFlush = useCallback(async (): Promise<void> => {
    const outcome: FlushOutcome = await engine.flush();
    if (outcome.kind === "saved") {
      retryDelayRef.current = RETRY_BASE_MS;
      outageNotifiedRef.current = false;
      if (backupTimerRef.current && !engine.dirty) clearTimeout(backupTimerRef.current);
    } else if (outcome.kind === "offline") {
      if (!outageNotifiedRef.current) {
        outageNotifiedRef.current = true;
        toast.warning("Aloqa yo'q — matn mahalliy saqlandi, aloqa tiklanganda avtomatik yuboriladi");
      }
      scheduleRetry();
    } else if (outcome.kind === "error") {
      toast.error(outcome.message);
      if (outcome.retry) scheduleRetry();
    }
    // `conflict`: banner ko'rsatiladi, qayta urinish YO'Q.
  }, [engine, scheduleRetry]);
  useEffect(() => {
    runFlushRef.current = runFlush;
  });

  const flushNow = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    void runFlush();
  }, [runFlush]);

  const queueSave = useCallback(
    (patch: Partial<UpdatePostBody>) => {
      engine.queueSave(patch);
      scheduleBackup();
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void runFlush(), AUTOSAVE_DELAY_MS);
    },
    [engine, runFlush, scheduleBackup],
  );

  // Onlayn/oflayn: onlayn bo'lishi bilan kutayotgan o'zgarishlar yuboriladi.
  useEffect(() => {
    const onOnline = () => {
      retryDelayRef.current = RETRY_BASE_MS;
      if (engine.hasPending) flushNow();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [engine, flushNow]);

  // Sahifadan chiqishda zaxirani darhol yozamiz (debounce kutmasdan).
  useEffect(() => {
    const onHide = () => {
      if (engine.dirty) engine.writeBackup();
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onHide);
    };
  }, [engine]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (backupTimerRef.current) clearTimeout(backupTimerRef.current);
    },
    [],
  );

  /** Taymerlarni to'xtatadi (kutayotganlar va zaxiraga TEGILMAYDI) — tahrirlagich almashtirilishidan oldin. */
  const cancelTimers = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    if (backupTimerRef.current) clearTimeout(backupTimerRef.current);
  }, []);

  return {
    engine,
    saveState: engine.state,
    saveError: engine.error,
    lastSavedAt: engine.lastSavedAt,
    conflict: engine.conflict,
    queueSave,
    flushNow,
    cancelTimers,
  };
}

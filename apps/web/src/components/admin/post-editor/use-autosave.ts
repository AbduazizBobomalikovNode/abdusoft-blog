"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { UpdatePostBody } from "@blog/shared";
import { AdminApiError, adminApi } from "@/lib/admin-client";
import { browserStorage, clearBackup, saveBackup } from "@/lib/editor/draft-backup";
import type { SaveState } from "./post-editor-header";

const AUTOSAVE_DELAY_MS = 1500;
const BACKUP_DELAY_MS = 300;
const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 30000;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof AdminApiError ? error.message : fallback;
}

function isNetworkError(error: unknown): boolean {
  return error instanceof AdminApiError && error.status === 0;
}

function isSlugConflict(error: unknown): boolean {
  return error instanceof AdminApiError && (error.status === 409 || error.status === 400) && /slug/i.test(error.message);
}

/**
 * Avtosaqlash + mahalliy zaxira + oflayn qayta urinish.
 * Matn hech qachon yo'qolmaydi: har bir o'zgarish localStorage'ga yoziladi va serverga muvaffaqiyatli
 * saqlangandan keyingina o'chiriladi; tarmoq xatosida avtomatik qayta uriniladi (onlayn bo'lganda darhol).
 */
export function useAutosave({
  postId,
  initialUpdatedAt,
  initialTitle,
  initialContentJson,
  enabled,
  onSlugConflict,
}: {
  postId: string;
  initialUpdatedAt: string;
  initialTitle: string;
  initialContentJson: unknown;
  enabled: boolean;
  onSlugConflict?: (message: string) => void;
}) {
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(initialUpdatedAt);

  const pendingRef = useRef<UpdatePostBody>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(RETRY_BASE_MS);
  const dirtyRef = useRef(false);
  const flushingRef = useRef(false);
  const againRef = useRef(false);
  const outageNotifiedRef = useRef(false);
  const baseUpdatedAtRef = useRef(initialUpdatedAt);
  const draftRef = useRef<{ title: string; contentJson: unknown }>({ title: initialTitle, contentJson: initialContentJson });
  const onSlugConflictRef = useRef(onSlugConflict);
  useEffect(() => {
    onSlugConflictRef.current = onSlugConflict;
  });

  const writeBackup = useCallback(() => {
    if (!enabled) return;
    saveBackup(browserStorage(), {
      v: 1,
      postId,
      baseUpdatedAt: baseUpdatedAtRef.current,
      savedAt: Date.now(),
      title: draftRef.current.title,
      contentJson: draftRef.current.contentJson,
    });
  }, [enabled, postId]);

  const scheduleBackup = useCallback(() => {
    if (backupTimerRef.current) clearTimeout(backupTimerRef.current);
    backupTimerRef.current = setTimeout(writeBackup, BACKUP_DELAY_MS);
  }, [writeBackup]);

  const flushRef = useRef<() => Promise<void>>(async () => undefined);
  const scheduleRetry = useCallback(() => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    const delay = retryDelayRef.current;
    retryDelayRef.current = Math.min(delay * 2, RETRY_MAX_MS);
    retryTimerRef.current = setTimeout(() => void flushRef.current(), delay);
  }, []);

  const flush = useCallback(async (): Promise<void> => {
    if (Object.keys(pendingRef.current).length === 0) return;
    if (flushingRef.current) {
      againRef.current = true;
      return;
    }
    flushingRef.current = true;
    const payload = pendingRef.current;
    pendingRef.current = {};
    setSaveState("saving");
    try {
      const result = await adminApi.updatePost(postId, payload);
      baseUpdatedAtRef.current = result.updatedAt;
      setSaveState("saved");
      setSaveError(null);
      setLastSavedAt(result.updatedAt);
      retryDelayRef.current = RETRY_BASE_MS;
      outageNotifiedRef.current = false;
      if (Object.keys(pendingRef.current).length === 0) {
        dirtyRef.current = false;
        if (backupTimerRef.current) clearTimeout(backupTimerRef.current);
        clearBackup(browserStorage(), postId);
      } else {
        writeBackup();
      }
    } catch (error) {
      // Saqlanmagan o'zgarishlarni qaytaramiz — yangiroqlari ustun.
      pendingRef.current = { ...payload, ...pendingRef.current };
      writeBackup();
      if (isSlugConflict(error) && pendingRef.current.slug !== undefined) {
        // Band slug butun so'rovni rad etardi — matnni yo'qotmaslik uchun slug'siz qayta saqlaymiz.
        const { slug: _dropped, ...rest } = pendingRef.current;
        void _dropped;
        pendingRef.current = rest;
        onSlugConflictRef.current?.(errorMessage(error, "Slug band"));
        againRef.current = true;
      } else if (isNetworkError(error) || (typeof navigator !== "undefined" && !navigator.onLine)) {
        setSaveState("offline");
        setSaveError(null);
        if (!outageNotifiedRef.current) {
          outageNotifiedRef.current = true;
          toast.warning("Aloqa yo'q — matn mahalliy saqlandi, aloqa tiklanganda avtomatik yuboriladi");
        }
        scheduleRetry();
      } else {
        setSaveState("error");
        setSaveError(errorMessage(error, "Saqlashda xatolik"));
        toast.error(errorMessage(error, "Saqlashda xatolik"));
        if (error instanceof AdminApiError && error.status >= 500) scheduleRetry();
      }
    } finally {
      flushingRef.current = false;
      if (againRef.current) {
        againRef.current = false;
        void flushRef.current();
      }
    }
  }, [postId, writeBackup, scheduleRetry]);

  useEffect(() => {
    flushRef.current = flush;
  });

  const flushNow = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    void flush();
  }, [flush]);

  const queueSave = useCallback(
    (patch: Partial<UpdatePostBody>) => {
      pendingRef.current = { ...pendingRef.current, ...patch };
      dirtyRef.current = true;
      if (typeof patch.title === "string") draftRef.current.title = patch.title;
      if (patch.contentJson !== undefined) draftRef.current.contentJson = patch.contentJson;
      if ("title" in patch || "contentJson" in patch) scheduleBackup();
      setSaveState((s) => (s === "offline" ? s : "idle"));
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
    },
    [flush, scheduleBackup],
  );

  // Onlayn/oflayn: onlayn bo'lishi bilan kutayotgan o'zgarishlar yuboriladi.
  useEffect(() => {
    const onOnline = () => {
      retryDelayRef.current = RETRY_BASE_MS;
      if (Object.keys(pendingRef.current).length > 0) flushNow();
    };
    const onOffline = () => {
      if (dirtyRef.current) setSaveState("offline");
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [flushNow]);

  // Sahifadan chiqishda zaxirani darhol yozamiz (debounce kutmasdan).
  useEffect(() => {
    const onHide = () => {
      if (dirtyRef.current) writeBackup();
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onHide);
    };
  }, [writeBackup]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (backupTimerRef.current) clearTimeout(backupTimerRef.current);
    },
    [],
  );

  return { saveState, saveError, lastSavedAt, queueSave, flushNow, flush, dirtyRef, pendingRef };
}

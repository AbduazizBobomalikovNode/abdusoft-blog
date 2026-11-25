"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { UpdatePostBody } from "@blog/shared";
import { AdminApiError, adminApi, asPostConflict } from "@/lib/admin-client";
import { browserStorage, clearBackup, saveBackup } from "@/lib/editor/draft-backup";
import { isConflictFailure, payloadAlreadyApplied, type PostSync, type SyncConflict } from "@/lib/editor/post-sync";
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
  sync,
  meId,
  onSlugConflict,
}: {
  postId: string;
  initialUpdatedAt: string;
  initialTitle: string;
  initialContentJson: unknown;
  enabled: boolean;
  /** Postga yozuvchi barcha so'rovlar uchun umumiy navbat va `updatedAt` tokeni (konkurensiya himoyasi). */
  sync: PostSync;
  /** Joriy foydalanuvchi — `409` o'zimiz yozgan o'zgarishdan kelganini aniqlash uchun. */
  meId?: string;
  onSlugConflict?: (message: string) => void;
}) {
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(initialUpdatedAt);
  // Foydalanuvchiga ko'rsatiladigan to'qnashuv (banner). Avtosaqlash o'z `409`ini avval tekshiradi (o'zim yozgan bo'lishi mumkin).
  const [conflict, setConflict] = useState<SyncConflict | null>(null);
  const reconcilingRef = useRef(false);

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

  const writeBackupRef = useRef<() => void>(() => undefined);
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
  useEffect(() => {
    writeBackupRef.current = writeBackup;
  });

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

  /**
   * `409`: avval serverdagi nusxa AYNAN bizning yuborgan qiymatlarimizni saqlab qo'ymaganmi tekshiramiz (javobi yo'qolgan
   * so'rov yoki ikkinchi tab xuddi shu matnni yozgan bo'lishi mumkin) — shunda to'qnashuv yo'q. Aks holda banner.
   */
  const handleConflict = useCallback(
    async (error: unknown) => {
      const info = asPostConflict(error) ?? sync.conflict;
      if (info && meId && info.updatedBy?.id === meId && info.via === "web") {
        reconcilingRef.current = true;
        try {
          const fresh = await adminApi.getPost(postId);
          if (payloadAlreadyApplied(pendingRef.current, fresh)) {
            sync.resolve(fresh.updatedAt);
            baseUpdatedAtRef.current = fresh.updatedAt;
            pendingRef.current = {};
            dirtyRef.current = false;
            clearBackup(browserStorage(), postId);
            setSaveState("saved");
            setSaveError(null);
            setLastSavedAt(fresh.updatedAt);
            setConflict(null);
            return;
          }
        } catch {
          // Tekshirib bo'lmadi — ehtiyotkorlik bilan to'qnashuv sifatida ko'rsatamiz.
        } finally {
          reconcilingRef.current = false;
        }
      }
      setSaveState("conflict");
      setSaveError(null);
      setConflict(sync.conflict ?? info);
    },
    [meId, postId, sync],
  );

  const flush = useCallback(async (): Promise<void> => {
    if (Object.keys(pendingRef.current).length === 0) return;
    // To'qnashuv hal bo'lguncha tarmoqqa chiqmaymiz: matn `pendingRef` va mahalliy zaxirada saqlanib turadi.
    if (sync.conflict) return;
    if (flushingRef.current) {
      againRef.current = true;
      return;
    }
    flushingRef.current = true;
    const payload = pendingRef.current;
    pendingRef.current = {};
    setSaveState("saving");
    try {
      const result = await sync.run((token) => adminApi.updatePost(postId, token ? { ...payload, expectedUpdatedAt: token } : payload));
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
      if (isConflictFailure(error)) {
        againRef.current = false;
        if (backupTimerRef.current) clearTimeout(backupTimerRef.current);
        await handleConflict(error);
      } else if (isSlugConflict(error) && pendingRef.current.slug !== undefined) {
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
      // Flush paytida kelgan to'qnashuv xabari yuqorida e'tiborsiz qoldirilgan bo'lishi mumkin — holatni tenglashtiramiz.
      if (sync.conflict) {
        setConflict(sync.conflict);
        setSaveState("conflict");
      }
      if (againRef.current) {
        againRef.current = false;
        void flushRef.current();
      }
    }
  }, [postId, writeBackup, scheduleRetry, sync, handleConflict]);

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

  // Boshqa so'rov (chop etish, arxivlash, ...) `409` olsa ham tahrirlagich to'xtaydi va matn zaxiraga yoziladi.
  useEffect(
    () =>
      sync.subscribe(() => {
        if (reconcilingRef.current || flushingRef.current) return;
        const current = sync.conflict;
        setConflict(current);
        if (current) {
          if (backupTimerRef.current) clearTimeout(backupTimerRef.current);
          if (timerRef.current) clearTimeout(timerRef.current);
          writeBackupRef.current();
          setSaveState("conflict");
        } else {
          setSaveState((state) => (state === "conflict" ? "idle" : state));
        }
      }),
    [sync],
  );

  /** Mahalliy matnni hoziroq zaxiraga yozadi (debounce kutmasdan) — "oxirgi versiyani yuklash" oldidan. */
  const persistBackupNow = useCallback(() => {
    if (backupTimerRef.current) clearTimeout(backupTimerRef.current);
    writeBackup();
  }, [writeBackup]);

  /** Kutayotgan o'zgarishlarni va taymerlarni bekor qiladi (zaxira TEGILMAYDI). */
  const discardPending = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    if (backupTimerRef.current) clearTimeout(backupTimerRef.current);
    pendingRef.current = {};
    dirtyRef.current = false;
  }, []);

  /**
   * "Meniki bilan almashtirish": kutayotgan o'zgarishlar + `full` (to'liq mahalliy holat) BIR MARTA tokensiz yuboriladi.
   * Muvaffaqiyatsiz bo'lsa to'qnashuv holati va matn saqlanib qoladi (ma'lumot yo'qolmaydi).
   */
  const overwrite = useCallback(
    async (full: UpdatePostBody): Promise<boolean> => {
      if (flushingRef.current) await sync.idle();
      const payload: UpdatePostBody = { ...pendingRef.current, ...full };
      pendingRef.current = {};
      setSaveState("saving");
      try {
        const result = await sync.runForced(() => adminApi.updatePost(postId, payload));
        baseUpdatedAtRef.current = result.updatedAt;
        setLastSavedAt(result.updatedAt);
        setSaveState("saved");
        setSaveError(null);
        setConflict(null);
        dirtyRef.current = false;
        clearBackup(browserStorage(), postId);
        return true;
      } catch (error) {
        pendingRef.current = { ...payload, ...pendingRef.current };
        writeBackup();
        setSaveState("conflict");
        toast.error(errorMessage(error, "Saqlab bo'lmadi"));
        return false;
      }
    },
    [postId, sync, writeBackup],
  );

  return {
    saveState,
    saveError,
    lastSavedAt,
    conflict,
    queueSave,
    flushNow,
    flush,
    dirtyRef,
    pendingRef,
    persistBackupNow,
    discardPending,
    overwrite,
  };
}

"use client";

import { useEffect } from "react";

let dirtySections = 0;

function syncBeforeUnload() {
  if (typeof window === "undefined") return;
  window.onbeforeunload = dirtySections > 0 ? () => "" : null;
}

/**
 * Har bir sozlamalar bo'limi o'zining "tahrirlanmoqda" holatini shu hook orqali
 * bildiradi — kamida bitta bo'limda saqlanmagan o'zgarish bo'lsa, sahifadan
 * chiqishda brauzer ogohlantiradi (native `beforeunload`).
 */
export function useUnsavedGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    dirtySections += 1;
    syncBeforeUnload();
    return () => {
      dirtySections = Math.max(0, dirtySections - 1);
      syncBeforeUnload();
    };
  }, [dirty]);
}

"use client";

import { useCallback, useEffect, useState } from "react";

/** Diqqat rejimi: `<html data-editor-focus>` — admin navigatsiyasi/yon panel CSS orqali yashiriladi. Mod+Shift+F, Esc. */
export function useFocusMode(enabled: boolean): { focusMode: boolean; toggle: () => void; exit: () => void } {
  const [focusMode, setFocusMode] = useState(false);
  const toggle = useCallback(() => setFocusMode((v) => !v), []);
  const exit = useCallback(() => setFocusMode(false), []);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFocusMode((v) => !v);
      } else if (event.key === "Escape" && !event.defaultPrevented) {
        setFocusMode(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);

  useEffect(() => {
    const root = document.documentElement;
    if (focusMode) root.setAttribute("data-editor-focus", "");
    else root.removeAttribute("data-editor-focus");
    return () => root.removeAttribute("data-editor-focus");
  }, [focusMode]);

  return { focusMode, toggle, exit };
}

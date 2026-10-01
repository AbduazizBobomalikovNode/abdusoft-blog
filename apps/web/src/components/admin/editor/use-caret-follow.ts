"use client";

import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import { prefersReducedMotion } from "./use-media-query";

/**
 * Yozilayotgan qator hech qachon asboblar paneli / klaviatura ostida qolmasligi uchun:
 * kursor ko'rinadigan oynadan chiqsa — sahifa silliq scroll qilinadi (reduced-motion'da — darhol).
 */
export function useCaretFollow(editor: Editor | null): void {
  useEffect(() => {
    if (!editor) return;
    let raf = 0;
    const follow = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (editor.isDestroyed || !editor.isFocused || !editor.state.selection.empty) return;
        const vv = window.visualViewport;
        const viewBottom = (vv ? vv.offsetTop + vv.height : window.innerHeight) as number;
        const bar = document.querySelector("[data-editor-toolbar]");
        const barRect = bar?.getBoundingClientRect();
        const isFixedBar = !!bar && getComputedStyle(bar).position === "fixed";
        const header = document.querySelector("[data-editor-header]")?.getBoundingClientRect();
        const topLimit = Math.max(header?.bottom ?? 0, !isFixedBar ? (barRect?.bottom ?? 0) : 0) + 16;
        const bottomLimit = (isFixedBar && barRect && barRect.height > 0 ? barRect.top : viewBottom) - 24;
        let coords;
        try {
          coords = editor.view.coordsAtPos(editor.state.selection.head);
        } catch {
          return;
        }
        let delta = 0;
        if (coords.bottom > bottomLimit) delta = coords.bottom - bottomLimit;
        else if (coords.top < topLimit) delta = coords.top - topLimit;
        if (Math.abs(delta) > 1) window.scrollBy({ top: delta, behavior: prefersReducedMotion() ? "auto" : "smooth" });
      });
    };
    editor.on("selectionUpdate", follow);
    editor.on("update", follow);
    return () => {
      cancelAnimationFrame(raf);
      editor.off("selectionUpdate", follow);
      editor.off("update", follow);
    };
  }, [editor]);
}

"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { cn } from "@/lib/utils";

export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

function sameRect(a: AnchorRect | null, b: AnchorRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return Math.abs(a.top - b.top) < 0.5 && Math.abs(a.bottom - b.bottom) < 0.5 && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.right - b.right) < 0.5;
}

export function rectOf(el: Element): AnchorRect {
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
}

/** Hujjat oralig'ining ekrandagi to'rtburchagi (bir qatorli matn uchun). */
export function rangeRect(editor: Editor, from: number, to: number): AnchorRect | null {
  try {
    const a = editor.view.coordsAtPos(from);
    const b = editor.view.coordsAtPos(to);
    return { top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom), left: Math.min(a.left, b.left), right: Math.max(a.right, b.right) };
  } catch {
    return null;
  }
}

/** Muharrir o'zgarganda / sahifa scroll bo'lganda `getRect` natijasini yangilab turadi (rAF bilan). */
export function useAnchorRect(editor: Editor, getRect: (editor: Editor) => AnchorRect | null, anchorKey: string | number = ""): AnchorRect | null {
  const [rect, setRect] = useState<AnchorRect | null>(null);
  const getRef = useRef(getRect);
  useLayoutEffect(() => {
    getRef.current = getRect;
  });
  useEffect(() => {
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (editor.isDestroyed) return;
        const next = getRef.current(editor);
        setRect((prev) => (sameRect(prev, next) ? prev : next));
      });
    };
    editor.on("transaction", update);
    editor.on("focus", update);
    editor.on("blur", update);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    update();
    return () => {
      cancelAnimationFrame(raf);
      editor.off("transaction", update);
      editor.off("focus", update);
      editor.off("blur", update);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [editor, anchorKey]);
  return rect;
}

/** Ekranga `fixed` joylashgan kichik panel: odatda tepada, joy bo'lmasa pastda; gorizontal chegarada ushlanadi. */
export function FloatingPanel({
  rect,
  children,
  className,
  testId,
  placement = "top",
  align = "center",
  onMouseEnter,
  onMouseLeave,
}: {
  rect: AnchorRect | null;
  /** "bottom" — tanlangan matn ustidagi bubble menyu bilan to'qnashmaslik uchun pastda. */
  placement?: "top" | "bottom";
  /** "start" — panelning chap chekkasi nishon bilan tekislanadi (keng jadval ustida yon panelga chiqib ketmasligi uchun). */
  align?: "center" | "start";
  children: React.ReactNode;
  className?: string;
  testId?: string;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !rect) return;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const margin = 8;
    const minTop = (document.querySelector("[data-editor-toolbar]")?.getBoundingClientRect().bottom ?? 0) + margin;
    const above = rect.top - height - margin;
    const top = placement === "top" && above >= minTop ? above : rect.bottom + margin;
    const center = align === "start" ? rect.left : (rect.left + rect.right) / 2 - width / 2;
    const left = Math.max(margin, Math.min(center, window.innerWidth - width - margin));
    el.style.top = `${Math.round(top)}px`;
    el.style.left = `${Math.round(left)}px`;
  });
  if (!rect || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={ref}
      data-testid={testId}
      className={cn("editor-floating-panel", className)}
      style={{ position: "fixed", top: 0, left: 0 }}
      onMouseDown={(event) => {
        // Maydon/tugmalar bosilganda muharrir tanlovi yo'qolmasin (input'dan tashqari).
        if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
    </div>,
    document.body,
  );
}

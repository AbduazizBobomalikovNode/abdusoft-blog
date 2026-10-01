"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Fokusni o'g'irlamaydigan menyu (Radix emas): tugma/elementlar `mousedown`ni to'xtatadi,
 * shuning uchun muharrir fokusi va mobil klaviatura yopilmaydi.
 */
export function ToolbarMenu({
  label,
  icon,
  active,
  placement,
  children,
  testId,
}: {
  label: string;
  icon: React.ReactNode;
  active?: boolean;
  /** "up" — mobil (klaviatura tepasidagi panel); "down" — desktop. */
  placement: "up" | "down";
  children: (close: () => void) => React.ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    const button = buttonRef.current;
    const panel = panelRef.current;
    if (!open || !button || !panel) return;
    const rect = button.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - panel.offsetWidth - margin));
    panel.style.left = `${Math.round(left)}px`;
    if (placement === "up") {
      panel.style.bottom = `${Math.round(window.innerHeight - rect.top + 6)}px`;
      panel.style.top = "auto";
    } else {
      panel.style.top = `${Math.round(rect.bottom + 4)}px`;
      panel.style.bottom = "auto";
    }
  });

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid={testId}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        className={cn("editor-tb-btn is-menu", active && "is-active")}
      >
        {icon}
        <ChevronDown className="size-3 opacity-60" />
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              className="editor-tb-menu"
              style={{ position: "fixed" }}
              onMouseDown={(event) => event.preventDefault()}
            >
              {children(() => setOpen(false))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function ToolbarMenuItem({
  icon,
  label,
  hint,
  active,
  onSelect,
  testId,
}: {
  icon?: React.ReactNode;
  label: string;
  hint?: string;
  active?: boolean;
  onSelect: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
      className={cn("editor-tb-menu-item", active && "is-active")}
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </button>
  );
}

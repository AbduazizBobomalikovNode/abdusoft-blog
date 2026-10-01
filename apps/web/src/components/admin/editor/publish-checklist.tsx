"use client";

import { CheckCircle2, Circle, TriangleAlert, XCircle } from "lucide-react";
import type { ChecklistItem, FixTarget } from "@/lib/editor/checklist";
import { cn } from "@/lib/utils";

/** Chop etishdan oldingi qisqa tekshiruv ro'yxati (to'sib qo'yadiganlar + ogohlantirishlar). */
export function PublishChecklist({ items, onFix }: { items: ChecklistItem[]; onFix: (target: FixTarget) => void }) {
  return (
    <ul className="flex flex-col gap-1 rounded-lg border border-border p-2 text-sm" data-testid="publish-checklist">
      {items.map((item) => {
        const Icon = item.ok ? CheckCircle2 : item.severity === "block" ? XCircle : TriangleAlert;
        return (
          <li key={item.id} data-testid={`check-${item.id}`} data-ok={item.ok} data-severity={item.severity} className="flex min-h-9 items-center gap-2">
            <Icon
              className={cn(
                "size-4 shrink-0",
                item.ok ? "text-emerald-600 dark:text-emerald-400" : item.severity === "block" ? "text-destructive" : "text-amber-600 dark:text-amber-400",
              )}
            />
            <span className="min-w-0 flex-1 break-words">
              {item.label}
              {item.detail ? <span className="block text-xs text-muted-foreground">{item.detail}</span> : null}
            </span>
            {!item.ok && item.fix ? (
              <button
                type="button"
                data-testid={`fix-${item.id}`}
                onClick={() => onFix(item.fix as FixTarget)}
                className="rounded-md px-2 py-1 text-xs font-medium underline underline-offset-2 hover:bg-muted max-md:min-h-11"
              >
                Tuzatish
              </button>
            ) : item.ok ? null : <Circle className="size-3 text-muted-foreground" />}
          </li>
        );
      })}
    </ul>
  );
}

"use client";

import { CloudOff } from "lucide-react";
import type { DocStats } from "@blog/shared";
import { cn } from "@/lib/utils";

export interface FooterSaveInfo {
  text: string;
  tone: "idle" | "saving" | "saved" | "error" | "offline";
}

/** Desktop pastki holat paneli: so'z/belgi/o'qish vaqti va saqlash holati. */
export function StatusFooter({ stats, save, className }: { stats: DocStats; save: FooterSaveInfo; className?: string }) {
  return (
    <div
      data-testid="status-footer"
      className={cn("editor-status-footer text-xs text-muted-foreground max-md:hidden", className)}
      role="status"
      aria-live="polite"
    >
      <span>{stats.words.toLocaleString("uz")} so&apos;z</span>
      <span aria-hidden>·</span>
      <span>{stats.characters.toLocaleString("uz")} belgi</span>
      <span aria-hidden>·</span>
      <span>~{stats.readingMinutes} daq o&apos;qish</span>
      <span className="ml-auto flex items-center gap-1.5">
        {save.tone === "offline" ? <CloudOff className="size-3.5" /> : null}
        <span className={cn(save.tone === "error" && "text-destructive", save.tone === "offline" && "text-amber-600 dark:text-amber-400")}>{save.text}</span>
      </span>
    </div>
  );
}

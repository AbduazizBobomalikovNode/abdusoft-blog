"use client";

import { useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import type { DistributionVersionDto } from "@blog/shared";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { DEFAULT_ENTRY_LABEL, canAddVersion, saveStateLabel, versionLimitText, type VersionSaveState } from "@/lib/distribution-versions";
import { cn } from "cn";

interface Props {
  versions: DistributionVersionDto[];
  /** `null` — "Standart" tanlangan. */
  selectedId: string | null;
  disabled: boolean;
  saveState: VersionSaveState;
  onSelect: (id: string | null) => void;
  onCreate: () => void;
  onRename: (id: string, name: string) => void;
  onSetPrimary: (id: string) => void;
  onClearPrimary: () => void;
  onDelete: (id: string) => void;
}

const chip = "flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-60";

/** Matn maydoni ustidagi versiyalar qatori: "Standart" + nomli versiyalar + "Yangi versiya"; tanlanganda nom/asosiy/o'chirish. */
export function DistributionVersionStrip({ versions, selectedId, disabled, saveState, onSelect, onCreate, onRename, onSetPrimary, onClearPrimary, onDelete }: Props) {
  const selected = versions.find((v) => v.id === selectedId) ?? null;
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  function commitRename() {
    const name = draftName.trim();
    setRenaming(false);
    if (selected && name !== "" && name !== selected.name) onRename(selected.id, name);
  }

  return (
    <div className="flex flex-col gap-2" data-testid="dist-versions">
      <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5" role="tablist" aria-label="Matn versiyalari">
        <button type="button" role="tab" aria-selected={selectedId === null} disabled={disabled} onClick={() => onSelect(null)}
          className={cn(chip, selectedId === null ? "border-foreground/40 bg-background shadow-sm" : "border-transparent bg-muted text-muted-foreground")}>
          {DEFAULT_ENTRY_LABEL}
        </button>
        {versions.map((v) => (
          <button key={v.id} type="button" role="tab" aria-selected={selectedId === v.id} disabled={disabled} onClick={() => onSelect(v.id)}
            className={cn(chip, selectedId === v.id ? "border-foreground/40 bg-background shadow-sm" : "border-transparent bg-muted text-muted-foreground")}>
            <span className="max-w-32 truncate">{v.name}</span>
            {v.isPrimary ? <span className="rounded bg-emerald-500/15 px-1 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300" data-testid="dist-version-primary">Asosiy</span> : null}
          </button>
        ))}
        <button type="button" disabled={disabled || !canAddVersion(versions)} onClick={onCreate} title={canAddVersion(versions) ? "Hozirgi matndan yangi versiya" : "Versiyalar chegarasi"}
          className={cn(chip, "border-dashed border-border text-muted-foreground")} data-testid="dist-version-new">
          <Plus className="size-3" /> Yangi versiya
        </button>
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">{versionLimitText(versions)}</span>
      </div>

      {selected ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="dist-version-actions">
          {renaming ? (
            <Input value={draftName} autoFocus maxLength={80} className="h-8 w-48 text-xs" aria-label="Versiya nomi" onChange={(e) => setDraftName(e.target.value)} onBlur={commitRename}
              onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setRenaming(false); }} />
          ) : (
            <span className="text-xs font-medium">{selected.name}</span>
          )}
          {selected.isPrimary ? (
            <Button size="xs" variant="ghost" disabled={disabled} onClick={onClearPrimary}>Asosiylikni olib tashlash</Button>
          ) : (
            <Button size="xs" variant="outline" disabled={disabled} onClick={() => onSetPrimary(selected.id)}>Asosiy qilish</Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="xs" variant="ghost" disabled={disabled} aria-label="Versiya amallari"><MoreHorizontal className="size-3.5" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => { setDraftName(selected.name); setRenaming(true); }}>Nomini o&apos;zgartirish</DropdownMenuItem>
              <DropdownMenuItem className="text-destructive" onSelect={() => setConfirmDelete(true)}>O&apos;chirish</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="ml-auto text-xs text-muted-foreground" data-testid="dist-version-save" aria-live="polite">{saveStateLabel(saveState)}</span>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Standart matn — saqlanmaydi. «Yangi versiya» hozirgi matnni nomli versiya qilib saqlaydi.</p>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Versiya o&apos;chirilsinmi?</AlertDialogTitle>
            <AlertDialogDescription>«{selected?.name}» o&apos;chiriladi. Avval yuborilgan postlar o&apos;zgarmaydi.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground" onClick={() => selected && onDelete(selected.id)}>O&apos;chirish</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

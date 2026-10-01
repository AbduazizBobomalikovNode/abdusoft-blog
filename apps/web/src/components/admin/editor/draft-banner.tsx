"use client";

import { History } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Saqlanmagan mahalliy nusxa topilganda — bloklamaydigan xabar. */
export function DraftBanner({ serverNewer, onRestore, onDiscard }: { serverNewer: boolean; onRestore: () => void; onDiscard: () => void }) {
  return (
    <div role="status" data-testid="draft-banner" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
      <History className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Saqlanmagan mahalliy nusxa topildi</p>
        {serverNewer ? <p className="text-xs text-muted-foreground">Diqqat: serverdagi nusxa ham shundan keyin o&apos;zgargan — tiklash uni almashtiradi.</p> : null}
      </div>
      <div className="flex gap-2">
        <Button size="sm" className="max-md:h-11" onClick={onRestore} data-testid="draft-restore">Tiklash</Button>
        <Button size="sm" variant="outline" className="max-md:h-11" onClick={onDiscard} data-testid="draft-discard">Tashlab yuborish</Button>
      </div>
    </div>
  );
}

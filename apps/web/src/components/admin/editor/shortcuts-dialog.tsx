"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { OPEN_SHORTCUTS_EVENT } from "./events";
import { SHORTCUT_GROUPS, formatShortcut } from "./shortcuts";

/** Mod+/ — barcha tezkor tugmalar ro'yxati. */
export function ShortcutsDialog() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key === "/") {
        event.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
    };
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-xl" data-testid="shortcuts-dialog">
        <DialogHeader>
          <DialogTitle>Tezkor tugmalar</DialogTitle>
          <DialogDescription>Yozish paytida ishlatiladigan barcha qisqartmalar.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.title}</h3>
              <dl className="flex flex-col divide-y divide-border rounded-lg border border-border">
                {group.rows.map((row) => (
                  <div key={row.label} className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm">
                    <dt className="min-w-0 flex-1">{row.label}</dt>
                    <dd>
                      <kbd className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">{formatShortcut(row.keys)}</kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

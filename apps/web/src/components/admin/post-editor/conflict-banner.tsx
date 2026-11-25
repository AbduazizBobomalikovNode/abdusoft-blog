"use client";

import { useState } from "react";
import { History, TriangleAlert } from "lucide-react";
import type { PostConflictResponse } from "@blog/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { conflictSummary } from "@/lib/editor/conflict-text";
import { formatTime } from "@/lib/format";

/**
 * Post boshqa joyda o'zgargan (`409`) — doimiy, xushmuomala banner. `aria-live="polite"` — ekran o'qigich uni
 * foydalanuvchini bezovta qilmay e'lon qiladi. Uch amal: oxirgisini yuklash / meniki bilan almashtirish (tasdiq bilan) / tarix.
 */
export function ConflictBanner({
  conflict,
  meId,
  busy = false,
  canOpenHistory = true,
  onLoadLatest,
  onOverwrite,
  onOpenHistory,
}: {
  conflict: PostConflictResponse;
  meId?: string;
  busy?: boolean;
  canOpenHistory?: boolean;
  onLoadLatest: () => void;
  onOverwrite: () => void;
  onOpenHistory: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const summary = conflictSummary(conflict, meId);

  return (
    <>
      <div
        role="status"
        aria-live="polite"
        data-testid="conflict-banner"
        className="flex flex-col gap-3 rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm"
      >
        <div className="flex items-start gap-2.5">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Bu post boshqa joyda o&apos;zgartirilgan</p>
            <p className="mt-0.5 text-muted-foreground" data-testid="conflict-who">
              {summary.who}
              {conflict.updatedAt ? <> · {formatTime(conflict.updatedAt)}</> : null}
            </p>
            <p className="mt-1 text-muted-foreground">
              Avtosaqlash to&apos;xtatildi. Yozgan matningiz ushbu brauzerda saqlab qo&apos;yilgan — hech narsa yo&apos;qolmaydi.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" className="max-md:h-11" disabled={busy} onClick={onLoadLatest} data-testid="conflict-load-latest">
            Oxirgi versiyani yuklash
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="max-md:h-11"
            disabled={busy}
            onClick={() => setConfirmOpen(true)}
            data-testid="conflict-overwrite"
          >
            Meniki bilan almashtirish
          </Button>
          {canOpenHistory ? (
            <Button size="sm" variant="ghost" className="max-md:h-11" disabled={busy} onClick={onOpenHistory} data-testid="conflict-history">
              <History className="size-4" />
              Tarixni ochish
            </Button>
          ) : null}
        </div>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Meniki bilan almashtirilsinmi?</AlertDialogTitle>
            <AlertDialogDescription>
              Serverdagi o&apos;zgarishlar ({summary.who}) sizning versiyangiz bilan almashtiriladi. Ularning nusxasi Tarixda
              saqlanadi va keyin qaytarib olish mumkin.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="max-sm:h-11">Bekor qilish</AlertDialogCancel>
            <AlertDialogAction
              className="max-sm:h-11"
              onClick={() => {
                setConfirmOpen(false);
                onOverwrite();
              }}
            >
              Almashtirish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

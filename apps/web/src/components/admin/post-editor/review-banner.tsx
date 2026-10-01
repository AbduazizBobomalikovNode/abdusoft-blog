"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { AdminPostStatus, ResolvedChannelChoice } from "@blog/shared";
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
import { Textarea } from "@/components/ui/textarea";
import { AdminApiError, adminApi } from "@/lib/admin-client";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof AdminApiError ? error.message : fallback;
}

/** Xodim tomoni — `in_review` bo'lsa o'qish-uchun banner, `changes_requested` bo'lsa admin izohi. */
export function StaffReviewBanner({ status, reviewNote }: { status: AdminPostStatus; reviewNote: string | null }) {
  if (status === "in_review") {
    return (
      <div className="rounded-lg border border-blue-500/40 bg-blue-500/10 px-4 py-3 text-sm text-blue-700 dark:text-blue-400">
        👁 Bu post ko&apos;rib chiqilmoqda — admin tasdiqlagach saytda chop etiladi. Tahrirlash vaqtincha o&apos;chirilgan.
      </div>
    );
  }

  if (status === "changes_requested") {
    return (
      <div className="flex flex-col gap-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
        <span className="font-medium">✏️ Admin tuzatish so&apos;radi:</span>
        <span>{reviewNote || "Izoh qoldirilmagan."}</span>
      </div>
    );
  }

  return null;
}

/** Admin tomoni — `in_review` postda "X yubordi" + tasdiqlash/qaytarish tugmalari. */
export function AdminReviewActions({
  postId,
  authorName,
  channelChoice = null,
  onApproved,
  onChangesRequested,
}: {
  postId: string;
  authorName: string;
  /** Xodim/admin belgilagan kanal versiyasi — tasdiqlash dialogida "kanalga ham yuborilsin" katagi uchun. */
  channelChoice?: ResolvedChannelChoice | null;
  onApproved: (status: AdminPostStatus) => void;
  onChangesRequested: (status: AdminPostStatus) => void;
}) {
  const [approveOpen, setApproveOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [sendToChannel, setSendToChannel] = useState(false);

  async function handleApprove() {
    setBusy(true);
    try {
      const result = await adminApi.approvePost(postId, channelChoice && sendToChannel ? { sendToChannel: true } : undefined);
      onApproved(result.status);
      const send = result.channelSend;
      if (send?.state === "sent") toast.success("Post chop etildi va kanalga yuborildi");
      else if (send?.state === "failed") toast.error(`Post chop etildi, lekin kanalga yuborilmadi: ${send.error ?? "noma'lum xato"}`);
      else if (send?.state === "pending") toast.success("Post chop etildi — kanalga yuborilmoqda, natija admin chatiga keladi");
      else toast.success("Post chop etildi");
      setApproveOpen(false);
    } catch (error) {
      toast.error(errorMessage(error, "Chop etishda xatolik"));
    } finally {
      setBusy(false);
    }
  }

  async function handleRequestChanges() {
    if (!note.trim()) return;
    setBusy(true);
    try {
      const result = await adminApi.requestPostChanges(postId, note.trim());
      onChangesRequested(result.status);
      toast.success("Xodimga qaytarildi");
      setChangesOpen(false);
      setNote("");
    } catch (error) {
      toast.error(errorMessage(error, "Amalni bajarib bo'lmadi"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-blue-500/40 bg-blue-500/10 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <span className="text-blue-700 dark:text-blue-400">
        📝 <strong>{authorName}</strong> ko&apos;rib chiqishga yubordi.
      </span>
      <div className="flex gap-2 max-sm:w-full">
        <Button
          type="button"
          size="sm"
          className="max-sm:h-11 max-sm:flex-1"
          onClick={() => {
            setSendToChannel(false); // har safar o'chiq holatda ochiladi
            setApproveOpen(true);
          }}
        >
          ✅ Chop etish
        </Button>
        <Button type="button" size="sm" variant="outline" className="max-sm:h-11 max-sm:flex-1" onClick={() => setChangesOpen(true)}>
          ✏️ Qaytarish
        </Button>
      </div>

      <AlertDialog open={approveOpen} onOpenChange={setApproveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Postni chop etish</AlertDialogTitle>
            <AlertDialogDescription>
              Post darhol saytda ko&apos;rinadi. Kanalga yuborish qo&apos;lda qoladi{channelChoice ? " (yoki quyidagi katak bilan)" : ""}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {channelChoice ? (
            <div className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm" data-testid="approve-channel-choice">
              <p className="break-words">
                Kanal versiyasi: <span className="font-medium">⭐ {channelChoice.label}</span>
                {channelChoice.suggestedByStaff ? <span className="ml-1.5 text-xs text-amber-700 dark:text-amber-400">(Xodim taklifi)</span> : null}
              </p>
              <label className="flex min-h-11 cursor-pointer items-center gap-2 md:min-h-0">
                <input type="checkbox" className="size-4" checked={sendToChannel} onChange={(event) => setSendToChannel(event.target.checked)} />
                Chop etilgach kanalga ham yuborilsin
              </label>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel className="max-sm:h-11">Bekor qilish</AlertDialogCancel>
            <AlertDialogAction className="max-sm:h-11" disabled={busy} onClick={() => void handleApprove()}>
              Chop etish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={changesOpen} onOpenChange={setChangesOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xodimga qaytarish</AlertDialogTitle>
            <AlertDialogDescription>Nima tuzatilishi kerakligini yozing — xodim buni admin panelda ko&apos;radi.</AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Masalan: Sarlavhani qisqartiring, birinchi rasmni almashtiring…"
            rows={4}
            autoFocus
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction disabled={busy || !note.trim()} onClick={() => void handleRequestChanges()}>
              Yuborish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

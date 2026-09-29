"use client";

import { useState } from "react";
import Link from "next/link";
import { Archive, BarChart3, Eye, MoreHorizontal, Send, Trash2 } from "lucide-react";
import type { AdminPostStatus } from "@blog/shared";
import { PostStatusBadge } from "@/components/admin/post-status-badge";
import { formatTime } from "@/lib/format";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type SaveState = "idle" | "saving" | "saved" | "error";

function saveStatusText(state: SaveState, lastSavedAt: string | null, saveError: string | null): string {
  if (state === "saving") return "Saqlanmoqda…";
  if (state === "error") return saveError ? `Xato: ${saveError}` : "Xato — saqlanmadi";
  if (state === "saved" && lastSavedAt) {
    return `Saqlandi ${formatTime(lastSavedAt)}`;
  }
  return "";
}

export function PostEditorHeader({
  postId,
  status,
  saveState,
  saveError,
  lastSavedAt,
  onPublish,
  onUnpublish,
  onArchive,
  onDelete,
  onRefreshTelegraph,
  onOpenChannelSend,
}: {
  postId: string;
  status: AdminPostStatus;
  saveState: SaveState;
  saveError?: string | null;
  lastSavedAt: string | null;
  onPublish: () => Promise<void>;
  onUnpublish: () => Promise<void>;
  onArchive: () => Promise<void>;
  onDelete: () => Promise<void>;
  onRefreshTelegraph: () => void;
  onOpenChannelSend: () => void;
}) {
  const [publishOpen, setPublishOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handlePublish() {
    setBusy(true);
    await onPublish();
    setBusy(false);
    setPublishOpen(false);
  }

  async function handleDelete() {
    setBusy(true);
    await onDelete();
    setBusy(false);
    setDeleteOpen(false);
  }

  return (
    <div className="sticky top-0 z-30 -mx-4 flex flex-wrap items-center justify-between gap-2 border-b border-border bg-background/95 px-4 py-2.5 backdrop-blur-sm md:-mx-8 md:px-8">
      <div className="flex items-center gap-2.5">
        <PostStatusBadge status={status} />
        <span className="text-xs text-muted-foreground">
          {saveStatusText(saveState, lastSavedAt, saveError ?? null)}
        </span>
      </div>

      <div className="flex items-center gap-1.5">
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/admin/postlar/${postId}/preview`} target="_blank">
            <Eye className="size-4" />
            Ko&apos;rish
          </Link>
        </Button>

        <Button variant="ghost" size="sm" asChild>
          <Link href={`/admin/statistika/${postId}`}>
            <BarChart3 className="size-4" />
            Statistika
          </Link>
        </Button>

        {status === "published" ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void onUnpublish()}>
            Qoralamaga qaytarish
          </Button>
        ) : (
          <AlertDialog open={publishOpen} onOpenChange={setPublishOpen}>
            <Button size="sm" onClick={() => setPublishOpen(true)}>
              Chop etish
            </Button>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Postni chop etish</AlertDialogTitle>
                <AlertDialogDescription>
                  Post darhol saytda ommaga ko&apos;rinadi bo&apos;ladi.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
                <AlertDialogAction disabled={busy} onClick={() => void handlePublish()}>
                  Chop etish
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}

        <span title={status !== "published" ? "Faqat chop etilgan postlarni kanalga yuborish mumkin" : undefined}>
          <Button variant="outline" size="sm" disabled={status !== "published"} onClick={onOpenChannelSend}>
            <Send className="size-4" />
            Kanalga yuborish
          </Button>
        </span>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Ko'proq amallar">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onRefreshTelegraph}>
              <Send />
              Telegraph&apos;ni yangilash
            </DropdownMenuItem>
            {status !== "archived" ? (
              <DropdownMenuItem onSelect={() => void onArchive()}>
                <Archive />
                Arxivlash
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
              <Trash2 />
              O&apos;chirish
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Postni o&apos;chirish</AlertDialogTitle>
            <AlertDialogDescription>
              Post butunlay o&apos;chiriladi. Bu amalni ortga qaytarib bo&apos;lmaydi.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => void handleDelete()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              O&apos;chirish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

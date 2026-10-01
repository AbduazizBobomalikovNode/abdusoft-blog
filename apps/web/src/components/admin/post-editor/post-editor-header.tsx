"use client";

import { useState } from "react";
import Link from "next/link";
import { Archive, ArrowLeft, BarChart3, Eye, Keyboard, LayoutTemplate, Maximize2, MoreHorizontal, RefreshCw, Send, Star, Trash2, Undo2 } from "lucide-react";
import type { AdminPostStatus, ResolvedChannelChoice } from "@blog/shared";
import { PostStatusBadge } from "@/components/admin/post-status-badge";
import { formatTime } from "@/lib/format";
import { hasBlockingIssue, type ChecklistItem, type FixTarget } from "@/lib/editor/checklist";
import { PublishChecklist } from "@/components/admin/editor/publish-checklist";
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

/** Muharrir bilan bog'liq ixtiyoriy "⋯" menyu amallari (berilmasa ko'rsatilmaydi). */
export interface EditorMenuActions {
  onOpenInsert?: () => void;
  onToggleFocus?: () => void;
  onOpenShortcuts?: () => void;
}

function EditorMenuItems({ actions }: { actions?: EditorMenuActions }) {
  if (!actions) return null;
  return (
    <>
      {actions.onOpenInsert ? (
        <DropdownMenuItem className="min-h-11 md:min-h-0" data-testid="menu-insert-template" onSelect={actions.onOpenInsert}>
          <LayoutTemplate />
          Shablon qo&apos;shish
        </DropdownMenuItem>
      ) : null}
      {actions.onToggleFocus ? (
        <DropdownMenuItem className="min-h-11 max-md:hidden md:min-h-0" data-testid="menu-focus-mode" onSelect={actions.onToggleFocus}>
          <Maximize2 />
          Diqqat rejimi
        </DropdownMenuItem>
      ) : null}
      {actions.onOpenShortcuts ? (
        <DropdownMenuItem className="min-h-11 max-md:hidden md:min-h-0" onSelect={actions.onOpenShortcuts}>
          <Keyboard />
          Tezkor tugmalar
        </DropdownMenuItem>
      ) : null}
    </>
  );
}

export type SaveState = "idle" | "saving" | "saved" | "error" | "offline";

function saveStatusText(state: SaveState, lastSavedAt: string | null, saveError: string | null): string {
  if (state === "saving") return "Saqlanmoqda…";
  if (state === "offline") return "Oflayn — mahalliy saqlandi";
  if (state === "error") return saveError ? `Xato: ${saveError}` : "Xato — saqlanmadi";
  if (state === "saved" && lastSavedAt) {
    return `Saqlandi ${formatTime(lastSavedAt)}`;
  }
  return "";
}

/** Sticky sarlavha qatori uchun umumiy sinflar: mobil — bitta ixcham qator (tepada shell top-bar ostida), desktop — avvalgidek. */
export const EDITOR_HEADER_CLASS =
  "sticky top-0 z-30 -mx-4 flex items-center gap-2 border-b border-border bg-background/95 px-4 py-1.5 backdrop-blur-sm max-md:top-13 md:-mx-8 md:flex-wrap md:justify-between md:px-8 md:py-2.5";

/** Mobil: orqaga (postlar ro'yxati). Desktopda yashirin — sidebar bor. */
function MobileBackButton() {
  return (
    <Button variant="ghost" size="icon" asChild className="-ml-2 shrink-0 md:hidden max-md:size-11">
      <Link href="/admin/postlar" aria-label="Postlar ro'yxatiga qaytish">
        <ArrowLeft className="size-5" />
      </Link>
    </Button>
  );
}

/**
 * Holat nishoni + saqlash holati. Uzun xato matni qisqartiriladi (to'liq matn `title`da) —
 * aks holda qator gorizontal scroll keltirib chiqaradi.
 */
function StatusCluster({ status, text }: { status: AdminPostStatus; text: string }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 md:max-w-[50%] md:flex-none md:gap-2.5">
      <span className="shrink-0">
        <PostStatusBadge status={status} />
      </span>
      <span className="min-w-0 truncate text-xs text-muted-foreground" title={text || undefined}>
        {text}
      </span>
    </div>
  );
}

/** Xodim (staff) uchun sarlavha qatori: faqat "Ko'rish" va (ruxsat bo'lsa) "Ko'rib chiqishga yuborish". */
export function StaffEditorHeader({
  postId,
  status,
  saveState,
  saveError,
  lastSavedAt,
  canSubmit,
  onSubmit,
  onOpenChannelVersion,
  editorActions,
}: {
  postId: string;
  status: AdminPostStatus;
  saveState: SaveState;
  saveError?: string | null;
  lastSavedAt: string | null;
  canSubmit: boolean;
  onSubmit: () => void;
  editorActions?: EditorMenuActions;
  /** Xodim ham kanal versiyasini tayyorlay oladi (taklif) — yuborish YO'Q. */
  onOpenChannelVersion?: () => void;
}) {
  return (
    <div data-editor-header className={EDITOR_HEADER_CLASS}>
      <MobileBackButton />
      <StatusCluster status={status} text={saveStatusText(saveState, lastSavedAt, saveError ?? null)} />

      <div className="flex shrink-0 items-center gap-1.5">
        <Button variant="ghost" size="sm" asChild className="max-md:hidden">
          <Link href={`/admin/postlar/${postId}/preview`} target="_blank">
            Ko&apos;rish
          </Link>
        </Button>
        {onOpenChannelVersion ? (
          <Button variant="outline" size="sm" className="max-md:hidden" onClick={onOpenChannelVersion}>
            <Star className="size-4" />
            Kanal versiyasi
          </Button>
        ) : null}
        {canSubmit ? (
          <Button size="sm" className="max-md:h-11 max-md:px-3.5" aria-label="Ko'rib chiqishga yuborish" onClick={onSubmit}>
            <span className="md:hidden">Yuborish</span>
            <span className="hidden md:inline">Ko&apos;rib chiqishga yuborish</span>
          </Button>
        ) : null}

        {/* Mobil: ikkinchi darajali amallar "⋯" menyusida. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className={editorActions ? "size-11 md:size-8" : "size-11 md:hidden"} aria-label="Ko'proq amallar">
              <MoreHorizontal className="size-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuItem asChild className="min-h-11">
              <Link href={`/admin/postlar/${postId}/preview`} target="_blank">
                <Eye />
                Ko&apos;rish
              </Link>
            </DropdownMenuItem>
            {onOpenChannelVersion ? (
              <DropdownMenuItem className="min-h-11" onSelect={onOpenChannelVersion}>
                <Star />
                Kanal versiyasi
              </DropdownMenuItem>
            ) : null}
            <EditorMenuItems actions={editorActions} />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
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
  channelChoice = null,
  getChecklist,
  onFix,
  editorActions,
}: {
  postId: string;
  status: AdminPostStatus;
  saveState: SaveState;
  saveError?: string | null;
  lastSavedAt: string | null;
  onPublish: (opts?: { sendToChannel?: boolean }) => Promise<void>;
  onUnpublish: () => Promise<void>;
  onArchive: () => Promise<void>;
  onDelete: () => Promise<void>;
  onRefreshTelegraph: () => void;
  onOpenChannelSend: () => void;
  /** Belgilangan kanal versiyasi — chop etish dialogida ko'rsatiladi ("kanalga ham yuborilsin" katagi). */
  channelChoice?: ResolvedChannelChoice | null;
  /** Chop etish dialogi ochilganda hisoblanadigan tekshiruv ro'yxati (berilmasa — ko'rsatilmaydi). */
  getChecklist?: () => ChecklistItem[];
  /** "Tuzatish" bosilganda — tegishli maydonga o'tish. */
  onFix?: (target: FixTarget) => void;
  editorActions?: EditorMenuActions;
}) {
  const [publishOpen, setPublishOpen] = useState(false);
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const blocked = hasBlockingIssue(checklist);
  const [sendToChannel, setSendToChannel] = useState(false);
  const published = status === "published";
  const channelLabel = published ? "Kanalga yuborish" : "Kanal versiyasi";
  const channelDisabled = status === "archived";
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handlePublish() {
    setBusy(true);
    await onPublish(channelChoice && sendToChannel ? { sendToChannel: true } : undefined);
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
    <div data-editor-header className={EDITOR_HEADER_CLASS}>
      <MobileBackButton />
      <StatusCluster status={status} text={saveStatusText(saveState, lastSavedAt, saveError ?? null)} />

      <div className="flex shrink-0 items-center gap-1.5">
        {/* Desktop: ikkinchi darajali amallar alohida tugmalar. Mobilda ular "⋯" menyusida. */}
        <Button variant="ghost" size="sm" asChild className="max-md:hidden">
          <Link href={`/admin/postlar/${postId}/preview`} target="_blank">
            <Eye className="size-4" />
            Ko&apos;rish
          </Link>
        </Button>

        <Button variant="ghost" size="sm" asChild className="max-md:hidden">
          <Link href={`/admin/statistika/${postId}`}>
            <BarChart3 className="size-4" />
            Statistika
          </Link>
        </Button>

        {status === "published" ? (
          <>
            <Button
              variant="outline"
              size="sm"
              className="max-md:hidden"
              disabled={busy}
              onClick={() => void onUnpublish()}
            >
              Qoralamaga qaytarish
            </Button>
            {/* Mobil asosiy amal: nashr qilingan postda — kanalga yuborish. */}
            <Button
              variant="outline"
              size="sm"
              className="max-md:h-11 max-md:px-3.5 md:hidden"
              aria-label="Kanalga yuborish"
              onClick={onOpenChannelSend}
            >
              <Send className="size-4" />
              Kanalga
            </Button>
          </>
        ) : (
          <AlertDialog
            open={publishOpen}
            onOpenChange={(next) => {
              setPublishOpen(next);
              if (next) {
                setSendToChannel(false); // har safar o'chiq holatda ochiladi
                setChecklist(getChecklist?.() ?? []);
              }
            }}
          >
            <Button
              size="sm"
              className="max-md:h-11 max-md:px-3.5"
              onClick={() => {
                setSendToChannel(false); // har safar o'chiq holatda ochiladi
                setChecklist(getChecklist?.() ?? []);
                setPublishOpen(true);
              }}
            >
              Chop etish
            </Button>
            <AlertDialogContent className="max-h-[90svh] overflow-y-auto">
              <AlertDialogHeader>
                <AlertDialogTitle>Postni chop etish</AlertDialogTitle>
                <AlertDialogDescription>
                  Post darhol saytda ommaga ko&apos;rinadi bo&apos;ladi.
                </AlertDialogDescription>
              </AlertDialogHeader>
              {checklist.length > 0 ? (
                <PublishChecklist
                  items={checklist}
                  onFix={(target) => {
                    setPublishOpen(false);
                    onFix?.(target);
                  }}
                />
              ) : null}
              {channelChoice ? (
                <div className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm" data-testid="publish-channel-choice">
                  <p className="break-words">
                    Kanal versiyasi: <span className="font-medium">⭐ {channelChoice.label}</span>
                  </p>
                  <label className="flex min-h-11 cursor-pointer items-center gap-2 md:min-h-0">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={sendToChannel}
                      onChange={(event) => setSendToChannel(event.target.checked)}
                    />
                    Chop etilgach kanalga ham yuborilsin
                  </label>
                  <p className="text-xs text-muted-foreground">Belgilanmasa, kanalga yuborish qo&apos;lda qoladi.</p>
                </div>
              ) : null}
              <AlertDialogFooter>
                <AlertDialogCancel className="max-sm:h-11">Bekor qilish</AlertDialogCancel>
                <AlertDialogAction className="max-sm:h-11" disabled={busy || blocked} onClick={() => void handlePublish()}>
                  Chop etish
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}

        <span className="max-md:hidden" title={channelDisabled ? "Arxivlangan post uchun kanal versiyasi yo'q" : undefined}>
          <Button variant="outline" size="sm" disabled={channelDisabled} onClick={onOpenChannelSend}>
            {published ? <Send className="size-4" /> : <Star className="size-4" />}
            {channelLabel}
          </Button>
        </span>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="max-md:size-11" aria-label="Ko'proq amallar">
              <MoreHorizontal className="size-4 max-md:size-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            {/* Faqat mobilda: desktopda bular alohida tugmalar. */}
            <DropdownMenuItem asChild className="min-h-11 md:hidden">
              <Link href={`/admin/postlar/${postId}/preview`} target="_blank">
                <Eye />
                Ko&apos;rish
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild className="min-h-11 md:hidden">
              <Link href={`/admin/statistika/${postId}`}>
                <BarChart3 />
                Statistika
              </Link>
            </DropdownMenuItem>
            {!published ? (
              <DropdownMenuItem disabled={channelDisabled} className="min-h-11 md:hidden" onSelect={onOpenChannelSend}>
                <Star />
                Kanal versiyasi
              </DropdownMenuItem>
            ) : null}
            {status === "published" ? (
              <DropdownMenuItem disabled={busy} className="min-h-11 md:hidden" onSelect={() => void onUnpublish()}>
                <Undo2 />
                Qoralamaga qaytarish
              </DropdownMenuItem>
            ) : null}
            <EditorMenuItems actions={editorActions} />
            <DropdownMenuItem className="min-h-11 md:min-h-0" onSelect={onRefreshTelegraph}>
              <RefreshCw />
              Telegraph&apos;ni yangilash
            </DropdownMenuItem>
            {status !== "archived" ? (
              <DropdownMenuItem className="min-h-11 md:min-h-0" onSelect={() => void onArchive()}>
                <Archive />
                Arxivlash
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem variant="destructive" className="min-h-11 md:min-h-0" onSelect={() => setDeleteOpen(true)}>
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

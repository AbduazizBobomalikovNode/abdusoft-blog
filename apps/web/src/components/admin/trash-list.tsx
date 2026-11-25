"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import type { TrashPostListItem } from "@blog/shared";
import { EmptyState } from "@/components/admin/empty-state";
import { PostStatusBadge } from "@/components/admin/post-status-badge";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AdminApiError, adminApi } from "@/lib/admin-client";
import { formatDateTime } from "@/lib/format";

/** O'chirgan kim: ism, hisob o'chirilgan/noma'lum bo'lsa neytral matn (`null` hech qachon sahifani buzmaydi). */
export function deletedByText(item: Pick<TrashPostListItem, "deletedBy">): string {
  if (!item.deletedBy) return "Noma'lum";
  return item.deletedBy.name ?? "Xodim";
}

/** Tiklashdan keyingi xabar: asl havola band bo'lsa, yangi havolani aniq aytadi. */
export function restoreMessage(result: { slugRestored: boolean; slug: string; originalSlug: string }): {
  kind: "success" | "warning";
  text: string;
} {
  if (result.slugRestored) return { kind: "success", text: "Post savatdan tiklandi" };
  return {
    kind: "warning",
    text: `Post tiklandi, lekin avvalgi havola (/${result.originalSlug}) band bo'lgani uchun yangi havola berildi: /${result.slug}`,
  };
}

function RowActions({
  item,
  isAdmin,
  busy,
  onRestore,
  onPurge,
}: {
  item: TrashPostListItem;
  isAdmin: boolean;
  busy: boolean;
  onRestore: () => void;
  onPurge: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 md:flex-nowrap">
      <Button size="sm" variant="outline" className="max-md:h-11" disabled={busy} onClick={onRestore} data-testid={`trash-restore-${item.id}`}>
        <Undo2 className="size-4" />
        Tiklash
      </Button>
      {isAdmin ? (
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive max-md:h-11"
          disabled={busy}
          onClick={onPurge}
          data-testid={`trash-purge-${item.id}`}
        >
          <Trash2 className="size-4" />
          Butunlay o&apos;chirish
        </Button>
      ) : null}
    </div>
  );
}

export function TrashList({ items, isAdmin = true }: { items: TrashPostListItem[]; isAdmin?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<TrashPostListItem | null>(null);

  function restore(item: TrashPostListItem) {
    setBusyId(item.id);
    startTransition(async () => {
      try {
        const result = await adminApi.restoreTrashedPost(item.id);
        const message = restoreMessage(result);
        if (message.kind === "warning") {
          toast.warning(message.text, {
            duration: 15000,
            action: { label: "Ochish", onClick: () => router.push(`/admin/postlar/${item.id}`) },
          });
        } else {
          toast.success(message.text);
        }
        router.refresh();
      } catch (error) {
        toast.error(error instanceof AdminApiError ? error.message : "Tiklab bo'lmadi");
      } finally {
        setBusyId(null);
      }
    });
  }

  async function purge(item: TrashPostListItem) {
    setBusyId(item.id);
    try {
      await adminApi.purgeTrashedPost(item.id);
      toast.success("Post butunlay o'chirildi");
      setPurgeTarget(null);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "O'chirib bo'lmadi");
    } finally {
      setBusyId(null);
    }
  }

  if (items.length === 0) {
    return <EmptyState icon={Trash2} message="Savat bo'sh. O'chirilgan postlar shu yerda 'tiklash' uchun saqlanadi." />;
  }

  return (
    <>
      {/* Mobil kartalar */}
      <ul className="flex flex-col gap-2 md:hidden" aria-label="Savatdagi postlar">
        {items.map((item) => (
          <li key={item.id} className="flex flex-col gap-2 rounded-lg border border-border p-3" data-testid="trash-row">
            <div className="min-w-0">
              <p className="line-clamp-2 text-sm font-medium break-words">{item.title}</p>
              <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={`/${item.slug}`}>
                /{item.slug}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <PostStatusBadge status={item.status} />
              <span>
                {deletedByText(item)} · {formatDateTime(item.deletedAt)}
              </span>
            </div>
            <RowActions item={item} isAdmin={isAdmin} busy={pending && busyId === item.id} onRestore={() => restore(item)} onPurge={() => setPurgeTarget(item)} />
          </li>
        ))}
      </ul>

      {/* Desktop jadval */}
      <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Sarlavha</TableHead>
              <TableHead>Havola</TableHead>
              <TableHead>Oldingi holat</TableHead>
              <TableHead>O&apos;chirgan</TableHead>
              <TableHead>Qachon</TableHead>
              <TableHead className="w-px" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id} data-testid="trash-row">
                <TableCell className="max-w-64">
                  <span className="block truncate font-medium" title={item.title}>
                    {item.title}
                  </span>
                </TableCell>
                <TableCell className="max-w-48 font-mono text-xs text-muted-foreground">
                  <span className="block truncate" title={`/${item.slug}`}>
                    /{item.slug}
                  </span>
                </TableCell>
                <TableCell>
                  <PostStatusBadge status={item.status} />
                </TableCell>
                <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{deletedByText(item)}</TableCell>
                <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{formatDateTime(item.deletedAt)}</TableCell>
                <TableCell>
                  <RowActions item={item} isAdmin={isAdmin} busy={pending && busyId === item.id} onRestore={() => restore(item)} onPurge={() => setPurgeTarget(item)} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={purgeTarget !== null} onOpenChange={(open) => (open ? undefined : setPurgeTarget(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Postni butunlay o&apos;chirish</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{purgeTarget?.title}&quot; butunlay o&apos;chiriladi. Bu amalni ortga qaytarib bo&apos;lmaydi: postning fikrlari,
              kanal versiyalari va Tarixi ham o&apos;chadi.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction
              disabled={busyId !== null}
              onClick={(event) => {
                event.preventDefault();
                if (purgeTarget) void purge(purgeTarget);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Butunlay o&apos;chirish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

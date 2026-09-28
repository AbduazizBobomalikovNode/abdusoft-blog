"use client";

import { useState } from "react";
import Link from "next/link";
import { ShieldBan } from "lucide-react";
import { toast } from "sonner";
import type { BannedDevice } from "@blog/shared";
import { EmptyState } from "@/components/admin/empty-state";
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

function shortHash(hash: string | null): string {
  if (!hash) return "—";
  return `${hash.slice(0, 10)}…`;
}

function BanRow({ ban, onRemoved }: { ban: BannedDevice; onRemoved: (id: string) => void }) {
  const [open, setOpen] = useState(false);

  async function handleUnban() {
    try {
      await adminApi.unban(ban.id);
      toast.success("Blok bekor qilindi");
      setOpen(false);
      onRemoved(ban.id);
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Bekor qilib bo'lmadi");
    }
  }

  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{shortHash(ban.deviceHash)}</TableCell>
      <TableCell className="font-mono text-xs">{shortHash(ban.ipHash)}</TableCell>
      <TableCell className="text-sm text-muted-foreground">{ban.reason ?? "—"}</TableCell>
      <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{formatDateTime(ban.createdAt)}</TableCell>
      <TableCell>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          Bekor qilish
        </Button>
      </TableCell>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Blokni bekor qilish</AlertDialogTitle>
            <AlertDialogDescription>Bu qurilma qaytadan fikr bildira oladi.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction onClick={handleUnban}>Tasdiqlash</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TableRow>
  );
}

export function BansTable({ initialBans }: { initialBans: BannedDevice[] }) {
  const [bans, setBans] = useState(initialBans);

  if (bans.length === 0) {
    return (
      <EmptyState
        icon={ShieldBan}
        message="Hozircha bloklangan qurilmalar yo'q."
        action={
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/fikrlar">Fikrlarga o&apos;tish</Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Qurilma</TableHead>
            <TableHead>IP</TableHead>
            <TableHead>Sabab</TableHead>
            <TableHead>Sana</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {bans.map((ban) => (
            <BanRow key={ban.id} ban={ban} onRemoved={(id) => setBans((prev) => prev.filter((b) => b.id !== id))} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

"use client";

import { useState } from "react";
import { Check, Copy, Users } from "lucide-react";
import { toast } from "sonner";
import type { StaffInvite, StaffMember } from "@blog/shared";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AdminApiError, adminApi } from "@/lib/admin-client";
import { formatDateTime } from "@/lib/format";

const STATUS_LABEL: Record<StaffInvite["status"], string> = {
  active: "Faol",
  used: "Ishlatilgan",
  expired: "Muddati tugagan",
  revoked: "Bekor qilingan",
};

function StatusBadge({ status }: { status: StaffInvite["status"] }) {
  const color =
    status === "active"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      : status === "used"
        ? "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-400"
        : "border-border bg-muted text-muted-foreground";
  return <span className={`rounded-full border px-2 py-0.5 text-xs ${color}`}>{STATUS_LABEL[status]}</span>;
}

function InviteCreatedDialog({
  open,
  onOpenChange,
  url,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  url: string | null;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Havola nusxalandi");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Nusxalab bo'lmadi — havolani qo'lda tanlang");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Taklif havolasi tayyor</DialogTitle>
          <DialogDescription>
            Bu havola FAQAT HOZIR ko&apos;rsatiladi — keyinroq qayta ko&apos;rib bo&apos;lmaydi. Xodimga xavfsiz kanal
            orqali yuboring.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <code className="min-w-0 flex-1 truncate text-xs">{url}</code>
          <Button type="button" size="icon-sm" variant="outline" onClick={() => void handleCopy()} aria-label="Nusxalash">
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          </Button>
        </div>
        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Tushunarli
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateInviteDialog({ onCreated }: { onCreated: (invite: StaffInvite, url: string) => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleCreate() {
    setBusy(true);
    try {
      const result = await adminApi.createStaffInvite(note.trim() || undefined);
      onCreated(result.invite, result.url);
      setOpen(false);
      setNote("");
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Taklif yaratib bo'lmadi");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button type="button" onClick={() => setOpen(true)}>
        Xodim taklif qilish
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Yangi xodim taklif qilish</DialogTitle>
          <DialogDescription>
            Bir martalik havola yaratiladi (7 kun amal qiladi). Xodim havola orqali GitHub bilan kiradi.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="invite-note">Kim uchun (ixtiyoriy)</Label>
          <Input
            id="invite-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Masalan: Aziz (kontent yozuvchi)"
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Bekor qilish
          </Button>
          <Button type="button" disabled={busy} onClick={() => void handleCreate()}>
            {busy ? "Yaratilmoqda…" : "Havola yaratish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StaffRow({ member, onRemoved }: { member: StaffMember; onRemoved: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleRemove() {
    setBusy(true);
    try {
      await adminApi.removeStaffMember(member.id);
      toast.success("Xodim olib tashlandi");
      setOpen(false);
      onRemoved(member.id);
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Olib tashlab bo'lmadi");
    } finally {
      setBusy(false);
    }
  }

  return (
    <TableRow>
      <TableCell className="flex items-center gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {member.image ? <img src={member.image} alt="" className="size-6 rounded-full" /> : null}
        <span className="font-medium">{member.name ?? member.email}</span>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">{member.email}</TableCell>
      <TableCell className="text-sm text-muted-foreground">{member.postsCount}</TableCell>
      <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{formatDateTime(member.addedAt)}</TableCell>
      <TableCell>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          Olib tashlash
        </Button>
      </TableCell>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xodimni olib tashlash</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{member.name ?? member.email}&quot; endi admin panelga kira olmaydi (rol oddiy foydalanuvchiga
              qaytariladi, sessiyalari tugatiladi). Yozgan postlari saqlanib qoladi.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void handleRemove()}>
              Olib tashlash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TableRow>
  );
}

function InviteRow({
  invite,
  token,
  onRevoked,
}: {
  invite: StaffInvite;
  token: string | null;
  onRevoked: (id: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/taklif/${token}`);
      setCopied(true);
      toast.success("Havola nusxalandi");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Nusxalab bo'lmadi");
    }
  }

  async function handleRevoke() {
    try {
      await adminApi.revokeStaffInvite(invite.id);
      toast.success("Taklif bekor qilindi");
      onRevoked(invite.id);
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Bekor qilib bo'lmadi");
    }
  }

  return (
    <TableRow>
      <TableCell className="text-sm">{invite.note ?? "—"}</TableCell>
      <TableCell>
        <StatusBadge status={invite.status} />
      </TableCell>
      <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{formatDateTime(invite.createdAt)}</TableCell>
      <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{formatDateTime(invite.expiresAt)}</TableCell>
      <TableCell>
        <div className="flex items-center gap-1.5">
          {invite.status === "active" ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!token}
                title={token ? undefined : "Havola faqat yaratilgan zahoti ko'rsatiladi"}
                onClick={() => void handleCopy()}
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                Nusxalash
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => void handleRevoke()}>
                Bekor qilish
              </Button>
            </>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

export function XodimlarClient({
  initialStaff,
  initialInvites,
}: {
  initialStaff: StaffMember[];
  initialInvites: StaffInvite[];
}) {
  const [staff, setStaff] = useState(initialStaff);
  const [invites, setInvites] = useState(initialInvites);
  const [tokensById, setTokensById] = useState<Record<string, string>>({});
  const [createdDialogOpen, setCreatedDialogOpen] = useState(false);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);

  function handleCreated(invite: StaffInvite, url: string) {
    setInvites((prev) => [invite, ...prev]);
    const token = url.split("/taklif/")[1] ?? "";
    setTokensById((prev) => ({ ...prev, [invite.id]: token }));
    setCreatedUrl(url);
    setCreatedDialogOpen(true);
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">Xodimlar ({staff.length})</h2>
        </div>

        {staff.length === 0 ? (
          <EmptyState icon={Users} message="Hali xodim qo'shilmagan." />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ism</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Postlar</TableHead>
                  <TableHead>Qo&apos;shilgan</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {staff.map((member) => (
                  <StaffRow
                    key={member.id}
                    member={member}
                    onRemoved={(id) => setStaff((prev) => prev.filter((s) => s.id !== id))}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">Takliflar ({invites.length})</h2>
          <CreateInviteDialog onCreated={handleCreated} />
        </div>

        {invites.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            Hali taklif yaratilmagan.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Izoh</TableHead>
                  <TableHead>Holat</TableHead>
                  <TableHead>Yaratilgan</TableHead>
                  <TableHead>Muddati</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {invites.map((invite) => (
                  <InviteRow
                    key={invite.id}
                    invite={invite}
                    token={tokensById[invite.id] ?? null}
                    onRevoked={(id) =>
                      setInvites((prev) => prev.map((i) => (i.id === id ? { ...i, status: "revoked" } : i)))
                    }
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <InviteCreatedDialog open={createdDialogOpen} onOpenChange={setCreatedDialogOpen} url={createdUrl} />
    </div>
  );
}

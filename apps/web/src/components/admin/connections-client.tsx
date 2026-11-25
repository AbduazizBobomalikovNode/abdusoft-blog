"use client";

import { useState } from "react";
import { Plug, ShieldAlert, Unplug } from "lucide-react";
import { toast } from "sonner";
import type { McpConnection } from "@blog/shared";
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
import { AdminApiError, adminApi } from "@/lib/admin-client";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { describeConnectionPermissions, displayClientName, inactiveConnectionScopes } from "@/lib/oauth-flow";
import { MCP_SCOPES, MCP_SCOPE_GROUP_LABELS, type McpScopeGroup } from "@blog/shared";
import { cn } from "@/lib/utils";

const GROUP_CHIP: Record<McpScopeGroup, string> = {
  read: "border-border",
  write: "border-sky-500/40 bg-sky-500/10",
  publish: "border-amber-500/40 bg-amber-500/10",
  danger: "border-destructive/40 bg-destructive/10 text-destructive",
};

function PermissionList({ perms, inactive }: { perms: ReturnType<typeof describeConnectionPermissions>; inactive: string[] }) {
  const inactiveLabels = new Set(MCP_SCOPES.filter((s) => inactive.includes(s.id)).map((s) => s.label));
  return (
    <div className="flex flex-col gap-1.5">
      {perms.readOnly ? (
        <span className="w-fit rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">Faqat o&apos;qiydi</span>
      ) : null}
      {perms.groups
        .filter((g) => !(perms.readOnly && g.group === "read"))
        .map((g) => (
          <div key={g.group} className="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-3">
            <span className="shrink-0 pt-0.5 text-xs sm:w-32 font-semibold uppercase tracking-wide text-muted-foreground">{MCP_SCOPE_GROUP_LABELS[g.group]}</span>
            <div className="flex min-w-0 flex-wrap gap-1.5">
            {g.labels.map((label) => (
              <span
                key={label}
                className={cn("rounded-full border px-2 py-0.5 text-xs", GROUP_CHIP[g.group], inactiveLabels.has(label) && "opacity-60 line-through decoration-1")}
                title={inactiveLabels.has(label) ? "Hozir ishlamaydi: serverda yozuv vositalari o'chirilgan" : undefined}
              >
                {g.group === "danger" ? <ShieldAlert className="mr-1 inline size-3" aria-hidden="true" /> : null}
                {label}
              </span>
            ))}
            </div>
          </div>
        ))}
      {inactive.length > 0 ? (
        <p role="note" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-200">
          Serverda yozuv vositalari o&apos;chirilgan: bu ruxsatlar hozir ishlamaydi.
        </p>
      ) : null}
    </div>
  );
}

function ConnectionRow({ connection, writeToolsEnabled, onRevoked }: { connection: McpConnection; writeToolsEnabled?: boolean; onRevoked: (clientId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const perms = describeConnectionPermissions(connection.scopes);
  const name = displayClientName(connection.name);

  async function handleRevoke() {
    setBusy(true);
    try {
      await adminApi.revokeConnection(connection.clientId);
      toast.success("Ilova uzildi");
      setOpen(false);
      onRevoked(connection.clientId);
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Uzib bo'lmadi");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium [overflow-wrap:anywhere]">{name}</div>
          {connection.redirectHost ? <div className="text-xs text-muted-foreground">{connection.redirectHost}</div> : null}
        </div>
        <Button variant="outline" size="sm" className="shrink-0 max-md:min-h-11" onClick={() => setOpen(true)}>
          Uzish
        </Button>
      </div>
      <PermissionList perms={perms} inactive={inactiveConnectionScopes(connection.scopes, writeToolsEnabled)} />
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
        <div className="flex gap-1.5">
          <dt>Ulangan:</dt>
          <dd>{formatDateTime(connection.connectedAt)}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt>So&apos;nggi faollik:</dt>
          <dd>{connection.lastUsedAt ? formatRelativeTime(connection.lastUsedAt) : "hali ishlatilmagan"}</dd>
        </div>
      </dl>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>&quot;{name}&quot; uzilsinmi?</AlertDialogTitle>
            <AlertDialogDescription>
              Ilova blogga kirish huquqini darhol yo&apos;qotadi: ochiq ulanish to&apos;xtaydi va yangilash kaliti o&apos;chiriladi. Qayta ishlatish
              uchun ulanishni boshidan ruxsat berib boshlash kerak bo&apos;ladi.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void handleRevoke()}>
              {busy ? "Uzilmoqda…" : "Uzish"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

function RevokeAllButton({ count, onDone }: { count: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handle() {
    setBusy(true);
    try {
      await adminApi.revokeAllConnections();
      toast.success("Barcha ilovalar uzildi");
      setOpen(false);
      onDone();
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Uzib bo'lmadi");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        <Unplug className="size-4" aria-hidden="true" />
        Hammasini uzish
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Barcha {count} ta ilova uzilsinmi?</AlertDialogTitle>
            <AlertDialogDescription>
              Hamma ilovaning kirish huquqi darhol yo&apos;qoladi: ochiq ulanishlar to&apos;xtaydi, yangilash kalitlari va hali ishlatilmagan ruxsat kodlari
              o&apos;chiriladi. Qayta ishlatish uchun har birini boshidan ulash kerak bo&apos;ladi. Telefon yo&apos;qolganda yoki shubha bo&apos;lsa shuni bosing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void handle()}>
              {busy ? "Uzilmoqda…" : "Hammasini uzish"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** `initial === null` — konnektor serverda o'chiq (yoki API javob bermadi). */
export function ConnectionsClient({ initial, writeToolsEnabled }: { initial: McpConnection[] | null; writeToolsEnabled?: boolean }) {
  const [items, setItems] = useState<McpConnection[]>(initial ?? []);

  if (initial === null) {
    return (
      <EmptyState
        icon={Plug}
        message="Claude konnektori serverda yoqilmagan (yoki server hozir javob bermayapti). Yoqish uchun API'da MCP_ENABLED=true qo'ying — docs/claude-connector.md'ga qarang."
      />
    );
  }

  if (items.length === 0) {
    return <EmptyState icon={Plug} message="Hozircha hech qanday ilova ulanmagan. Claude'da Customize → Connectors orqali ulang." />;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <RevokeAllButton count={items.length} onDone={() => setItems([])} />
      </div>
      <ul className="flex flex-col gap-3">
        {items.map((connection) => (
          <ConnectionRow
            key={connection.clientId}
            connection={connection}
            writeToolsEnabled={writeToolsEnabled}
            onRevoked={(clientId) => setItems((current) => current.filter((item) => item.clientId !== clientId))}
          />
        ))}
      </ul>
    </div>
  );
}

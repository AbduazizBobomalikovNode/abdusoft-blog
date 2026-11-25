"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { auditHref, type AuditQueryState } from "@/lib/audit-view";
import { AUDIT_ACTION_OPTIONS, AUDIT_ENTITY_OPTIONS, VIA_VALUES, isAutomatedVia, viaLabel } from "@/lib/admin-labels";
import { cn } from "@/lib/utils";

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

type TimePreset = "all" | "today" | "7d" | "30d" | "custom";

function presetFor(from?: string, to?: string): TimePreset {
  if (!from && !to) return "all";
  const today = toDateOnly(new Date());
  if (from === today && to === today) return "today";
  if (to === today && from) {
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
    if (days === 6) return "7d";
    if (days === 29) return "30d";
  }
  return "custom";
}

function rangeForPreset(preset: TimePreset): { from?: string; to?: string } {
  if (preset === "all") return {};
  const today = new Date();
  const to = toDateOnly(today);
  if (preset === "today") return { from: to, to };
  const days = preset === "7d" ? 6 : 29;
  const from = new Date(today);
  from.setDate(from.getDate() - days);
  return { from: toDateOnly(from), to };
}

/** Manba (`via`) tezkor tablari — odam bo'lmagan manbalar alohida rangda, shunda ularni bir bosishda ajratib olish mumkin. */
export function AuditViaTabs({ state }: { state: AuditQueryState }) {
  const tabs: { value: string | undefined; label: string }[] = [
    { value: undefined, label: "Hammasi" },
    ...VIA_VALUES.map((via) => ({ value: via as string, label: viaLabel(via) })),
  ];
  return (
    <div className="flex flex-wrap gap-1.5 border-b border-border pb-3" role="group" aria-label="Manba bo'yicha filtr">
      {tabs.map((tab) => {
        const active = state.via === tab.value;
        const automated = isAutomatedVia(tab.value);
        return (
          <Link
            key={tab.value ?? "all"}
            href={auditHref(state, { via: tab.value })}
            aria-current={active ? "true" : undefined}
            data-testid={`via-tab-${tab.value ?? "all"}`}
            className={cn(
              "flex items-center rounded-full border px-3 py-1 text-sm font-medium max-md:min-h-11",
              active
                ? automated
                  ? "border-violet-600 bg-violet-600 text-white dark:border-violet-400 dark:bg-violet-400 dark:text-violet-950"
                  : "border-foreground bg-foreground text-background"
                : automated
                  ? "border-violet-500/40 text-violet-700 hover:border-violet-500 dark:text-violet-300"
                  : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}

export function AuditFilters({ state }: { state: AuditQueryState }) {
  const router = useRouter();
  const go = (overrides: Partial<Record<keyof AuditQueryState, string | undefined>>) => router.push(auditHref(state, overrides));
  const preset = presetFor(state.from, state.to);

  return (
    <div className="grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap">
      <Select value={state.entityType ?? "all"} onValueChange={(value) => go({ entityType: value === "all" ? undefined : value, action: undefined })}>
        <SelectTrigger size="sm" className="w-full max-md:h-11 sm:w-40" aria-label="Obyekt turi">
          <SelectValue placeholder="Obyekt" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Obyekt: hammasi</SelectItem>
          {AUDIT_ENTITY_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="order-last col-span-2 sm:order-none sm:col-span-1">
      <Select value={state.action ?? "all"} onValueChange={(value) => go({ action: value === "all" ? undefined : value })}>
        <SelectTrigger size="sm" className="w-full max-md:h-11 sm:w-52" aria-label="Amal">
          <SelectValue placeholder="Amal" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Amal: hammasi</SelectItem>
          {AUDIT_ACTION_OPTIONS.filter((option) => !state.entityType || option.value.startsWith(`${state.entityType}.`) || state.entityType === "staff_invite" || state.entityType === "user").map(
            (option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ),
          )}
        </SelectContent>
      </Select>
      </div>

      <Select
        value={preset}
        onValueChange={(value) => go({ ...({ from: undefined, to: undefined } as const), ...rangeForPreset(value as TimePreset) })}
      >
        <SelectTrigger size="sm" className="w-full max-md:h-11 sm:w-36" aria-label="Vaqt">
          <SelectValue placeholder="Vaqt" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Vaqt: hammasi</SelectItem>
          <SelectItem value="today">Bugun</SelectItem>
          <SelectItem value="7d">7 kun</SelectItem>
          <SelectItem value="30d">30 kun</SelectItem>
          <SelectItem value="custom">Boshqa oraliq…</SelectItem>
        </SelectContent>
      </Select>

      {preset === "custom" ? (
        <div className="order-last col-span-2 flex items-center gap-1.5 sm:order-none sm:col-span-1">
          <Input
            type="date"
            aria-label="Boshlanish sanasi"
            defaultValue={state.from}
            className="w-36 max-md:h-11"
            onChange={(event) => go({ from: event.target.value || undefined })}
          />
          <span className="text-xs text-muted-foreground">—</span>
          <Input
            type="date"
            aria-label="Tugash sanasi"
            defaultValue={state.to}
            className="w-36 max-md:h-11"
            onChange={(event) => go({ to: event.target.value || undefined })}
          />
        </div>
      ) : null}
    </div>
  );
}

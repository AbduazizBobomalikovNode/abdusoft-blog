"use client";

import { useState, type ReactNode } from "react";
import { DISTRIBUTION_PLAN_MAX_DELAY_MINUTES, clampDelay, delayLead, isPresetDelay, delayPickerModel } from "@/lib/distribution-plan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { absoluteTimeError, formatChannelAt, isoToLocalInput } from "@/lib/distribution-telegram";
import { localInputToIso, minScheduleInput } from "@/lib/distribution-ui";
import { cn } from "cn";

/** Aniq vaqt (ABSOLUT) rejimi — ixtiyoriy: berilmasa tanlagich avvalgidek faqat "saytga chiqqach". */
export interface AbsoluteTimeOption {
  /** Tanlangan vaqt (ISO) yoki `null` — nisbiy ("saytga chiqqach") rejim. */
  sendAt: string | null;
  onChange: (sendAt: string | null) => void;
  /** Eng erta vaqt (`datetime-local` formatida): rejalashtirilgan postda — post saytga chiqish vaqti. */
  minLocal?: string;
}

/** `datetime-local` + holat qatori ("Kanalga 28.11 14:30 da yuboriladi") — chop etilgan postdagi yuborish bloki ham shuni ishlatadi. */
export function AbsoluteTimeField({ sendAt, onChange, minLocal, disabled = false, testId = "dist-plan-absolute" }: { sendAt: string | null; onChange: (iso: string) => void; minLocal?: string; disabled?: boolean; testId?: string }) {
  const local = isoToLocalInput(sendAt);
  const error = local ? absoluteTimeError(local, { notBeforeLocal: minLocal }) : null;
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <Label htmlFor={`${testId}-input`} className="text-xs">Kanalga yuborish vaqti</Label>
      <input
        id={`${testId}-input`}
        type="datetime-local"
        min={minLocal && minLocal > minScheduleInput() ? minLocal : minScheduleInput()}
        value={local}
        disabled={disabled}
        onChange={(e) => {
          const iso = localInputToIso(e.target.value);
          if (iso) onChange(iso);
        }}
        className="h-9 w-fit rounded-md border border-input bg-background px-2 text-sm max-md:h-11 max-md:w-full"
      />
      <p className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")} data-testid={`${testId}-status`}>
        {error ?? (sendAt ? `Kanalga ${formatChannelAt(sendAt)} da yuboriladi.` : "Vaqtni tanlang.")}
      </p>
    </div>
  );
}

/**
 * "Saytga chiqqach N daqiqadan keyin" tanlagich — barcha tarqatish kanallari va Telegram uchun BITTA komponent:
 * tayyorlar (Darhol/15 daq/1 soat/3 soat/1 kun) + "Boshqa" (0..10080 daqiqa, qirqiladi). Yorliqlar va hisoblash `lib/distribution-plan.ts`da (testlangan).
 */
export function DelayPlanPicker({
  value,
  onChange,
  disabled = false,
  hint,
  testId = "dist-plan-editor",
  absolute,
}: {
  value: number;
  onChange: (minutes: number) => void;
  disabled?: boolean;
  /** Asosiy izohdan keyingi qo'shimcha matn (kanalga xos). */
  hint?: ReactNode;
  testId?: string;
  /** Ixtiyoriy: berilsa "Saytga chiqqach | Aniq vaqt" tanlovi chiqadi (Telegram uchun yoqiladi); berilmasa eski ko'rinish. */
  absolute?: AbsoluteTimeOption;
}) {
  const [customMode, setCustomMode] = useState(() => !isPresetDelay(value));
  const model = delayPickerModel(value, customMode);
  const lead = delayLead(value);
  const absoluteOn = absolute !== undefined && absolute.sendAt !== null;
  const modeToggle = absolute ? (
    <div className="inline-flex w-fit rounded-lg bg-muted p-1" role="group" aria-label="Yuborish rejimi" data-testid={`${testId}-mode`}>
      <button type="button" disabled={disabled} aria-pressed={!absoluteOn} data-testid="dist-mode-relative" onClick={() => absolute.onChange(null)} className={cn("rounded-md px-2.5 py-1 text-xs font-medium max-md:min-h-11", !absoluteOn ? "bg-background shadow-sm" : "text-muted-foreground")}>Saytga chiqqach</button>
      <button
        type="button"
        disabled={disabled}
        aria-pressed={absoluteOn}
        data-testid="dist-mode-absolute"
        onClick={() => {
          if (absoluteOn) return;
          const start = isoToLocalInput(new Date(Date.now() + 3_600_000).toISOString());
          const floor = absolute.minLocal && absolute.minLocal > start ? absolute.minLocal : start;
          absolute.onChange(localInputToIso(floor) ?? new Date(Date.now() + 3_600_000).toISOString());
        }}
        className={cn("rounded-md px-2.5 py-1 text-xs font-medium max-md:min-h-11", absoluteOn ? "bg-background shadow-sm" : "text-muted-foreground")}
      >
        Aniq vaqt
      </button>
    </div>
  ) : null;
  if (absolute && absoluteOn) {
    return (
      <div className="flex flex-col gap-2" data-testid={testId}>
        {modeToggle}
        <AbsoluteTimeField sendAt={absolute.sendAt} onChange={absolute.onChange} minLocal={absolute.minLocal} disabled={disabled} />
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      {modeToggle}
      <Label className="text-xs">Post chop etilgach necha daqiqadan keyin yuborilsin</Label>
      <div className="flex flex-wrap items-center gap-1.5">
        {model.presets.map((p) => (
          <Button key={p.value} type="button" size="sm" variant={p.active ? "default" : "outline"} disabled={disabled} className="max-md:h-11" onClick={() => { setCustomMode(false); onChange(p.value); }}>
            {p.label}
          </Button>
        ))}
        <Button type="button" size="sm" variant={model.customActive ? "default" : "outline"} disabled={disabled} className="max-md:h-11" onClick={() => setCustomMode(true)}>
          Boshqa
        </Button>
        {model.customActive ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              max={DISTRIBUTION_PLAN_MAX_DELAY_MINUTES}
              step={1}
              value={value}
              disabled={disabled}
              onChange={(e) => onChange(clampDelay(e.target.value))}
              className="w-24 max-md:h-11"
              aria-label="Kechikish (daqiqa)"
            />{" "}
            daq
          </span>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Post saytga chiqqach <b>{lead.amount}</b>
        {lead.after} yuboriladi{lead.tail}. {hint}
      </p>
    </div>
  );
}

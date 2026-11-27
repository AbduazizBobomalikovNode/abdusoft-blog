"use client";

import { useState, type ReactNode } from "react";
import { DISTRIBUTION_PLAN_MAX_DELAY_MINUTES, clampDelay, delayLead, delayPickerModel } from "@/lib/distribution-plan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
}: {
  value: number;
  onChange: (minutes: number) => void;
  disabled?: boolean;
  /** Asosiy izohdan keyingi qo'shimcha matn (kanalga xos). */
  hint?: ReactNode;
  testId?: string;
}) {
  const [customMode, setCustomMode] = useState(false);
  const model = delayPickerModel(value, customMode);
  const lead = delayLead(value);
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
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

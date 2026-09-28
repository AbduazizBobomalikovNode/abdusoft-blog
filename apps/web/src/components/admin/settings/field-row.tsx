"use client";

import { useState } from "react";
import { Eye, EyeOff, Lock } from "lucide-react";
import type { AdminField } from "@blog/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Maydon `source: "env"` bo'lsa — o'zgartirib bo'lmasligini bildiruvchi qulf belgisi, tooltip'da env nomi bilan. */
export function LockBadge({ envVar }: { envVar: string | null }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[0.65rem] font-medium text-muted-foreground">
          <Lock className="size-2.5" aria-hidden="true" />
          env&apos;dan qulflangan
        </span>
      </TooltipTrigger>
      <TooltipContent>{envVar ? `${envVar} muhit o'zgaruvchisi orqali o'rnatilgan` : "Muhit o'zgaruvchisi orqali o'rnatilgan"}</TooltipContent>
    </Tooltip>
  );
}

function FieldShell({
  id,
  label,
  hint,
  field,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  field: { source: string; envVar: string | null };
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={id}>{label}</Label>
        {field.source === "env" ? <LockBadge envVar={field.envVar} /> : null}
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {children}
    </div>
  );
}

export function TextFieldRow({
  id,
  label,
  hint,
  field,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  hint?: string;
  field: AdminField<string>;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <FieldShell id={id} label={label} hint={hint} field={field}>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        disabled={field.source === "env"}
        onChange={(e) => onChange(e.target.value)}
      />
    </FieldShell>
  );
}

export function SwitchFieldRow({
  id,
  label,
  hint,
  field,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  field: AdminField<boolean>;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <div className="flex flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={id}>{label}</Label>
          {field.source === "env" ? <LockBadge envVar={field.envVar} /> : null}
        </div>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <Switch id={id} checked={checked} disabled={field.source === "env"} onCheckedChange={onChange} />
    </div>
  );
}

/**
 * Sirli (secret) maydon: saqlangan qiymat maskalangan holda (`••••1234`)
 * ko'rsatiladi. "O'zgartirish" bosilgandagina real input ochiladi (ko'rish
 * ko'zi bilan) — shu vaqtgacha `draftValue` `undefined` bo'lib qoladi, ya'ni
 * saqlashda bu maydon umuman yuborilmaydi (saqlangan sir o'zgarishsiz qoladi).
 */
export function SecretFieldRow({
  id,
  label,
  hint,
  field,
  draftValue,
  onDraftChange,
}: {
  id: string;
  label: string;
  hint?: string;
  field: AdminField<string>;
  /** `undefined` — tahrirlanmayapti (saqlashda o'tkazib yuboriladi). Bo'sh satr — tozalash. */
  draftValue: string | undefined;
  onDraftChange: (v: string | undefined) => void;
}) {
  const [visible, setVisible] = useState(false);
  const editing = draftValue !== undefined;
  const locked = field.source === "env";

  return (
    <FieldShell id={id} label={label} hint={hint} field={field}>
      {editing ? (
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Input
              id={id}
              type={visible ? "text" : "password"}
              value={draftValue}
              autoFocus
              placeholder="Yangi qiymat (bo'sh qoldirib saqlasangiz — tozalanadi)"
              onChange={(e) => onDraftChange(e.target.value)}
              className="pr-9"
            />
            <button
              type="button"
              onClick={() => setVisible((v) => !v)}
              className="absolute inset-y-0 right-2 flex items-center text-muted-foreground hover:text-foreground"
              aria-label={visible ? "Yashirish" : "Ko'rsatish"}
              tabIndex={-1}
            >
              {visible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => onDraftChange(undefined)}>
            Bekor qilish
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Input id={id} value={field.isSet ? field.value : "sozlanmagan"} disabled readOnly className="text-muted-foreground" />
          {!locked ? (
            <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => onDraftChange("")}>
              O&apos;zgartirish
            </Button>
          ) : null}
        </div>
      )}
    </FieldShell>
  );
}

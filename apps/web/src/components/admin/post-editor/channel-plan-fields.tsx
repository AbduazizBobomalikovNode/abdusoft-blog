"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import type {
  ChannelMode,
  ChannelPlan,
  ChannelPreflightResponse,
  ChannelPreviewResponse,
  ChannelVariant,
  ChannelVersion,
} from "@blog/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AdminApiError, adminApi } from "@/lib/admin-client";
import { cn } from "cn";
import { ChannelChecklistSummary } from "./channel-checklist";
import { MODE_OPTIONS, TelegramPreviewCard, VARIANT_LABELS, VARIANTS_BY_MODE } from "./channel-preview";

const DELAY_PRESETS: { value: number; label: string }[] = [
  { value: 0, label: "Darhol" },
  { value: 5, label: "5 daqiqa" },
  { value: 15, label: "15 daqiqa" },
  { value: 30, label: "30 daqiqa" },
  { value: 60, label: "1 soat" },
  { value: 180, label: "3 soat" },
];
const CUSTOM_VALUE = "custom";
const MAX_DELAY_MINUTES = 10080;

const MONTHS = ["yan", "fev", "mar", "apr", "may", "iyn", "iyl", "avg", "sen", "okt", "noy", "dek"];

function formatShort(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getDate()}-${MONTHS[date.getMonth()]} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "Sayt: 2-okt 09:00 · Kanal: 09:15 · Rasmli, Batafsil" */
export function channelPlanSummary(plan: ChannelPlan, scheduledAtLocal: string, versionName?: string | null): string {
  const site = scheduledAtLocal ? new Date(scheduledAtLocal) : null;
  const valid = site && !Number.isNaN(site.getTime());
  const channelAt = valid ? new Date(site.getTime() + plan.delayMinutes * 60_000) : null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const channelText = channelAt
    ? channelAt.toDateString() === site!.toDateString()
      ? `${pad(channelAt.getHours())}:${pad(channelAt.getMinutes())}`
      : formatShort(channelAt)
    : "—";
  const modeText = plan.mode === "media" ? "Rasmli" : "Rasmsiz";
  const lengthText = plan.versionId
    ? `versiya: ${versionName ?? "maxsus"}`
    : plan.variant
      ? VARIANT_LABELS[plan.variant]
      : "—";
  return `Sayt: ${valid ? formatShort(site) : "—"} · Kanal: ${channelText} · ${modeText}, ${lengthText}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof AdminApiError ? error.message : fallback;
}

export interface ChannelPlanFieldsProps {
  postId: string;
  value: ChannelPlan | null;
  onChange: (plan: ChannelPlan | null) => void;
  scheduledAtLocal: string;
  /** Preflight xatolari bor bo'lsa `true` — chaqiruvchi rejani saqlash/rejalashtirish tugmasini o'chiradi. */
  onBlockingChange?: (blocked: boolean) => void;
}

/**
 * "Nashr -> Rejalashtirish" kartasidagi kanal rejasi: switch, rejim/uzunlik,
 * kechikish va faqat o'qish uchun Telegram ko'rinishi (dialogdagi preview
 * komponenti qayta ishlatiladi).
 */
export function ChannelPlanFields({ postId, value, onChange, scheduledAtLocal, onBlockingChange }: ChannelPlanFieldsProps) {
  const [channelHandle, setChannelHandle] = useState<string | null>(null);
  /** `null` — hali tekshirilmagan. */
  const [telegramReady, setTelegramReady] = useState<boolean | null>(null);
  /** Postda kover/rasm bormi (`null` — noma'lum, 🖼 Rasmli ruxsat etiladi). */
  const [canUseMedia, setCanUseMedia] = useState<boolean | null>(null);
  const [customDelay, setCustomDelay] = useState(() => value !== null && !DELAY_PRESETS.some((p) => p.value === value.delayMinutes));
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<ChannelPreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [versions, setVersions] = useState<ChannelVersion[]>([]);
  const [planPreflight, setPlanPreflight] = useState<ChannelPreflightResponse | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    adminApi
      .getTelegramStatus()
      .then((status) => {
        if (status.configured) {
          setChannelHandle(status.channel);
          setTelegramReady(Boolean(status.channel));
        } else {
          setTelegramReady(false);
        }
      })
      .catch(() => setTelegramReady(false));
  }, []);

  useEffect(() => {
    adminApi
      .listChannelVersions(postId)
      .then((data) => setVersions(data.versions))
      .catch(() => setVersions([]));
  }, [postId]);

  // Reja yoqilgan paytda Telegram cheklovlarini tekshiramiz; xato bo'lsa saqlash bloklanadi.
  const planKey = value ? `${value.mode}|${value.variant ?? ""}|${value.versionId ?? ""}` : "";
  useEffect(() => {
    if (!value) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reja o'chirilganda holatni tozalash
      setPlanPreflight(null);
      onBlockingChange?.(false);
      return;
    }
    let cancelled = false;
    setChecking(true);
    const selection = value.versionId
      ? { versionId: value.versionId }
      : { mode: value.mode, variant: value.variant ?? ("m" as ChannelVariant) };
    adminApi
      .channelPreflight(postId, selection, true)
      .then((result) => {
        if (cancelled) return;
        const view = result;
        setPlanPreflight(view);
        onBlockingChange?.(!view.canSend);
      })
      .catch((error) => {
        if (cancelled) return;
        setPlanPreflight(null);
        // Tekshirib bo'lmasa (masalan versiya o'chirilgan) — xavfsizlik uchun saqlashni blokladi.
        onBlockingChange?.(true);
        toast.error(errorMessage(error, "Telegram cheklovlarini tekshirib bo'lmadi"));
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postId, planKey]);

  useEffect(() => () => onBlockingChange?.(false), [onBlockingChange]);

  function handleChoiceSelect(selected: string) {
    if (!value) return;
    if (selected === "auto") {
      onChange({ mode: value.mode, variant: value.variant ?? "m", delayMinutes: value.delayMinutes });
      return;
    }
    const version = versions.find((v) => v.id === selected);
    if (!version) return;
    onChange({ mode: version.mode, versionId: version.id, delayMinutes: value.delayMinutes });
  }

  async function detectMedia(): Promise<boolean> {
    try {
      await adminApi.channelPreview(postId, "media", "m");
      setCanUseMedia(true);
      return true;
    } catch (error) {
      // Faqat "rasm yo'q" (400) holatida 🖼 o'chiriladi; boshqa xatoda ruxsat saqlanadi.
      if (error instanceof AdminApiError && error.status === 400) {
        setCanUseMedia(false);
        return false;
      }
      return true;
    }
  }

  // Saqlangan reja 🖼 Rasmli bo'lsa ham — rasm yo'qolgan bo'lishi mumkin: tugma holatini aniqlaymiz.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- ataylab: tashqi (API) holatini aniqlash, natija state'ga yoziladi
    if (value?.mode === "media" && canUseMedia === null) void detectMedia();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value?.mode]);

  async function handleToggle(on: boolean) {
    if (!on) {
      onChange(null);
      return;
    }
    const hasMedia = await detectMedia();
    setCustomDelay(false);
    onChange({ mode: hasMedia ? "media" : "text", variant: "m", delayMinutes: 0 });
  }

  function patch(next: Partial<ChannelPlan>) {
    if (!value) return;
    onChange({ ...value, ...next });
  }

  function handleModeChange(mode: ChannelMode) {
    if (!value || value.mode === mode) return;
    if (mode === "media" && canUseMedia === false) return;
    const allowed = VARIANTS_BY_MODE[mode].map((v) => v.value);
    const variant: ChannelVariant = value.variant && allowed.includes(value.variant) ? value.variant : "m";
    patch({ mode, variant });
  }

  function handleDelaySelect(selected: string) {
    if (selected === CUSTOM_VALUE) {
      setCustomDelay(true);
      return;
    }
    setCustomDelay(false);
    patch({ delayMinutes: Number(selected) });
  }

  function handleCustomDelayInput(raw: string) {
    const parsed = Math.floor(Number(raw));
    const clamped = Number.isFinite(parsed) ? Math.min(MAX_DELAY_MINUTES, Math.max(0, parsed)) : 0;
    patch({ delayMinutes: clamped });
  }

  async function openPreview() {
    if (!value) return;
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreview(null);
    try {
      setPreview(
        await adminApi.channelPreview(
          postId,
          value.versionId ? { versionId: value.versionId } : { mode: value.mode, variant: value.variant ?? "m" },
        ),
      );
    } catch (error) {
      toast.error(errorMessage(error, "Oldindan ko'rishni yuklab bo'lmadi"));
    } finally {
      setPreviewLoading(false);
    }
  }

  const switchDisabled = telegramReady !== true && value === null;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex min-h-11 items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Label htmlFor="channel-plan-switch" className="min-h-11 cursor-pointer leading-snug">
            Telegram kanalga ham yuborilsin
          </Label>
          {telegramReady === false && value === null ? (
            <p className="text-xs text-muted-foreground">
              Telegram bot yoki kanal sozlanmagan.{" "}
              <Link
                href="/admin/sozlamalar?tab=telegram"
                className="inline-flex min-h-11 items-center text-primary underline underline-offset-2 md:min-h-0"
              >
                Sozlash
              </Link>
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">Post saytga chiqqach kanalga avtomatik yuboriladi.</p>
          )}
        </div>
        <Switch
          id="channel-plan-switch"
          checked={value !== null}
          disabled={switchDisabled}
          onCheckedChange={(checked) => void handleToggle(checked)}
          className="max-md:after:-inset-x-4 max-md:after:-inset-y-3.5"
        />
      </div>

      {value ? (
        <div className="flex min-w-0 flex-col gap-2.5 rounded-lg border border-border p-2.5">
          {versions.length > 0 || value.versionId ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="channel-plan-choice">Ko&apos;rinish</Label>
              <Select value={value.versionId ?? "auto"} onValueChange={handleChoiceSelect}>
                <SelectTrigger id="channel-plan-choice" className="w-full max-md:data-[size=default]:h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Avtomatik</SelectItem>
                  {versions.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {!value.versionId ? (
          <>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
            {MODE_OPTIONS.map((item) => {
              const disabled = item.value === "media" && canUseMedia === false;
              const button = (
                <button
                  key={item.value}
                  type="button"
                  disabled={disabled}
                  onClick={() => handleModeChange(item.value)}
                  className={cn(
                    "w-full rounded-md px-2 py-1.5 text-xs font-medium transition-colors max-md:min-h-11",
                    disabled
                      ? "cursor-not-allowed text-muted-foreground/50"
                      : value.mode === item.value
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {item.label}
                </button>
              );
              if (!disabled) return button;
              return (
                <Tooltip key={item.value}>
                  <TooltipTrigger asChild>
                    <span>{button}</span>
                  </TooltipTrigger>
                  <TooltipContent>Postda kover yoki band ichida rasm yo&apos;q</TooltipContent>
                </Tooltip>
              );
            })}
          </div>

          <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
            {VARIANTS_BY_MODE[value.mode].map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => patch({ variant: item.value })}
                className={cn(
                  "rounded-md px-2 py-1.5 text-xs font-medium transition-colors max-md:min-h-11",
                  value.variant === item.value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          </>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="channel-plan-delay">Saytga chiqqach</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={customDelay ? CUSTOM_VALUE : String(value.delayMinutes)}
                onValueChange={handleDelaySelect}
              >
                <SelectTrigger id="channel-plan-delay" className="w-fit min-w-36 max-md:data-[size=default]:h-11 max-md:min-w-0 max-md:flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DELAY_PRESETS.map((preset) => (
                    <SelectItem key={preset.value} value={String(preset.value)}>
                      {preset.label}
                    </SelectItem>
                  ))}
                  <SelectItem value={CUSTOM_VALUE}>Boshqa (daqiqa)</SelectItem>
                </SelectContent>
              </Select>
              {customDelay ? (
                <Input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={MAX_DELAY_MINUTES}
                  value={value.delayMinutes}
                  onChange={(event) => handleCustomDelayInput(event.target.value)}
                  aria-label="Kechikish (daqiqa)"
                  className="w-24 max-md:h-11"
                />
              ) : null}
            </div>
          </div>

          <p className="text-xs leading-relaxed break-words text-muted-foreground">
            {channelPlanSummary(value, scheduledAtLocal, versions.find((v) => v.id === value.versionId)?.name)}
          </p>

          {checking && !planPreflight ? <p className="text-xs text-muted-foreground">Telegram cheklovlari tekshirilmoqda…</p> : null}
          {planPreflight ? <ChannelChecklistSummary preflight={planPreflight} /> : null}

          <div>
            <Button type="button" variant="outline" size="sm" className="max-md:h-11 max-md:w-full" onClick={() => void openPreview()}>
              Ko&apos;rinishni ko&apos;rish
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="flex max-h-[90vh] w-full max-w-md flex-col gap-3 overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Kanaldagi ko&apos;rinish</DialogTitle>
          </DialogHeader>
          <TelegramPreviewCard channelName={channelHandle} preview={preview} loading={previewLoading} />
          {preview ? (
            <p className="text-xs text-muted-foreground">
              {preview.visibleLength} / {preview.limit} belgi
              {preview.truncated ? " (qisqartirilgan)" : ""}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

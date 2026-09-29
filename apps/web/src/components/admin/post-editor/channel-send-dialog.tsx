"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { toast } from "sonner";
import type { ChannelMediaItem, ChannelMode, ChannelPreviewResponse, ChannelVariant } from "@blog/shared";
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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTheme } from "@/components/theme-provider";
import { AdminApiError, adminApi } from "@/lib/admin-client";
import { formatDateTime, formatTime } from "@/lib/format";
import { cn } from "cn";

const MODE_OPTIONS: { value: ChannelMode; label: string }[] = [
  { value: "media", label: "🖼 Rasmli" },
  { value: "text", label: "📝 Rasmsiz" },
];

/** Rejimga qarab ruxsat etilgan uzunlik variantlari — tartib UI tugmalari tartibi bilan mos. */
const VARIANTS_BY_MODE: Record<ChannelMode, { value: ChannelVariant; label: string }[]> = {
  media: [
    { value: "m", label: "O'rtacha" },
    { value: "l", label: "Batafsil" },
  ],
  text: [
    { value: "s", label: "Qisqa" },
    { value: "m", label: "O'rtacha" },
    { value: "l", label: "Batafsil" },
    { value: "xl", label: "Maksimal" },
  ],
};

const VARIANT_LABELS: Record<ChannelVariant, string> = {
  s: "Qisqa",
  m: "O'rtacha",
  l: "Batafsil",
  xl: "Maksimal",
};

const MODE_LABELS: Record<ChannelMode, string> = {
  media: "🖼 Rasmli",
  text: "📝 Rasmsiz",
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof AdminApiError ? error.message : fallback;
}

// Telegramning o'zi ishlatadigan rang palitrasiga yaqin — sayt temasiga (dark/light) ergashadi.
const THEME_COLORS = {
  dark: {
    chatBg: "#0e1621",
    bubbleBg: "#182533",
    text: "#e7ecf0",
    muted: "#7d8b99",
    link: "#6ab3f3",
    avatar: "#3f6b8f",
  },
  light: {
    chatBg: "#e6ebee",
    bubbleBg: "#ffffff",
    text: "#0f1419",
    muted: "#707579",
    link: "#3390ec",
    avatar: "#54a3ef",
  },
};

/* eslint-disable @next/next/no-img-element -- admin panel ichidagi oldindan ko'rish, ixtiyoriy domendan (R2 yoki lokal) */
function MediaGrid({ media }: { media: ChannelMediaItem[] }) {
  if (media.length === 0) return null;
  const gap = "gap-0.5";

  if (media.length === 1) {
    return (
      <img
        src={media[0]!.url}
        alt={media[0]!.alt ?? ""}
        className="max-h-80 w-full rounded-md object-cover"
      />
    );
  }

  if (media.length === 2) {
    return (
      <div className={cn("grid grid-cols-2", gap)}>
        {media.map((m, i) => (
          <img key={i} src={m.url} alt={m.alt ?? ""} className="aspect-square w-full rounded-sm object-cover" />
        ))}
      </div>
    );
  }

  if (media.length === 3) {
    return (
      <div className={cn("grid aspect-4/3 grid-cols-2 grid-rows-2", gap)}>
        <img src={media[0]!.url} alt={media[0]!.alt ?? ""} className="row-span-2 h-full w-full rounded-sm object-cover" />
        <img src={media[1]!.url} alt={media[1]!.alt ?? ""} className="h-full w-full rounded-sm object-cover" />
        <img src={media[2]!.url} alt={media[2]!.alt ?? ""} className="h-full w-full rounded-sm object-cover" />
      </div>
    );
  }

  if (media.length === 4) {
    return (
      <div className={cn("grid aspect-square grid-cols-2 grid-rows-2", gap)}>
        {media.map((m, i) => (
          <img key={i} src={m.url} alt={m.alt ?? ""} className="h-full w-full rounded-sm object-cover" />
        ))}
      </div>
    );
  }

  // 5-10 ta — Telegram'dagidek 2-3 talik qatorlar.
  return (
    <div className={cn("grid grid-cols-3", gap)}>
      {media.map((m, i) => (
        <img key={i} src={m.url} alt={m.alt ?? ""} className="aspect-square w-full rounded-sm object-cover" />
      ))}
    </div>
  );
}
/* eslint-enable @next/next/no-img-element */

function TelegramPreviewCard({
  channelName,
  preview,
  loading,
}: {
  channelName: string | null;
  preview: ChannelPreviewResponse | null;
  loading: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const colors = THEME_COLORS[resolvedTheme === "light" ? "light" : "dark"];
  const handle = channelName?.replace(/^@/, "") ?? "kanal";

  return (
    <div
      className="flex flex-col gap-2 rounded-xl p-3 text-sm"
      style={{ backgroundColor: colors.chatBg, color: colors.text }}
    >
      <div className="flex items-center gap-2">
        <div
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
          style={{ backgroundColor: colors.avatar }}
        >
          {handle.slice(0, 2).toUpperCase()}
        </div>
        <div className="flex flex-col leading-tight">
          <span className="font-medium">{handle}</span>
          <span className="text-[11px]" style={{ color: colors.muted }}>
            kanal
          </span>
        </div>
      </div>

      {loading || !preview ? (
        <div className="py-10 text-center text-xs" style={{ color: colors.muted }}>
          Yuklanmoqda…
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 rounded-lg p-1.5" style={{ backgroundColor: colors.bubbleBg }}>
          <MediaGrid media={preview.media} />
          <div
            className={cn(
              "px-1 pb-1 text-[13px] leading-snug whitespace-pre-wrap break-words",
              "[&_a]:underline [&_b]:font-semibold [&_blockquote]:border-l-2 [&_blockquote]:pl-2 [&_code]:rounded [&_code]:bg-black/10 [&_code]:px-1 [&_code]:py-px [&_s]:opacity-70",
              "[&_a]:[color:var(--link-color)] [&_blockquote]:[border-color:var(--link-color)]",
            )}
            style={{ "--link-color": colors.link } as CSSProperties}
            dangerouslySetInnerHTML={{ __html: preview.captionHtml.replace(/\n/g, "<br />") }}
          />
          <div className="flex items-center justify-end gap-1 px-1 text-[11px]" style={{ color: colors.muted }}>
            {formatTime(new Date().toISOString())}
          </div>
        </div>
      )}

      <div
        className="flex items-center justify-between rounded-md px-2 py-1.5 text-xs"
        style={{ backgroundColor: colors.bubbleBg, color: colors.muted }}
      >
        <span>👁 1,2 ming ko&apos;rish</span>
        <span>💬 Izohlar</span>
      </div>
    </div>
  );
}

/**
 * "Kanalga yuborish" dialogi — BOSHQARILADIGAN (controlled) komponent:
 * chaqiruvchi o'zining tugmasini (post editor sarlavhasida yoki
 * `post-row-actions.tsx`dagi menyu bandi) alohida render qiladi va
 * `onClick`da `open`ni `true` qiladi — xuddi shu fayldagi boshqa
 * `AlertDialog`lar (`post-editor-header.tsx`) qanday ishlatilgani kabi.
 * Bu `DropdownMenuItem` ichida `DialogTrigger asChild` ishlatishdan kelib
 * chiqadigan fokus/portal to'qnashuvlarining oldini oladi.
 */
export function ChannelSendDialog({
  postId,
  open,
  onOpenChange,
}: {
  postId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [mode, setMode] = useState<ChannelMode>("media");
  const [variant, setVariant] = useState<ChannelVariant>("m");
  /** `null` — hali aniqlanmagan (dialog ochilganda tekshiriladi). Postda kover/rasm bo'lmasa `false` — 🖼 Rasmli o'chirilgan. */
  const [canUseMedia, setCanUseMedia] = useState<boolean | null>(null);
  const [preview, setPreview] = useState<ChannelPreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [channelHandle, setChannelHandle] = useState<string | null>(null);
  const [confirmReplaceOpen, setConfirmReplaceOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    adminApi
      .getTelegramStatus()
      .then((status) => {
        if (status.configured) setChannelHandle(status.channel);
      })
      .catch(() => {
        // Telegram holatini olishda xatolik bo'lsa ham dialog ko'rinishda ishlaydi.
      });
  }, [open]);

  async function loadPreview(m: ChannelMode, v: ChannelVariant) {
    setLoading(true);
    try {
      const result = await adminApi.channelPreview(postId, m, v);
      setPreview(result);
    } catch (error) {
      toast.error(errorMessage(error, "Oldindan ko'rishni yuklab bo'lmadi"));
    } finally {
      setLoading(false);
    }
  }

  /**
   * Dialog ochilganda — postda kover/rasm bor-yo'qligini aniqlaymiz (🖼 preview
   * so'rovi orqali): bo'lsa 🖼 Rasmli + O'rtacha standart, bo'lmasa 📝 Rasmsiz +
   * O'rtacha (spec: default rejim shu tarzda tanlanadi).
   */
  async function detectDefaultsAndLoad() {
    setLoading(true);
    try {
      const mediaPreview = await adminApi.channelPreview(postId, "media", "m");
      setCanUseMedia(true);
      setMode("media");
      setVariant("m");
      setPreview(mediaPreview);
    } catch {
      setCanUseMedia(false);
      setMode("text");
      setVariant("m");
      try {
        const textPreview = await adminApi.channelPreview(postId, "text", "m");
        setPreview(textPreview);
      } catch (error) {
        toast.error(errorMessage(error, "Oldindan ko'rishni yuklab bo'lmadi"));
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- ataylab: dialog ochilganda ko'rinish darrov "Yuklanmoqda…" holatini ko'rsatishi kerak
    if (open) void detectDefaultsAndLoad();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function handleModeChange(nextMode: ChannelMode) {
    if (nextMode === mode) return;
    if (nextMode === "media" && !canUseMedia) return; // tugma disabled — tooltip orqali sababi tushuntiriladi
    const allowedVariants = VARIANTS_BY_MODE[nextMode].map((v) => v.value);
    const nextVariant: ChannelVariant = allowedVariants.includes(variant) ? variant : "m";
    setMode(nextMode);
    setVariant(nextVariant);
    void loadPreview(nextMode, nextVariant);
  }

  function handleVariantChange(next: ChannelVariant) {
    setVariant(next);
    void loadPreview(mode, next);
  }

  async function handleSend(replaceExisting: boolean) {
    setSending(true);
    try {
      await adminApi.channelSend(postId, mode, variant, replaceExisting);
      toast.success(replaceExisting ? "Qayta yuborildi" : "Kanalga yuborildi");
      setConfirmReplaceOpen(false);
      await loadPreview(mode, variant);
    } catch (error) {
      toast.error(errorMessage(error, "Yuborib bo'lmadi"));
    } finally {
      setSending(false);
    }
  }

  async function handleResync() {
    setResyncing(true);
    try {
      await adminApi.channelResyncCaption(postId);
      toast.success("Caption yangilandi");
    } catch (error) {
      toast.error(errorMessage(error, "Yangilab bo'lmadi"));
    } finally {
      setResyncing(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton
          className="flex max-h-[90vh] w-full max-w-2xl flex-col gap-4 overflow-y-auto sm:max-w-2xl max-sm:fixed max-sm:inset-0 max-sm:h-full max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none"
        >
          <DialogHeader>
            <DialogTitle>Kanalga yuborish</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="flex flex-col gap-3 sm:w-56 sm:shrink-0">
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
                        "rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                        disabled
                          ? "cursor-not-allowed text-muted-foreground/50"
                          : mode === item.value
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

              <div
                className={cn(
                  "grid gap-1 rounded-lg bg-muted p-1",
                  VARIANTS_BY_MODE[mode].length === 2 ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4",
                )}
              >
                {VARIANTS_BY_MODE[mode].map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => handleVariantChange(item.value)}
                    className={cn(
                      "rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                      variant === item.value
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              {preview ? (
                <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                  <span>
                    {preview.visibleLength} / {preview.limit} belgi
                    {preview.truncated ? " (qisqartirilgan)" : ""}
                  </span>
                  {mode === "media" ? (
                    <span>
                      {preview.media.length} ta rasm
                      {preview.media.length > 0
                        ? ` (kover${preview.media.length > 1 ? ` + ${preview.media.length - 1} ta kontentdan` : ""})`
                        : ""}
                    </span>
                  ) : (
                    <span>Oddiy matn xabari — rasmsiz, havola oldindan ko&apos;rinishi o&apos;chirilgan</span>
                  )}
                </div>
              ) : null}

              {preview?.alreadySent ? (
                <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted/40 p-3 text-xs">
                  <p>
                    Allaqachon yuborilgan —{" "}
                    <span className="font-medium">
                      {MODE_LABELS[preview.alreadySent.mode]} · {VARIANT_LABELS[preview.alreadySent.variant]}
                    </span>
                    , {formatDateTime(preview.alreadySent.at)}
                  </p>
                  {preview.alreadySent.messageUrl ? (
                    <a
                      href={preview.alreadySent.messageUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline underline-offset-2"
                    >
                      Kanalda ochish
                    </a>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="min-w-0 flex-1 overflow-hidden rounded-xl">
              <TelegramPreviewCard channelName={channelHandle} preview={preview} loading={loading} />
            </div>
          </div>

          <DialogFooter className="flex-row items-center justify-between gap-2">
            {preview?.alreadySent ? (
              <Button type="button" variant="outline" size="sm" disabled={resyncing} onClick={() => void handleResync()}>
                {resyncing ? "Yangilanmoqda…" : "Caption'ni yangilash"}
              </Button>
            ) : (
              <span />
            )}
            {preview?.alreadySent ? (
              <Button
                type="button"
                variant="destructive"
                disabled={sending || loading}
                onClick={() => setConfirmReplaceOpen(true)}
              >
                Qayta yuborish
              </Button>
            ) : (
              <Button type="button" disabled={sending || loading || !preview} onClick={() => void handleSend(false)}>
                {sending ? "Yuborilmoqda…" : "Kanalga yuborish"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmReplaceOpen} onOpenChange={setConfirmReplaceOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Qayta yuborilsinmi?</AlertDialogTitle>
            <AlertDialogDescription>
              Eski kanal posti va uning butun izoh ipi (muhokama guruhidagi barcha izohlar bog&apos;lanishi) o&apos;chirib
              tashlanadi va o&apos;rniga yangisi yuboriladi. Bu amalni ortga qaytarib bo&apos;lmaydi.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction
              disabled={sending}
              onClick={() => void handleSend(true)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Ha, qayta yuborish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

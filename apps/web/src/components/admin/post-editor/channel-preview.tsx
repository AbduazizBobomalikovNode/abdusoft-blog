"use client";

import type { CSSProperties } from "react";
import type { ChannelMediaItem, ChannelMode, ChannelPreviewResponse, ChannelVariant } from "@blog/shared";
import { useTheme } from "@/components/theme-provider";
import { formatTime } from "@/lib/format";
import { cn } from "cn";

/**
 * Kanal xabari uchun umumiy UI qismlari — "Kanalga yuborish" dialogi
 * (`channel-send-dialog.tsx`) va "Rejalashtirish" kartasidagi (faqat o'qish
 * uchun) ko'rinish (`post-editor-settings.tsx`) shu yerdan foydalanadi.
 */

export const MODE_OPTIONS: { value: ChannelMode; label: string }[] = [
  { value: "media", label: "🖼 Rasmli" },
  { value: "text", label: "📝 Rasmsiz" },
];

/** Rejimga qarab ruxsat etilgan uzunlik variantlari — tartib UI tugmalari tartibi bilan mos. */
export const VARIANTS_BY_MODE: Record<ChannelMode, { value: ChannelVariant; label: string }[]> = {
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

export const VARIANT_LABELS: Record<ChannelVariant, string> = {
  s: "Qisqa",
  m: "O'rtacha",
  l: "Batafsil",
  xl: "Maksimal",
};

export const MODE_LABELS: Record<ChannelMode, string> = {
  media: "🖼 Rasmli",
  text: "📝 Rasmsiz",
};

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

/** Kanal nomi: `getChat` sarlavhasi -> username -> sozlangan id (faqat raqamli bo'lmasa) -> "Kanal". */
export function resolveChannelTitle(preview: ChannelPreviewResponse | null, configured: string | null): string {
  const fromServer = preview?.channel?.title?.trim();
  if (fromServer) return fromServer;
  const username = preview?.channel?.username?.trim();
  if (username) return `@${username.replace(/^@/, "")}`;
  const handle = configured?.trim();
  if (handle && !/^-?\d+$/.test(handle)) return handle.startsWith("@") ? handle : `@${handle}`;
  return "Kanal";
}

/** Ko'pi bilan 2 so'zning bosh harflari ("-100…" kabi raqamlar hech qachon avatar bo'lmaydi). */
export function channelInitials(title: string): string {
  const words = title
    .replace(/^@/, "")
    .split(/[\s_.-]+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  const letters = words
    .slice(0, 2)
    .map((w) => Array.from(w.replace(/[^\p{L}\p{N}]/gu, ""))[0] ?? "")
    .join("");
  return (letters || "K").toUpperCase();
}

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

export function TelegramPreviewCard({
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
  const title = resolveChannelTitle(preview, channelName);
  const initials = channelInitials(title);

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
          {initials}
        </div>
        <div className="flex flex-col leading-tight">
          <span className="font-medium">{title}</span>
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


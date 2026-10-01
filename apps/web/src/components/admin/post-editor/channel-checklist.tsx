"use client";

import type { ChannelCheck, ChannelCheckGroup, ChannelCheckStatus, ChannelPreflightResponse } from "@blog/shared";
import { cn } from "cn";

/**
 * "Telegram cheklovlari" ro'yxati — preflight natijasi (Matn / Rasmlar / Albom / Sozlamalar).
 * Kanalga yuborish dialogi (3-qadam) va rejalashtirish xulosasi shu yerdan foydalanadi.
 */

const GROUP_LABELS: Record<ChannelCheckGroup, string> = {
  text: "Matn",
  media: "Rasmlar",
  album: "Albom",
  config: "Sozlamalar",
};
const GROUP_ORDER: ChannelCheckGroup[] = ["text", "media", "album", "config"];

const ICONS: Record<ChannelCheckStatus, string> = { ok: "✓", warn: "⚠", error: "✗" };
const ICON_CLASS: Record<ChannelCheckStatus, string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-destructive",
};

function worst(statuses: ChannelCheckStatus[]): ChannelCheckStatus {
  if (statuses.includes("error")) return "error";
  if (statuses.includes("warn")) return "warn";
  return "ok";
}

interface Row {
  key: string;
  status: ChannelCheckStatus;
  title: string;
  detail: string | null;
  notes: { status: ChannelCheckStatus; text: string }[];
}

function buildRows(preflight: ChannelPreflightResponse, group: ChannelCheckGroup): Row[] {
  const checks = preflight.checks.filter((c) => c.group === group);
  if (group !== "media") {
    return checks.map((c) => ({
      key: c.id,
      status: c.status,
      title: c.title,
      detail: c.message,
      notes: [],
    }));
  }
  // Rasmlar: har bir rasm uchun bitta qator ("cover.webp → JPEG 1.2 MB · 2560×1440 ✓"), muammolar ostida.
  const byUrl = new Map<string, ChannelCheck[]>();
  for (const c of checks) {
    const key = c.imageUrl ?? c.id;
    byUrl.set(key, [...(byUrl.get(key) ?? []), c]);
  }
  return [...byUrl.entries()].map(([url, list]) => {
    const report = preflight.media.find((m) => m.url === url);
    const name = report?.name ?? list[0]?.title ?? url;
    const status = worst(list.map((c) => c.status));
    const summary = report?.sent
      ? `${name} → JPEG ${list.find((c) => c.id.startsWith("media.download"))?.message.replace(/^JPEG /, "") ?? ""}`
      : name;
    return {
      key: url,
      status,
      title: summary,
      detail: null,
      notes: list.filter((c) => c.status !== "ok").map((c) => ({ status: c.status, text: c.message })),
    };
  });
}

export function ChannelChecklist({ preflight, className }: { preflight: ChannelPreflightResponse; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {GROUP_ORDER.map((group) => {
        const rows = buildRows(preflight, group);
        if (rows.length === 0) return null;
        return (
          <div key={group} className="flex flex-col gap-1">
            <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{GROUP_LABELS[group]}</h4>
            <ul className="flex flex-col gap-1">
              {rows.map((row) => (
                <li key={row.key} className="flex gap-2 text-sm">
                  <span className={cn("w-4 shrink-0 text-center font-semibold", ICON_CLASS[row.status])} aria-hidden>
                    {ICONS[row.status]}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="break-words">
                      <span className="font-medium">{row.title}</span>
                      {row.detail ? <span className="text-muted-foreground"> — {row.detail}</span> : null}
                    </p>
                    {row.notes.map((note, i) => (
                      <p key={i} className={cn("text-xs break-words", ICON_CLASS[note.status])}>
                        {ICONS[note.status]} {note.text}
                      </p>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** Rasmga tegishli xabar oldiga fayl nomini qo'yadi — xulosada qaysi rasm ekani ko'rinishi uchun. */
function withImageName(preflight: ChannelPreflightResponse, check: ChannelCheck): string {
  if (!check.imageUrl) return check.message;
  const name = preflight.media.find((m) => m.url === check.imageUrl)?.name;
  return name ? `${name}: ${check.message}` : check.message;
}

/** Ixcham xulosa: xatolar/ogohlantirishlar soni va xato xabarlari (rejalashtirish uchun). */
export function ChannelChecklistSummary({ preflight }: { preflight: ChannelPreflightResponse }) {
  const errors = preflight.checks.filter((c) => c.status === "error");
  const warns = preflight.checks.filter((c) => c.status === "warn");
  if (errors.length === 0 && warns.length === 0) {
    return <p className="text-xs text-emerald-600 dark:text-emerald-400">✓ Telegram cheklovlari: hammasi joyida</p>;
  }
  return (
    <div className="flex flex-col gap-1 text-xs">
      <p className="font-medium">
        Telegram cheklovlari:{" "}
        {errors.length > 0 ? <span className="text-destructive">{errors.length} ta xato</span> : null}
        {errors.length > 0 && warns.length > 0 ? ", " : null}
        {warns.length > 0 ? <span className="text-amber-600 dark:text-amber-400">{warns.length} ta ogohlantirish</span> : null}
      </p>
      <ul className="flex flex-col gap-0.5">
        {errors.map((c) => (
          <li key={c.id} className="text-destructive break-words">
            ✗ {withImageName(preflight, c)}
          </li>
        ))}
        {warns.map((c) => (
          <li key={c.id} className="text-amber-600 break-words dark:text-amber-400">
            ⚠ {withImageName(preflight, c)}
          </li>
        ))}
      </ul>
    </div>
  );
}

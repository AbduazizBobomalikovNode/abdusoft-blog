"use client";

import { useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "cn";
import { buildSegments, collapseCut, initialsOf, overflowIndex, type CollapseRule, type SegmentKind } from "./text";
import type { SocialPreviewModel } from "./types";

export const SEE_MORE = "…ko'proq";
export const SEE_LESS = "kamroq";

export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <div className={cn("flex shrink-0 items-center justify-center rounded-full bg-slate-500 text-xs font-semibold text-white", className ?? "size-10")} aria-hidden>
      {initialsOf(name)}
    </div>
  );
}

/** Kartaning tashqi qobig'i: neytral yorliq + admin mavzusiga (dark/light) mos fon. */
export function PreviewFrame({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label} ko&apos;rinishi</span>
      <div className="overflow-hidden rounded-xl border border-border bg-white p-3 text-sm text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">{children}</div>
    </div>
  );
}

export function ActionRow({ items, className }: { items: { icon: LucideIcon; label: string }[]; className?: string }) {
  return (
    <div className={cn("flex items-center gap-4 text-neutral-500 dark:text-neutral-400", className)} aria-hidden>
      {items.map(({ icon: Icon, label }, i) => (
        <span key={`${i}-${label}`} className="flex items-center gap-1 text-xs">
          <Icon className="size-4" strokeWidth={1.75} />
          {label ? <span>{label}</span> : null}
        </span>
      ))}
    </div>
  );
}

const KIND_CLASS: Record<Exclude<SegmentKind, "text">, string> = {
  url: "text-sky-600 dark:text-sky-400",
  hashtag: "text-sky-600 dark:text-sky-400",
  mention: "font-medium text-sky-600 dark:text-sky-400",
};

/**
 * Matn: qator uzilishlari saqlanadi, URL/#hashtag/@mention bo'yalgan, ixtiyoriy "ko'proq" va chegaradan oshgan qism belgilangan.
 */
export function RichText({ model, collapse, linkUrls = true, className }: { model: SocialPreviewModel; collapse?: CollapseRule; linkUrls?: boolean; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const overAt = overflowIndex(model.provider, model.text, model.limit);
  const cut = collapse ? collapseCut(model.text, collapse) : null;
  // Chegaradan oshgan bo'lsa, kesiladigan joy ko'rinib turishi uchun matn doim to'liq ochiladi.
  const collapsed = cut !== null && !expanded && overAt === null;
  const segments = buildSegments(model.text, { urls: linkUrls, visibleEnd: collapsed ? cut : null, overAt });

  return (
    <div className={cn("break-words whitespace-pre-wrap", className)} data-testid="social-text">
      {model.text.length === 0 ? <span className="text-neutral-400">Matn bo&apos;sh…</span> : null}
      {segments.map((s, i) => {
        const cls = s.kind === "text" ? undefined : KIND_CLASS[s.kind];
        const node = s.over ? (
          <mark key={i} data-over="" className="rounded-sm bg-red-500/25 text-inherit underline decoration-red-500 decoration-wavy">
            <span className={cls}>{s.value}</span>
          </mark>
        ) : (
          <span key={i} className={cls}>{s.value}</span>
        );
        return node;
      })}
      {collapsed ? (
        <>
          {" "}
          <button type="button" data-testid="social-see-more" className="text-neutral-500 hover:underline dark:text-neutral-400" onClick={() => setExpanded(true)}>{SEE_MORE}</button>
        </>
      ) : null}
      {cut !== null && expanded && overAt === null ? (
        <>
          {" "}
          <button type="button" data-testid="social-see-less" className="text-neutral-500 hover:underline dark:text-neutral-400" onClick={() => setExpanded(false)}>{SEE_LESS}</button>
        </>
      ) : null}
    </div>
  );
}

/* eslint-disable @next/next/no-img-element -- admin panel ichidagi oldindan ko'rish, tashqi (R2/OG) rasm */
export function PreviewImage({ url, className }: { url: string; className?: string }) {
  return <img src={url} alt="" className={cn("w-full object-cover", className)} onError={(e) => { e.currentTarget.style.display = "none"; }} />;
}
/* eslint-enable @next/next/no-img-element */

/** Sarlavha + domen kartasi (LinkedIn article, X/Threads havola kartasi). */
export function LinkCard({ imageUrl, title, domain, className, imageClassName }: { imageUrl: string | null; title: string; domain: string; className?: string; imageClassName?: string }) {
  return (
    <div className={cn("overflow-hidden border border-neutral-200 dark:border-neutral-700", className)} data-testid="social-link-card">
      {imageUrl ? <PreviewImage url={imageUrl} className={cn("aspect-[1.91/1]", imageClassName)} /> : null}
      <div className="bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
        <p className="line-clamp-2 text-[13px] font-semibold">{title || "Sarlavha"}</p>
        {domain ? <p className="text-xs text-neutral-500 dark:text-neutral-400">{domain}</p> : null}
      </div>
    </div>
  );
}

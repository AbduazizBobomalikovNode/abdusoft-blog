"use client";

import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { ChannelPlan, ChannelPreviewResponse, ResolvedChannelChoice } from "@blog/shared";
import { Button } from "@/components/ui/button";
import { adminApi } from "@/lib/admin-client";
import { previewSelectionOf, telegramTabSummary } from "@/lib/distribution-telegram";
import { TelegramPreviewCard } from "./channel-preview";

export interface DistributionTelegramInfo {
  choice: ResolvedChannelChoice | null;
  plan: ChannelPlan | null;
  sent: boolean;
  sentUrl: string | null;
  channelHandle: string | null;
}

/** "Tarqatish" dialogidagi Telegram yorlig'i: xulosa + belgilangan versiya ko'rinishi + Telegram oynasini ochish. Yuborish shu yerda emas. */
export function DistributionTelegramPanel({ postId, info, onOpenTelegram }: { postId: string; info: DistributionTelegramInfo; onOpenTelegram: () => void }) {
  const selection = previewSelectionOf(info.choice);
  const selectionKey = selection ? JSON.stringify(selection) : "";
  // Natija so'ralgan tanlov kaliti bilan saqlanadi: tanlov o'zgarsa eski ko'rinish ko'rsatilmaydi (effect ichida setState yo'q).
  const [result, setResult] = useState<{ key: string; data: ChannelPreviewResponse | null } | null>(null);

  useEffect(() => {
    if (!selectionKey) return;
    let alive = true;
    adminApi
      .channelPreview(postId, JSON.parse(selectionKey))
      .then((data) => alive && setResult({ key: selectionKey, data }))
      .catch(() => alive && setResult({ key: selectionKey, data: null }));
    return () => {
      alive = false;
    };
  }, [postId, selectionKey]);

  const done = result?.key === selectionKey;
  const preview = done ? result.data : null;
  const loading = Boolean(selectionKey) && !done;

  const s = telegramTabSummary({ choice: info.choice, plan: info.plan, sent: info.sent });
  return (
    <div className="flex flex-col gap-3" data-testid="dist-telegram-panel">
      <dl className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2.5 text-xs">
        <div><dt className="inline text-muted-foreground">Versiya: </dt><dd className="inline font-medium">{s.choice}</dd></div>
        <div><dt className="inline text-muted-foreground">Reja: </dt><dd className="inline">{s.plan}</dd></div>
        <div>
          <dt className="inline text-muted-foreground">Holat: </dt>
          <dd className="inline">{s.sent}</dd>
          {info.sentUrl ? <a href={info.sentUrl} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-1 underline">Postni ochish <ExternalLink className="size-3" /></a> : null}
        </div>
      </dl>
      {selection ? <TelegramPreviewCard channelName={info.channelHandle} preview={preview} loading={loading} /> : null}
      <div>
        <Button type="button" className="max-md:h-11 max-md:w-full" onClick={onOpenTelegram} data-testid="dist-open-telegram">Telegram oynasini ochish</Button>
      </div>
    </div>
  );
}

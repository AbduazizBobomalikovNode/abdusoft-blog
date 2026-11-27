"use client";

import { useEffect, useState } from "react";
import { Share2 } from "lucide-react";
import type { DistributionPostResponse } from "@blog/shared";
import { Button } from "@/components/ui/button";
import { adminApi } from "@/lib/admin-client";
import { channelShortName } from "@/lib/distribution-ui";
import { planSummaryLines } from "@/lib/distribution-plan";
import { formatDateTime } from "@/lib/format";
import { cn } from "cn";

const DOT: Record<string, string> = { waiting: "bg-violet-500", scheduled: "bg-sky-500", active: "bg-sky-500", sent: "bg-emerald-500", failed: "bg-destructive" };

/**
 * "Nashr" kartasidagi o'qish rejimidagi xulosa: har bir ijtimoiy kanalning "saytga chiqqach N daqiqa" rejasi
 * ("LinkedIn · chiqqach 15 daq · kutmoqda") + «Tarqatish» dialogini ochish tugmasi. Tahrir dialogda.
 * `refreshKey` o'zgarganda (dialog yopilganda) qayta yuklanadi. Reja bo'lmasa va post chop etilgan bo'lsa — hech narsa ko'rsatilmaydi.
 */
export function DistributionPlansSummary({ postId, onOpen, refreshKey, published }: { postId: string; onOpen: () => void; refreshKey: number; published: boolean }) {
  const [data, setData] = useState<DistributionPostResponse | null>(null);

  useEffect(() => {
    let alive = true;
    adminApi
      .distributionForPost(postId)
      .then((r) => alive && setData(r))
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
  }, [postId, refreshKey]);

  const lines = data ? planSummaryLines(data.distributions, (p) => channelShortName(data.channels, p)) : [];
  if (lines.length === 0 && published) return null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5" data-testid="distribution-plans-summary">
      <p className="text-xs font-medium">Ijtimoiy tarmoqlar rejasi</p>
      {lines.length === 0 ? (
        <p className="text-xs text-muted-foreground">Reja yo&apos;q — post chop etilgach tarmoqlarga hech narsa yuborilmaydi.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {lines.map((l) => (
            <li key={l.provider} className="flex flex-col text-xs" data-testid={`plan-line-${l.provider}`}>
              <span className="flex items-center gap-1.5">
                <span className={cn("size-1.5 shrink-0 rounded-full", DOT[l.state] ?? "bg-muted-foreground")} aria-hidden />
                <span className="font-medium">{l.label}</span>
                <span className="text-muted-foreground">· {l.phrase} · {l.stateLabel}</span>
              </span>
              {l.scheduledAt ? <span className="pl-3 text-muted-foreground">{formatDateTime(l.scheduledAt)}</span> : null}
              {l.error ? <span className="pl-3 break-words text-destructive">{l.error}</span> : null}
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button type="button" variant="outline" size="sm" className="max-md:h-11 max-md:w-full" onClick={onOpen}>
          <Share2 className="size-4" />
          Tarqatishni ochish
        </Button>
      </div>
    </div>
  );
}

import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { computeDelta, formatCompactNumber } from "@/lib/stats-format";

function DeltaChip({ current, previous }: { current: number; previous: number | null }) {
  if (previous === null) return null;
  const delta = computeDelta(current, previous);

  if (delta.isNew) {
    return (
      <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[0.65rem] font-medium text-emerald-600 dark:text-emerald-400">
        <TrendingUp className="size-3" />
        yangi
      </span>
    );
  }

  const Icon = delta.direction === "up" ? TrendingUp : delta.direction === "down" ? TrendingDown : Minus;
  const colorClass =
    delta.direction === "up"
      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      : delta.direction === "down"
        ? "bg-destructive/10 text-destructive"
        : "bg-muted text-muted-foreground";

  return (
    <span className={cn("inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[0.65rem] font-medium", colorClass)}>
      <Icon className="size-3" />
      {delta.percent === 0 ? "0%" : `${delta.percent! > 0 ? "+" : ""}${delta.percent}%`}
    </span>
  );
}

export function StatTile({
  label,
  value,
  previous,
}: {
  label: string;
  value: number | string;
  previous?: number | null;
}) {
  const numericValue = typeof value === "number" ? formatCompactNumber(value) : value;
  const showDelta = typeof value === "number" && previous !== undefined;

  return (
    <Card size="sm">
      <CardHeader className="pb-0">
        <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-2">
        <span className="text-2xl font-semibold tracking-tight tabular-nums">{numericValue}</span>
        {showDelta ? <DeltaChip current={value as number} previous={previous ?? null} /> : null}
      </CardContent>
    </Card>
  );
}

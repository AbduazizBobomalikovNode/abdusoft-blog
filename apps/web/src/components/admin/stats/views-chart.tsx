"use client";

import { useEffect, useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { LineChart as LineChartIcon } from "lucide-react";
import type { StatsSeriesPoint } from "@blog/shared";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { formatDayShortUTC } from "@/lib/format";

const chartConfig = {
  views: {
    label: "Ko'rishlar",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const listener = (e: MediaQueryListEvent) => setReduced(e.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);

  return reduced;
}

interface ViewsTooltipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ value?: number }>;
  label?: string | number;
}

/** "25 sen · 2 ko'rish" ko'rinishidagi bitta qatorli tooltip. */
function ViewsTooltip({ active, payload, label }: ViewsTooltipProps) {
  if (!active || !payload?.length) return null;
  const value = payload[0]?.value ?? 0;
  return (
    <div className="rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-md">
      <span className="text-muted-foreground">{formatDayShortUTC(String(label))}</span>
      <span className="mx-1 text-muted-foreground">·</span>
      <span className="font-medium text-foreground">{value} ko&apos;rish</span>
    </div>
  );
}

export function ViewsChart({ series }: { series: StatsSeriesPoint[] }) {
  const reducedMotion = useReducedMotion();
  const hasViews = series.some((point) => point.views > 0);

  if (!hasViews) {
    return (
      <div className="flex h-64 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-sm text-muted-foreground">
        <LineChartIcon className="size-5" aria-hidden="true" />
        <span>Hali ko&apos;rishlar yo&apos;q</span>
      </div>
    );
  }

  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-64 w-full">
      <AreaChart data={series} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
        <defs>
          <linearGradient id="viewsFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-views)" stopOpacity={0.35} />
            <stop offset="95%" stopColor="var(--color-views)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="day"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={formatDayShortUTC}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={28}
          tickMargin={4}
          allowDecimals={false}
          tickCount={4}
          tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
          tickFormatter={(value: number) => `${Math.round(value)}`}
        />
        <ChartTooltip cursor={false} content={<ViewsTooltip />} />
        <Area
          dataKey="views"
          type="monotone"
          fill="url(#viewsFill)"
          stroke="var(--color-views)"
          strokeWidth={2}
          dot={series.length <= 14 ? { r: 3, fill: "var(--color-views)", strokeWidth: 0 } : false}
          activeDot={{ r: 4 }}
          isAnimationActive={!reducedMotion}
        />
      </AreaChart>
    </ChartContainer>
  );
}

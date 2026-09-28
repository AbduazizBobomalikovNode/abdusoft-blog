import Link from "next/link";
import type { StatsRange } from "@blog/shared";
import { cn } from "@/lib/utils";

const RANGES: { value: StatsRange; label: string }[] = [
  { value: "7d", label: "7 kun" },
  { value: "30d", label: "30 kun" },
  { value: "90d", label: "90 kun" },
  { value: "all", label: "Hammasi" },
];

export const DEFAULT_STATS_RANGE: StatsRange = "7d";

export function isStatsRange(value: string | undefined): value is StatsRange {
  return !!value && RANGES.some((r) => r.value === value);
}

/** `basePath` — masalan `/admin` yoki `/admin/statistika/<id>`; joriy `range` URL query'da saqlanadi. */
export function StatsRangeTabs({ basePath, active }: { basePath: string; active: StatsRange }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {RANGES.map((r) => {
        const href = r.value === DEFAULT_STATS_RANGE ? basePath : `${basePath}?range=${r.value}`;
        const isActive = active === r.value;

        return (
          <Link
            key={r.value}
            href={href}
            className={cn(
              "rounded-full border px-3 py-1 text-sm font-medium",
              isActive
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
            )}
          >
            {r.label}
          </Link>
        );
      })}
    </div>
  );
}

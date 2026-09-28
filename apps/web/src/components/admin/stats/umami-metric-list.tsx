import type { UmamiMetricRow } from "@blog/shared";
import { formatCompactNumber } from "@/lib/stats-format";

export function UmamiMetricList({ title, rows }: { title: string; rows: UmamiMetricRow[] }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {rows.length === 0 ? (
        <p className="py-2 text-center text-xs text-muted-foreground">Ma&apos;lumot yo&apos;q</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((row) => (
            <li key={row.label} className="flex items-center justify-between gap-2 text-sm">
              <span className="line-clamp-1 text-foreground">{row.label}</span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                {formatCompactNumber(row.count)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

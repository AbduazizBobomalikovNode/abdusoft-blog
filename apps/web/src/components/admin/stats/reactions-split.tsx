import { formatCompactNumber } from "@/lib/stats-format";

/** Like/dislike nisbatini bitta gorizontal panelda ko'rsatadi (butun umr davomida). */
export function ReactionsSplit({ likes, dislikes }: { likes: number; dislikes: number }) {
  const total = likes + dislikes;
  const likePercent = total > 0 ? Math.round((likes / total) * 100) : 0;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <h3 className="text-xs font-medium text-muted-foreground">Reaksiyalar taqsimoti</h3>
      {total > 0 ? (
        <>
          <div className="flex h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-[var(--chart-1)]" style={{ width: `${likePercent}%` }} />
            <div className="h-full bg-[var(--chart-3)]" style={{ width: `${100 - likePercent}%` }} />
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              👍 {formatCompactNumber(likes)} <span className="text-xs">({likePercent}%)</span>
            </span>
            <span className="text-muted-foreground">
              👎 {formatCompactNumber(dislikes)} <span className="text-xs">({100 - likePercent}%)</span>
            </span>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Hali reaksiya yo&apos;q</p>
      )}
    </div>
  );
}

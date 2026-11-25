import Link from "next/link";
import { Trash2 } from "lucide-react";
import type { AdminPostStatus, AdminPostTotals } from "@blog/shared";
import { cn } from "@/lib/utils";

const TABS: { value: "all" | AdminPostStatus; label: string }[] = [
  { value: "all", label: "Hammasi" },
  { value: "draft", label: "Qoralama" },
  { value: "in_review", label: "Ko'rib chiqish" },
  { value: "changes_requested", label: "Tuzatish so'raldi" },
  { value: "scheduled", label: "Rejalashtirilgan" },
  { value: "published", label: "Chop etilgan" },
  { value: "archived", label: "Arxiv" },
];

export function PostStatusTabs({
  active,
  totals,
  q,
  trashCount,
}: {
  active: "all" | AdminPostStatus | "trash";
  totals: AdminPostTotals;
  q?: string;
  /** Berilsa (faqat admin) — oxirida "Savat" bo'limi ko'rsatiladi. */
  trashCount?: number;
}) {
  return (
    <div className="flex flex-wrap gap-1.5 border-b border-border pb-3">
      {TABS.map((tab) => {
        const search = new URLSearchParams();
        if (tab.value !== "all") search.set("status", tab.value);
        if (q) search.set("q", q);
        const qs = search.toString();
        const href = qs ? `/admin/postlar?${qs}` : "/admin/postlar";
        const isActive = active === tab.value;

        return (
          <Link
            key={tab.value}
            href={href}
            className={cn(
              "flex items-center rounded-full border px-3 py-1 text-sm font-medium max-md:min-h-11",
              isActive
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
            )}
          >
            {tab.label} <span className="opacity-60">{totals[tab.value]}</span>
          </Link>
        );
      })}
      {trashCount !== undefined ? (
        <Link
          href="/admin/postlar?status=trash"
          data-testid="tab-trash"
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium max-md:min-h-11",
            active === "trash"
              ? "border-foreground bg-foreground text-background"
              : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
          )}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
          Savat <span className="opacity-60">{trashCount}</span>
        </Link>
      ) : null}
    </div>
  );
}

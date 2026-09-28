import Link from "next/link";
import type { AdminPostStatus, AdminPostTotals } from "@blog/shared";
import { cn } from "@/lib/utils";

const TABS: { value: "all" | AdminPostStatus; label: string }[] = [
  { value: "all", label: "Hammasi" },
  { value: "draft", label: "Qoralama" },
  { value: "scheduled", label: "Rejalashtirilgan" },
  { value: "published", label: "Chop etilgan" },
  { value: "archived", label: "Arxiv" },
];

export function PostStatusTabs({
  active,
  totals,
  q,
}: {
  active: "all" | AdminPostStatus;
  totals: AdminPostTotals;
  q?: string;
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
    </div>
  );
}

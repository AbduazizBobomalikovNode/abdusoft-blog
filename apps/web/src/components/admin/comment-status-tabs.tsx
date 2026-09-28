import Link from "next/link";
import type { AdminCommentCounts } from "@blog/shared";
import { cn } from "@/lib/utils";

type StatusFilter = "all" | "pending" | "visible" | "hidden" | "deleted";

const TABS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "Hammasi" },
  { value: "pending", label: "Kutilmoqda" },
  { value: "visible", label: "Ko'rinadigan" },
  { value: "hidden", label: "Yashirilgan" },
  { value: "deleted", label: "O'chirilgan" },
];

export function CommentStatusTabs({
  active,
  counts,
  postId,
  q,
  source,
  from,
  to,
}: {
  active: StatusFilter;
  counts: AdminCommentCounts;
  postId?: string;
  q?: string;
  source?: string;
  from?: string;
  to?: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5 border-b border-border pb-3">
      {TABS.map((tab) => {
        const search = new URLSearchParams();
        if (tab.value !== "all") search.set("status", tab.value);
        if (postId) search.set("postId", postId);
        if (q) search.set("q", q);
        if (source && source !== "all") search.set("source", source);
        if (from) search.set("from", from);
        if (to) search.set("to", to);
        const qs = search.toString();
        const href = qs ? `/admin/fikrlar?${qs}` : "/admin/fikrlar";
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
            {tab.label} <span className="opacity-60">{counts[tab.value]}</span>
          </Link>
        );
      })}
    </div>
  );
}

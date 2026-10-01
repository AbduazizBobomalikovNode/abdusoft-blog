import type { AdminPostStatus } from "@blog/shared";
import { Badge } from "@/components/ui/badge";

const STATUS_LABEL: Record<AdminPostStatus, string> = {
  draft: "Qoralama",
  in_review: "Ko'rib chiqilmoqda",
  changes_requested: "Tuzatish so'raldi",
  scheduled: "Rejalashtirilgan",
  published: "Chop etilgan",
  archived: "Arxivlangan",
};

const STATUS_VARIANT: Record<AdminPostStatus, "default" | "secondary" | "outline"> = {
  draft: "outline",
  in_review: "secondary",
  changes_requested: "outline",
  scheduled: "secondary",
  published: "default",
  archived: "outline",
};

export function PostStatusBadge({ status }: { status: AdminPostStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{STATUS_LABEL[status]}</Badge>;
}

/** Rejalashtirilgan postda kanal rejasi bo'lsa — kichik "→ kanal" belgisi. */
export function PostChannelPlanHint({ status, hasChannelPlan }: { status: AdminPostStatus; hasChannelPlan?: boolean }) {
  if (status !== "scheduled" || !hasChannelPlan) return null;
  return (
    <span className="text-xs text-muted-foreground whitespace-nowrap" title="Chop etilgach Telegram kanalga yuboriladi">
      → kanal
    </span>
  );
}

/** Postda belgilangan kanal versiyasi bo'lsa — kichik ★ belgisi. */
export function PostChannelChoiceHint({ hasChannelChoice }: { hasChannelChoice?: boolean }) {
  if (!hasChannelChoice) return null;
  return (
    <span
      className="text-xs whitespace-nowrap text-amber-600 dark:text-amber-400"
      title="Kanal versiyasi belgilangan"
      aria-label="Kanal versiyasi belgilangan"
      data-testid="post-choice-star"
    >
      ★
    </span>
  );
}

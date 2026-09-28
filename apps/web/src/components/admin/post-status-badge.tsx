import type { AdminPostStatus } from "@blog/shared";
import { Badge } from "@/components/ui/badge";

const STATUS_LABEL: Record<AdminPostStatus, string> = {
  draft: "Qoralama",
  scheduled: "Rejalashtirilgan",
  published: "Chop etilgan",
  archived: "Arxivlangan",
};

const STATUS_VARIANT: Record<AdminPostStatus, "default" | "secondary" | "outline"> = {
  draft: "outline",
  scheduled: "secondary",
  published: "default",
  archived: "outline",
};

export function PostStatusBadge({ status }: { status: AdminPostStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{STATUS_LABEL[status]}</Badge>;
}

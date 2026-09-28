import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Admin ro'yxat sahifalari uchun umumiy "bo'sh holat" ko'rinishi —
 * ikonka + bitta quruq o'zbekcha satr + (ixtiyoriy) asosiy amal.
 */
export function EmptyState({
  icon: Icon,
  message,
  action,
  className,
}: {
  icon: LucideIcon;
  message: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-4 py-10 text-center",
        className,
      )}
    >
      <Icon className="size-8 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">{message}</p>
      {action}
    </div>
  );
}

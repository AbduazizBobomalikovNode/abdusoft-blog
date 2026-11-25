import { Bot, Clock, Cog, HelpCircle, Monitor, Send } from "lucide-react";
import { viaKind, viaLabel } from "@/lib/admin-labels";
import { cn } from "@/lib/utils";

const ICONS = { web: Monitor, telegram: Send, mcp: Bot, scheduler: Clock, system: Cog } as const;

/**
 * O'zgarish manbasi belgisi. Veb panel — jim (oddiy muted); Telegram — odam, lekin bot orqali; assistent/rejalashtiruvchi/tizim
 * (odam emas) — alohida rangda, shunda jadvalda darrov ko'rinadi.
 */
export function ViaBadge({ via, className }: { via: string | null | undefined; className?: string }) {
  const kind = viaKind(via);
  const Icon = (via && via in ICONS ? ICONS[via as keyof typeof ICONS] : HelpCircle) as typeof Monitor;
  return (
    <span
      data-via={via ?? "unknown"}
      data-via-kind={kind}
      className={cn(
        "inline-flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        kind === "automated" && "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300",
        kind === "telegram" && "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
        kind === "web" && "border-border text-muted-foreground",
        kind === "unknown" && "border-dashed border-border text-muted-foreground",
        className,
      )}
    >
      <Icon className="size-3" aria-hidden="true" />
      {viaLabel(via)}
    </span>
  );
}

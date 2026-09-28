import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { AdjacentPost } from "@blog/shared";

export function PrevNextNav({ prev, next }: { prev: AdjacentPost; next: AdjacentPost }) {
  if (!prev && !next) return null;

  return (
    <nav aria-label="Oldingi va keyingi post" className="grid grid-cols-2 gap-3 border-t border-border pt-6">
      <div>
        {prev ? (
          <Link
            href={`/${prev.slug}`}
            className="flex flex-col gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <span className="flex items-center gap-1 font-mono text-xs">
              <ArrowLeft className="size-3.5" /> Oldingi
            </span>
            <span className="font-medium text-foreground">{prev.title}</span>
          </Link>
        ) : null}
      </div>
      <div className="text-right">
        {next ? (
          <Link
            href={`/${next.slug}`}
            className="flex flex-col items-end gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <span className="flex items-center gap-1 font-mono text-xs">
              Keyingi <ArrowRight className="size-3.5" />
            </span>
            <span className="font-medium text-foreground">{next.title}</span>
          </Link>
        ) : null}
      </div>
    </nav>
  );
}

import Link from "next/link";
import { cn } from "@/lib/utils";
import type { TagWithCount } from "@blog/shared";

/** Bosh sahifadagi teg bo'yicha filtr chiplari — link-based (?tag=), server component. */
export function TagFilterRow({
  tags,
  activeSlug,
}: {
  tags: TagWithCount[];
  activeSlug?: string;
}) {
  if (tags.length === 0) return null;

  return (
    <nav aria-label="Teglar bo'yicha filtr" className="flex flex-wrap gap-1.5">
      <Link
        href="/"
        className={cn(
          "rounded-full border px-2.5 py-1 font-mono text-xs",
          !activeSlug
            ? "border-foreground bg-foreground text-background"
            : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
        )}
      >
        Hammasi
      </Link>
      {tags.map((tag) => (
        <Link
          key={tag.id}
          href={`/?tag=${tag.slug}`}
          className={cn(
            "rounded-full border px-2.5 py-1 font-mono text-xs",
            activeSlug === tag.slug
              ? "border-foreground bg-foreground text-background"
              : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
          )}
        >
          {tag.name} <span className="opacity-60">{tag.postsCount}</span>
        </Link>
      ))}
    </nav>
  );
}

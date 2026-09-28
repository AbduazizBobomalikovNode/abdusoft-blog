import Link from "next/link";
import type { Tag } from "@blog/shared";

/** Post ichida ko'rsatiladigan teg chiplari — har biri teg xab sahifasiga link. */
export function PostTags({ tags }: { tags: Tag[] }) {
  if (tags.length === 0) return null;

  return (
    <>
      {tags.map((tag) => (
        <Link
          key={tag.id}
          href={`/teglar/${tag.slug}`}
          className="rounded-full border border-border px-2 py-0.5 font-mono text-[0.7rem] text-muted-foreground hover:border-foreground/30 hover:text-foreground"
        >
          {tag.name}
        </Link>
      ))}
    </>
  );
}

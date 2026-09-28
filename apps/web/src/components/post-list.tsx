import Link from "next/link";
import type { PostListItem } from "@blog/shared";
import { PostTags } from "@/components/post-tags";
import { formatDate, formatReadingTime } from "@/lib/format";

/**
 * Xronologik oddiy ro'yxat — telegra.ph darajasidagi ixchamlik: kartasiz,
 * rasmsiz. Bosh sahifa, qidiruv natijalari va teg xablari shu komponentdan
 * foydalanadi.
 */
export function PostList({ posts }: { posts: PostListItem[] }) {
  return (
    <ul className="flex flex-col divide-y divide-border">
      {posts.map((post) => (
        <li key={post.slug} className="flex flex-col gap-1.5 py-4 first:pt-0">
          <Link
            href={`/${post.slug}`}
            className="text-lg leading-snug font-medium tracking-tight hover:underline"
          >
            {post.pinned ? (
              <span className="mr-2 inline-block rounded-full bg-primary px-2 py-0.5 align-middle font-mono text-[0.65rem] font-normal tracking-wide text-primary-foreground uppercase">
                Muhim
              </span>
            ) : null}
            {post.title}
          </Link>
          <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
            <time dateTime={post.publishedAt ?? undefined}>{formatDate(post.publishedAt)}</time>
            {post.readingTime ? <span>&middot; {formatReadingTime(post.readingTime)}</span> : null}
            <PostTags tags={post.tags} />
          </div>
          {post.excerpt ? (
            <p className="text-sm text-muted-foreground">{post.excerpt}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

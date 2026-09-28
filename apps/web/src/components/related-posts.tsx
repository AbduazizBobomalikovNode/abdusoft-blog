import Link from "next/link";
import type { PostListItem } from "@blog/shared";
import { formatDate } from "@/lib/format";

/** O'xshash postlar — oddiy ro'yxat, kartasiz. */
export function RelatedPosts({ posts }: { posts: PostListItem[] }) {
  if (posts.length === 0) return null;

  return (
    <div className="border-t border-border pt-6">
      <p className="mb-3 font-mono text-xs font-medium tracking-wide text-muted-foreground uppercase">
        O&apos;xshash postlar
      </p>
      <ul className="flex flex-col gap-3">
        {posts.map((post) => (
          <li key={post.slug}>
            <Link href={`/${post.slug}`} className="font-medium hover:underline">
              {post.title}
            </Link>
            <div className="font-mono text-xs text-muted-foreground">
              {formatDate(post.publishedAt)}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

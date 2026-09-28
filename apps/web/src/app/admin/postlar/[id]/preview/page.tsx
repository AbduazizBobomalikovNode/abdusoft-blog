import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ArticleBody } from "@/components/article-body";
import { PostStatusBadge } from "@/components/admin/post-status-badge";
import { PostTags } from "@/components/post-tags";
import { PrevNextNav } from "@/components/prev-next-nav";
import { RelatedPosts } from "@/components/related-posts";
import { TableOfContents } from "@/components/table-of-contents";
import { getAdminPostPreview } from "@/lib/api";
import { formatDate, formatReadingTime } from "@/lib/format";

const TOC_MIN_READING_TIME = 8;

export default async function PostPreviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const headersList = await headers();
  const post = await getAdminPostPreview(id, headersList.get("cookie"));

  if (!post) {
    notFound();
  }

  const showToc = post.settings.showToc && (post.readingTime ?? 0) >= TOC_MIN_READING_TIME;

  return (
    <div className="mx-auto flex w-full max-w-[680px] flex-col gap-6">
      <div className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/40 px-3 py-2 text-sm">
        <PostStatusBadge status={post.status} />
        <span className="text-muted-foreground">Bu oldindan ko&apos;rish — hozircha shu ko&apos;rinishda saqlangan.</span>
      </div>

      <article className="flex flex-col gap-6">
        <header className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-balance">{post.title}</h1>
          <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
            {post.pinned ? (
              <span className="rounded-full bg-primary px-2 py-0.5 font-mono text-[0.65rem] tracking-wide text-primary-foreground uppercase">
                Muhim
              </span>
            ) : null}
            <time dateTime={post.publishedAt ?? undefined}>{formatDate(post.publishedAt)}</time>
            {post.readingTime ? <span>&middot; {formatReadingTime(post.readingTime)}</span> : null}
            <PostTags tags={post.tags} />
          </div>
        </header>

        {post.coverUrl ? (
          <figure>
            {/* eslint-disable-next-line @next/next/no-img-element -- CMS kontenti */}
            <img src={post.coverUrl} alt={post.title} className="w-full rounded-lg" />
          </figure>
        ) : null}

        {showToc ? <TableOfContents toc={post.toc} /> : null}

        <ArticleBody html={post.html} />

        <PrevNextNav prev={post.adjacent.prev} next={post.adjacent.next} />

        <RelatedPosts posts={post.related} />
      </article>
    </div>
  );
}

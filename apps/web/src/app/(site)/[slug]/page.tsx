import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArticleBody } from "@/components/article-body";
import { PostComments } from "@/components/post-comments";
import { PostMetaStats } from "@/components/post-meta-stats";
import { PostReactions } from "@/components/post-reactions";
import { PostTags } from "@/components/post-tags";
import { PrevNextNav } from "@/components/prev-next-nav";
import { ReadingProgress } from "@/components/reading-progress";
import { RelatedPosts } from "@/components/related-posts";
import { ShareRow } from "@/components/share-row";
import { TableOfContents } from "@/components/table-of-contents";
import { ViewBeacon } from "@/components/view-beacon";
import { getPost } from "@/lib/api";
import { formatDate, formatReadingTime } from "@/lib/format";
import { site } from "@/lib/site";

export const revalidate = 300;
export const dynamicParams = true;

/** Sticky/collapsible TOC faqat uzun postlarda ko'rsatiladi (~1500+ so'z ≈ 8+ daqiqa). */
const TOC_MIN_READING_TIME = 8;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) return {};

  const canonical = `${site.url}/${post.slug}`;
  const description = post.excerpt ?? `${post.title} — ${site.name}`;

  return {
    title: post.title,
    description,
    alternates: { canonical },
    openGraph: {
      type: "article",
      title: post.title,
      description,
      url: canonical,
      publishedTime: post.publishedAt ?? undefined,
      tags: post.tags.map((tag) => tag.name),
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description,
    },
  };
}

export default async function PostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = await getPost(slug);

  if (!post) {
    notFound();
  }

  const showToc = post.settings.showToc && (post.readingTime ?? 0) >= TOC_MIN_READING_TIME;

  return (
    <>
      <ReadingProgress />
      <ViewBeacon slug={post.slug} />
      <article className="flex flex-col gap-6">
        <header className="flex flex-col gap-3">
          <h1 id="post-title" className="text-2xl font-semibold tracking-tight text-balance">{post.title}</h1>
          <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
            {post.pinned ? (
              <span className="rounded-full bg-primary px-2 py-0.5 font-mono text-[0.65rem] tracking-wide text-primary-foreground uppercase">
                Muhim
              </span>
            ) : null}
            <time dateTime={post.publishedAt ?? undefined}>{formatDate(post.publishedAt)}</time>
            {post.readingTime ? <span>&middot; {formatReadingTime(post.readingTime)}</span> : null}
            <PostMetaStats
              slug={post.slug}
              initialViews={post.counts.views}
              initialComments={post.counts.comments}
              showViews={post.settings.showViews}
              showComments={post.settings.commentsEnabled}
            />
            <PostTags tags={post.tags} />
          </div>
          <address className="not-italic">
            <span className="font-mono text-xs text-muted-foreground">
              Muallif: <span rel="author">{site.name}</span>
            </span>
          </address>
        </header>

        {post.coverUrl ? (
          <figure>
            {/* eslint-disable-next-line @next/next/no-img-element -- CMS kontenti, domeni oldindan noma'lum */}
            <img src={post.coverUrl} alt={post.title} className="w-full rounded-lg" />
          </figure>
        ) : null}

        {showToc ? <TableOfContents toc={post.toc} /> : null}

        <ArticleBody html={post.html} />

        <ShareRow url={`${site.url}/${post.slug}`} title={post.title} telegraphUrl={post.telegraphUrl} />

        <PrevNextNav prev={post.adjacent.prev} next={post.adjacent.next} />

        <RelatedPosts posts={post.related} />

        <PostReactions post={post} />
        <PostComments post={post} />
      </article>
    </>
  );
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PaginationNav } from "@/components/pagination-nav";
import { PostList } from "@/components/post-list";
import { getPosts, getTags } from "@/lib/api";

export const revalidate = 60;
export const dynamicParams = true;

async function findTag(slug: string) {
  const tags = await getTags();
  return tags.find((tag) => tag.slug === slug) ?? null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const tag = await findTag(slug);
  if (!tag) return {};

  return {
    title: tag.name,
    description: tag.description ?? `${tag.name} mavzusidagi postlar.`,
  };
}

export default async function TagHubPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { slug } = await params;
  const { page: pageParam } = await searchParams;
  const page = Number(pageParam) > 0 ? Number(pageParam) : 1;

  const tag = await findTag(slug);
  if (!tag) notFound();

  const data = await getPosts({ tag: slug, page });
  const posts = data?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{tag.name}</h1>
        {tag.description ? (
          <p className="mt-1 text-sm text-muted-foreground">{tag.description}</p>
        ) : null}
        <p className="mt-1 font-mono text-xs text-muted-foreground">{tag.postsCount} ta post</p>
      </div>

      {posts.length === 0 ? (
        <p className="text-sm text-muted-foreground">Bu mavzuda hali post yo&apos;q.</p>
      ) : (
        <>
          <PostList posts={posts} />
          <PaginationNav
            basePath={`/teglar/${slug}`}
            baseQuery={{}}
            page={page}
            hasMore={data?.hasMore ?? false}
          />
        </>
      )}
    </div>
  );
}

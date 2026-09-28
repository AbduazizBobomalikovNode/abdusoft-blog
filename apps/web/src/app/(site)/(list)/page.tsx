import { PaginationNav } from "@/components/pagination-nav";
import { PostList } from "@/components/post-list";
import { SearchForm } from "@/components/search-form";
import { TagFilterRow } from "@/components/tag-filter-row";
import { getPosts, getTags } from "@/lib/api";

export const revalidate = 60;

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ tag?: string; page?: string }>;
}) {
  const { tag, page: pageParam } = await searchParams;
  const page = Number(pageParam) > 0 ? Number(pageParam) : 1;

  const [data, tags] = await Promise.all([getPosts({ tag, page }), getTags()]);
  const posts = data?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Postlar</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          IT, sun&apos;iy intellekt va dasturlash haqida yozuvlar.
        </p>
      </div>

      <SearchForm />
      <TagFilterRow tags={tags} activeSlug={tag} />

      {posts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {tag
            ? `"${tag}" mavzusida hali sarguzasht boshlanmagan.`
            : "Bu yerda hali sukunat hukmron — birinchi post tez orada chiqadi."}
        </p>
      ) : (
        <>
          <PostList posts={posts} />
          <PaginationNav
            basePath="/"
            baseQuery={{ tag }}
            page={page}
            hasMore={data?.hasMore ?? false}
          />
        </>
      )}
    </div>
  );
}

import type { Metadata } from "next";
import { PaginationNav } from "@/components/pagination-nav";
import { PostList } from "@/components/post-list";
import { SearchForm } from "@/components/search-form";
import { getPosts } from "@/lib/api";

export const revalidate = 60;

export const metadata: Metadata = {
  title: "Qidiruv",
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const { q, page: pageParam } = await searchParams;
  const page = Number(pageParam) > 0 ? Number(pageParam) : 1;
  const query = q?.trim() ?? "";

  const data = query ? await getPosts({ q: query, page }) : null;
  const posts = data?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Qidiruv</h1>
      </div>

      <SearchForm defaultValue={query} />

      {!query ? (
        <p className="text-sm text-muted-foreground">Qidirish uchun biror so&apos;z yozing.</p>
      ) : posts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          &ldquo;{query}&rdquo; bo&apos;yicha hech narsa topilmadi. Boshqacha so&apos;z bilan
          urinib ko&apos;ring.
        </p>
      ) : (
        <>
          <p className="font-mono text-xs text-muted-foreground">
            &ldquo;{query}&rdquo; bo&apos;yicha {data?.total ?? posts.length} ta natija
          </p>
          <PostList posts={posts} />
          <PaginationNav
            basePath="/qidiruv"
            baseQuery={{ q: query }}
            page={page}
            hasMore={data?.hasMore ?? false}
          />
        </>
      )}
    </div>
  );
}

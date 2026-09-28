import { headers } from "next/headers";
import type { Metadata } from "next";
import { CommentFilters } from "@/components/admin/comment-filters";
import { CommentStatusTabs } from "@/components/admin/comment-status-tabs";
import { CommentsTable } from "@/components/admin/comments-table";
import { PaginationNav } from "@/components/pagination-nav";
import { getAdminComments, getAdminPosts } from "@/lib/api";

export const metadata: Metadata = { title: "Fikrlar" };

const STATUS_VALUES = ["all", "pending", "visible", "hidden", "deleted"] as const;
type StatusFilter = (typeof STATUS_VALUES)[number];

function isStatusFilter(value: string | undefined): value is StatusFilter {
  return !!value && (STATUS_VALUES as readonly string[]).includes(value);
}

export default async function AdminCommentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; postId?: string; q?: string; page?: string }>;
}) {
  const { status: statusParam, postId, q, page: pageParam } = await searchParams;
  const status = isStatusFilter(statusParam) ? statusParam : "all";
  const page = Number(pageParam) > 0 ? Number(pageParam) : 1;

  const headersList = await headers();
  const cookie = headersList.get("cookie");

  const [data, postsData] = await Promise.all([
    getAdminComments({ status, postId, q, page, limit: 20 }, cookie),
    getAdminPosts({ status: "all", limit: 100 }, cookie),
  ]);

  const items = data?.items ?? [];
  const counts = data?.counts ?? { all: 0, pending: 0, visible: 0, hidden: 0, deleted: 0 };
  const posts = (postsData?.items ?? []).map((post) => ({ id: post.id, title: post.title }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Fikrlar</h1>
        <CommentFilters posts={posts} status={status} postId={postId} q={q} />
      </div>

      <CommentStatusTabs active={status} counts={counts} postId={postId} q={q} />

      <CommentsTable initialItems={items} />

      {data ? (
        <PaginationNav
          basePath="/admin/fikrlar"
          baseQuery={{ status: status !== "all" ? status : undefined, postId, q }}
          page={page}
          hasMore={data.hasMore}
        />
      ) : null}
    </div>
  );
}

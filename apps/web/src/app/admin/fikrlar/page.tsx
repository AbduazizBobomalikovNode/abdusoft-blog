import { headers } from "next/headers";
import type { Metadata } from "next";
import { CommentFilters } from "@/components/admin/comment-filters";
import { CommentStatusTabs } from "@/components/admin/comment-status-tabs";
import { CommentsTable } from "@/components/admin/comments-table";
import { PaginationNav } from "@/components/pagination-nav";
import { requireAdminPage } from "@/lib/admin-guard";
import { getAdminComments, getAdminPosts } from "@/lib/api";

export const metadata: Metadata = { title: "Fikrlar" };

const STATUS_VALUES = ["all", "pending", "visible", "hidden", "deleted"] as const;
type StatusFilter = (typeof STATUS_VALUES)[number];

function isStatusFilter(value: string | undefined): value is StatusFilter {
  return !!value && (STATUS_VALUES as readonly string[]).includes(value);
}

const SOURCE_VALUES = ["all", "web", "telegram"] as const;
type SourceFilter = (typeof SOURCE_VALUES)[number];

function isSourceFilter(value: string | undefined): value is SourceFilter {
  return !!value && (SOURCE_VALUES as readonly string[]).includes(value);
}

export default async function AdminCommentsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    source?: string;
    postId?: string;
    q?: string;
    from?: string;
    to?: string;
    page?: string;
  }>;
}) {
  const { status: statusParam, source: sourceParam, postId, q, from, to, page: pageParam } = await searchParams;
  const status = isStatusFilter(statusParam) ? statusParam : "all";
  const source = isSourceFilter(sourceParam) ? sourceParam : "all";
  const page = Number(pageParam) > 0 ? Number(pageParam) : 1;

  const headersList = await headers();
  const cookie = headersList.get("cookie");
  await requireAdminPage(cookie);

  const [data, postsData] = await Promise.all([
    getAdminComments({ status, source, postId, q, from, to, page, limit: 20 }, cookie),
    getAdminPosts({ status: "all", limit: 100 }, cookie),
  ]);

  const items = data?.items ?? [];
  const counts = data?.counts ?? { all: 0, pending: 0, visible: 0, hidden: 0, deleted: 0 };
  const sourceCounts = data?.sourceCounts ?? { all: 0, web: 0, telegram: 0 };
  const posts = (postsData?.items ?? []).map((post) => ({ id: post.id, title: post.title }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Fikrlar</h1>
        <CommentFilters posts={posts} status={status} source={source} postId={postId} q={q} from={from} to={to} sourceCounts={sourceCounts} />
      </div>

      <CommentStatusTabs active={status} counts={counts} source={source} postId={postId} q={q} from={from} to={to} />

      <CommentsTable initialItems={items} />

      {data ? (
        <PaginationNav
          basePath="/admin/fikrlar"
          baseQuery={{ status: status !== "all" ? status : undefined, source: source !== "all" ? source : undefined, postId, q, from, to }}
          page={page}
          hasMore={data.hasMore}
        />
      ) : null}
    </div>
  );
}

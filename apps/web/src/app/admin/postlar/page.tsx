import Link from "next/link";
import { headers } from "next/headers";
import type { Metadata } from "next";
import { FileText, MessageCircle, ThumbsDown, ThumbsUp, Eye as EyeIcon } from "lucide-react";
import { EmptyState } from "@/components/admin/empty-state";
import { NewPostButton } from "@/components/admin/new-post-button";
import { PostRowActions } from "@/components/admin/post-row-actions";
import { PostStatusBadge } from "@/components/admin/post-status-badge";
import { PostStatusTabs } from "@/components/admin/post-status-tabs";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getAdminPosts } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Postlar" };

const STATUS_VALUES = ["all", "draft", "scheduled", "published", "archived"] as const;
type StatusFilter = (typeof STATUS_VALUES)[number];

function isStatusFilter(value: string | undefined): value is StatusFilter {
  return !!value && (STATUS_VALUES as readonly string[]).includes(value);
}

export default async function AdminPostsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; page?: string }>;
}) {
  const { status: statusParam, q, page: pageParam } = await searchParams;
  const status = isStatusFilter(statusParam) ? statusParam : "all";
  const page = Number(pageParam) > 0 ? Number(pageParam) : 1;

  const headersList = await headers();
  const data = await getAdminPosts({ status, q, page, limit: 20 }, headersList.get("cookie"));
  const posts = data?.items ?? [];
  const totals = data?.totals ?? { all: 0, draft: 0, scheduled: 0, published: 0, archived: 0 };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Postlar</h1>
          <p className="mt-1 text-sm text-muted-foreground">Barcha postlaringizni boshqaring.</p>
        </div>
        <div className="flex items-center gap-2">
          <form action="/admin/postlar" method="get" className="flex items-center gap-2">
            {status !== "all" ? <input type="hidden" name="status" value={status} /> : null}
            <Input
              type="search"
              name="q"
              placeholder="Qidirish…"
              defaultValue={q}
              aria-label="Postlarni qidirish"
              className="w-48"
            />
          </form>
          <NewPostButton />
        </div>
      </div>

      <PostStatusTabs active={status} totals={totals} q={q} />

      {posts.length === 0 ? (
        <EmptyState
          icon={FileText}
          message="Bu bo'limda hali postlar yo'q."
          action={q || status !== "all" ? undefined : <NewPostButton />}
        />
      ) : (
        <>
          {/* Mobil kartalar — jadval torgina ekranda tor va o'qib bo'lmaydigan bo'lgani uchun */}
          <div className="flex flex-col gap-2 md:hidden">
            {posts.map((post) => (
              <div key={post.id} className="flex flex-col gap-2 rounded-lg border border-border p-3">
                <div className="flex items-start justify-between gap-2">
                  <Link href={`/admin/postlar/${post.id}`} className="line-clamp-2 min-w-0 flex-1 text-sm font-medium">
                    {post.pinned ? "📌 " : ""}
                    {post.title}
                  </Link>
                  <PostRowActions post={post} />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <PostStatusBadge status={post.status} />
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {formatDateTime(post.publishedAt ?? post.scheduledAt ?? post.updatedAt)}
                  </span>
                </div>
                <div className="flex items-center gap-2.5 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <EyeIcon className="size-3.5" /> {post.counts.views}
                  </span>
                  <span className="flex items-center gap-1">
                    <ThumbsUp className="size-3.5" /> {post.counts.likes}
                  </span>
                  <span className="flex items-center gap-1">
                    <ThumbsDown className="size-3.5" /> {post.counts.dislikes}
                  </span>
                  <span className="flex items-center gap-1">
                    <MessageCircle className="size-3.5" /> {post.counts.comments}
                  </span>
                </div>
                {post.tags.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {post.tags.map((tag) => (
                      <span
                        key={tag.id}
                        className="rounded-full border border-border px-1.5 py-0.5 text-[0.65rem] text-muted-foreground"
                      >
                        {tag.name}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          {/* Desktop jadval */}
          <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sarlavha</TableHead>
                <TableHead>Holat</TableHead>
                <TableHead>Sana</TableHead>
                <TableHead>Ko&apos;rsatkichlar</TableHead>
                <TableHead>Teglar</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {posts.map((post) => (
                <TableRow key={post.id} className="group">
                  <TableCell className="max-w-64">
                    <Link
                      href={`/admin/postlar/${post.id}`}
                      title={post.title}
                      className="block truncate font-medium hover:underline"
                    >
                      {post.pinned ? "📌 " : ""}
                      {post.title}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <PostStatusBadge status={post.status} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {formatDateTime(post.publishedAt ?? post.scheduledAt ?? post.updatedAt)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2.5 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <EyeIcon className="size-3.5" /> {post.counts.views}
                      </span>
                      <span className="flex items-center gap-1">
                        <ThumbsUp className="size-3.5" /> {post.counts.likes}
                      </span>
                      <span className="flex items-center gap-1">
                        <ThumbsDown className="size-3.5" /> {post.counts.dislikes}
                      </span>
                      <span className="flex items-center gap-1">
                        <MessageCircle className="size-3.5" /> {post.counts.comments}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex max-w-40 flex-wrap gap-1">
                      {post.tags.map((tag) => (
                        <span
                          key={tag.id}
                          className="rounded-full border border-border px-1.5 py-0.5 text-[0.65rem] text-muted-foreground"
                        >
                          {tag.name}
                        </span>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <PostRowActions post={post} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>
        </>
      )}

      {data && data.hasMore ? (
        <div className="flex justify-center">
          <Link
            href={(() => {
              const search = new URLSearchParams();
              if (status !== "all") search.set("status", status);
              if (q) search.set("q", q);
              search.set("page", String(page + 1));
              return `/admin/postlar?${search.toString()}`;
            })()}
            className="rounded-full border border-border px-4 py-1.5 text-sm text-muted-foreground hover:border-foreground/30 hover:text-foreground"
          >
            Yana yuklash
          </Link>
        </div>
      ) : null}
    </div>
  );
}

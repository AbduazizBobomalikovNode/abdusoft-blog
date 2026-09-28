import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { RecentCommentsList } from "@/components/admin/stats/recent-comments-list";
import { ReactionsSplit } from "@/components/admin/stats/reactions-split";
import { StatTile } from "@/components/admin/stats/stat-tile";
import { StatsRangeTabs, DEFAULT_STATS_RANGE, isStatsRange } from "@/components/admin/stats/stats-range-tabs";
import { ViewsChart } from "@/components/admin/stats/views-chart";
import { PostStatusBadge } from "@/components/admin/post-status-badge";
import { requireAdminPage } from "@/lib/admin-guard";
import { getAdminPostStats } from "@/lib/api";
import { formatCompactNumber } from "@/lib/stats-format";

export default async function PostStatsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { id } = await params;
  const { range: rangeParam } = await searchParams;
  const range = isStatsRange(rangeParam) ? rangeParam : DEFAULT_STATS_RANGE;

  const headersList = await headers();
  const cookie = headersList.get("cookie");
  await requireAdminPage(cookie);

  const data = await getAdminPostStats(id, range, cookie);
  if (!data) notFound();

  const basePath = `/admin/statistika/${id}`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Link
          href="/admin/postlar"
          className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Postlar
        </Link>
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-xl font-semibold tracking-tight text-balance">{data.post.title}</h1>
          <PostStatusBadge status={data.post.status} />
        </div>
        <p className="text-xs text-muted-foreground">
          Umumiy (hamma vaqt): {formatCompactNumber(data.allTime.views)} ko&apos;rish &middot;{" "}
          {formatCompactNumber(data.allTime.likes)} like &middot; {formatCompactNumber(data.allTime.dislikes)} dislike
          &middot; {formatCompactNumber(data.allTime.comments)} fikr
        </p>
      </div>

      <StatsRangeTabs basePath={basePath} active={range} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Ko'rishlar" value={data.totals.views} previous={data.previousTotals?.views ?? null} />
        <StatTile label="Like" value={data.totals.likes} previous={data.previousTotals?.likes ?? null} />
        <StatTile label="Dislike" value={data.totals.dislikes} previous={data.previousTotals?.dislikes ?? null} />
        <StatTile label="Fikrlar" value={data.totals.comments} previous={data.previousTotals?.comments ?? null} />
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">Ko&apos;rishlar</h2>
        <ViewsChart series={data.series} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <ReactionsSplit likes={data.reactionsSplit.likes} dislikes={data.reactionsSplit.dislikes} />

        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">Fikrlar</h2>
          <RecentCommentsList comments={data.recentComments} showPostTitle={false} />
        </div>
      </div>
    </div>
  );
}

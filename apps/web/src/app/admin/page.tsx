import Link from "next/link";
import { headers } from "next/headers";
import type { UmamiMetricRow } from "@blog/shared";
import { RecentCommentsList } from "@/components/admin/stats/recent-comments-list";
import { StaffDashboard } from "@/components/admin/staff-dashboard";
import { StatTile } from "@/components/admin/stats/stat-tile";
import { StatsRangeTabs, DEFAULT_STATS_RANGE, isStatsRange } from "@/components/admin/stats/stats-range-tabs";
import { TopPostsTable } from "@/components/admin/stats/top-posts-table";
import { UmamiMetricList } from "@/components/admin/stats/umami-metric-list";
import { ViewsChart } from "@/components/admin/stats/views-chart";
import { NewPostButton } from "@/components/admin/new-post-button";
import { getAdminStatsOverview, getAdminUmamiStats, getMe, getStaffPostsSummary } from "@/lib/api";
import { formatAvgDuration } from "@/lib/stats-format";

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { range: rangeParam } = await searchParams;
  const range = isStatsRange(rangeParam) ? rangeParam : DEFAULT_STATS_RANGE;

  const headersList = await headers();
  const cookie = headersList.get("cookie");

  // Xodim (staff) uchun statistika/Umami marshrutlari 403 qaytaradi — shu
  // sabab alohida, soddalashtirilgan dashboard ko'rsatiladi.
  const me = await getMe(cookie);
  if (me?.role === "staff") {
    const summary = await getStaffPostsSummary(cookie);
    return <StaffDashboard summary={summary} />;
  }

  const [overview, umami] = await Promise.all([
    getAdminStatsOverview(range, cookie),
    getAdminUmamiStats(range, cookie),
  ]);

  const totals = overview?.totals ?? { views: 0, likes: 0, dislikes: 0, comments: 0, publishedPosts: 0 };
  const previousTotals = overview?.previousTotals ?? null;
  const series = overview?.series ?? [];
  const topPosts = overview?.topPosts ?? [];
  const recentComments = overview?.recentComments ?? [];

  // Umami — diskriminatsiyalangan union, shu sabab bitta `if` blokida ochib,
  // faqat oddiy qiymatlarni keyingi ishlatish uchun ajratib olamiz (JSX'da
  // union'ni qayta tekshirmaslik uchun).
  let umamiOk = false;
  let visitors: number | null = null;
  let previousVisitors: number | null = null;
  let avgDuration = "";
  let referrers: UmamiMetricRow[] = [];
  let countries: UmamiMetricRow[] = [];
  let devices: UmamiMetricRow[] = [];

  if (umami && umami.configured && !umami.error) {
    umamiOk = true;
    visitors = umami.stats?.visitors ?? 0;
    previousVisitors = umami.previous?.visitors ?? null;
    avgDuration = umami.stats ? formatAvgDuration(umami.stats.totaltime, umami.stats.visits) : "";
    referrers = umami.referrers ?? [];
    countries = umami.countries ?? [];
    devices = umami.devices ?? [];
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">Xush kelibsiz!</p>
        </div>
        <NewPostButton />
      </div>

      <StatsRangeTabs basePath="/admin" active={range} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Ko'rishlar" value={totals.views} previous={previousTotals?.views ?? null} />
        <StatTile label="Tashrifchilar" value={visitors ?? "—"} previous={umamiOk ? previousVisitors : undefined} />
        <StatTile label="Like" value={totals.likes} previous={previousTotals?.likes ?? null} />
        <StatTile label="Dislike" value={totals.dislikes} previous={previousTotals?.dislikes ?? null} />
        <StatTile label="Fikrlar" value={totals.comments} previous={previousTotals?.comments ?? null} />
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">Ko&apos;rishlar</h2>
        <ViewsChart series={series} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">Top postlar</h2>
          </div>
          <TopPostsTable posts={topPosts} />
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">So&apos;nggi fikrlar</h2>
            <Link href="/admin/fikrlar" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
              Barchasi
            </Link>
          </div>
          <RecentCommentsList comments={recentComments} />
        </div>
      </div>

      {umamiOk ? (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            Tashrifchilar tafsiloti
            {avgDuration ? (
              <span className="ml-2 font-normal text-xs text-muted-foreground/70">
                o&apos;rtacha davomiylik {avgDuration}
              </span>
            ) : null}
          </h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <UmamiMetricList title="Manbalar" rows={referrers} />
            <UmamiMetricList title="Davlatlar" rows={countries} />
            <UmamiMetricList title="Qurilmalar" rows={devices} />
          </div>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
          Tashrifchi statistikasi uchun <code className="font-mono text-xs">UMAMI_API_URL</code>,{" "}
          <code className="font-mono text-xs">UMAMI_WEBSITE_ID</code> va{" "}
          <code className="font-mono text-xs">UMAMI_API_KEY</code> (yoki{" "}
          <code className="font-mono text-xs">UMAMI_USERNAME</code>/<code className="font-mono text-xs">UMAMI_PASSWORD</code>)
          sozlanmagan.
        </p>
      )}
    </div>
  );
}

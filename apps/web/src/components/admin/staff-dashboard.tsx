import Link from "next/link";
import type { StaffPostsSummary } from "@blog/shared";
import { NewPostButton } from "@/components/admin/new-post-button";
import { PostStatusBadge } from "@/components/admin/post-status-badge";
import { formatDateTime } from "@/lib/format";

function CountTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold tracking-tight">{value}</span>
    </div>
  );
}

/** Xodim (staff) uchun soddalashtirilgan dashboard — statistika/Umami o'rniga faqat o'z postlari. */
export function StaffDashboard({ summary }: { summary: StaffPostsSummary | null }) {
  const counts = summary?.counts ?? {
    draft: 0,
    in_review: 0,
    changes_requested: 0,
    published: 0,
    archived: 0,
  };
  const recent = summary?.recent ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">Xush kelibsiz! Postlaringiz holati quyida.</p>
        </div>
        <NewPostButton />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <CountTile label="Qoralama" value={counts.draft} />
        <CountTile label="Ko'rib chiqilmoqda" value={counts.in_review} />
        <CountTile label="Tuzatish so'raldi" value={counts.changes_requested} />
        <CountTile label="Chop etilgan" value={counts.published} />
        <CountTile label="Arxiv" value={counts.archived} />
      </div>

      {counts.changes_requested > 0 ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          Ba&apos;zi postlaringiz uchun tuzatish so&apos;ralgan — pastdagi ro&apos;yxatdan yoki{" "}
          <Link href="/admin/postlar?status=changes_requested" className="underline underline-offset-2">
            shu havoladan
          </Link>{" "}
          ko&apos;ring.
        </div>
      ) : null}

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground">So&apos;nggi postlaringiz</h2>
          <Link href="/admin/postlar" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
            Barchasi
          </Link>
        </div>

        {recent.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            Hali postingiz yo&apos;q.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {recent.map((post) => (
              <Link
                key={post.id}
                href={`/admin/postlar/${post.id}`}
                className="flex flex-col gap-1.5 rounded-lg border border-border p-3 hover:border-foreground/30"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="line-clamp-2 min-w-0 flex-1 text-sm font-medium">{post.title}</span>
                  <PostStatusBadge status={post.status} />
                </div>
                <span className="text-xs text-muted-foreground">{formatDateTime(post.updatedAt)}</span>
                {post.status === "changes_requested" && post.reviewNote ? (
                  <p className="rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
                    {post.reviewNote}
                  </p>
                ) : null}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

import Link from "next/link";
import type { StatsRecentComment } from "@blog/shared";
import { RelativeTime } from "@/components/relative-time";

const STATUS_LABEL: Record<StatsRecentComment["status"], string> = {
  visible: "Ko'rinadigan",
  pending: "Kutilmoqda",
  hidden: "Yashirilgan",
  deleted: "O'chirilgan",
};

export function RecentCommentsList({ comments, showPostTitle = true }: { comments: StatsRecentComment[]; showPostTitle?: boolean }) {
  if (comments.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        Hali fikrlar yo&apos;q.
      </p>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
      {comments.map((comment) => (
        <Link
          key={comment.id}
          href={`/admin/fikrlar?postId=${comment.postId}`}
          className="flex flex-col gap-1 px-4 py-3 hover:bg-muted/40"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{comment.authorName}</span>
            <RelativeTime iso={comment.createdAt} className="shrink-0 text-xs text-muted-foreground" />
          </div>
          <p className="line-clamp-2 text-sm text-muted-foreground">{comment.body}</p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {showPostTitle ? <span className="line-clamp-1">{comment.postTitle}</span> : null}
            {comment.status === "pending" ? (
              <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[0.65rem] text-primary">
                {STATUS_LABEL[comment.status]}
              </span>
            ) : null}
          </div>
        </Link>
      ))}
    </div>
  );
}

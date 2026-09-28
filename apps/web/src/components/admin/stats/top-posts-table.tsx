import Link from "next/link";
import { MessageCircle, ThumbsDown, ThumbsUp, Eye as EyeIcon } from "lucide-react";
import type { StatsTopPost } from "@blog/shared";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCompactNumber } from "@/lib/stats-format";

export function TopPostsTable({ posts }: { posts: StatsTopPost[] }) {
  if (posts.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        Bu davrda ko&apos;rishlar qayd etilmagan.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Post</TableHead>
            <TableHead className="text-right">Ko&apos;rsatkichlar</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {posts.map((post) => (
            <TableRow key={post.id}>
              <TableCell className="max-w-64">
                <Link href={`/admin/statistika/${post.id}`} className="line-clamp-1 font-medium hover:underline">
                  {post.title}
                </Link>
              </TableCell>
              <TableCell>
                <div className="flex items-center justify-end gap-2.5 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <EyeIcon className="size-3.5" /> {formatCompactNumber(post.views)}
                  </span>
                  <span className="flex items-center gap-1">
                    <ThumbsUp className="size-3.5" /> {formatCompactNumber(post.likes)}
                  </span>
                  <span className="flex items-center gap-1">
                    <ThumbsDown className="size-3.5" /> {formatCompactNumber(post.dislikes)}
                  </span>
                  <span className="flex items-center gap-1">
                    <MessageCircle className="size-3.5" /> {formatCompactNumber(post.comments)}
                  </span>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

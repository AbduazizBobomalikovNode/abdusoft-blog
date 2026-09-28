"use client";

import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function CommentFilters({
  posts,
  status,
  postId,
  q,
}: {
  posts: { id: string; title: string }[];
  status: string;
  postId?: string;
  q?: string;
}) {
  const router = useRouter();

  function handlePostChange(value: string) {
    const search = new URLSearchParams();
    if (status !== "all") search.set("status", status);
    if (value !== "all") search.set("postId", value);
    if (q) search.set("q", q);
    const qs = search.toString();
    router.push(qs ? `/admin/fikrlar?${qs}` : "/admin/fikrlar");
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <form action="/admin/fikrlar" method="get" className="flex items-center gap-2">
        {status !== "all" ? <input type="hidden" name="status" value={status} /> : null}
        {postId ? <input type="hidden" name="postId" value={postId} /> : null}
        <Input
          type="search"
          name="q"
          placeholder="Qidirish…"
          defaultValue={q}
          aria-label="Fikrlarni qidirish"
          className="w-48"
        />
      </form>

      <Select value={postId ?? "all"} onValueChange={handlePostChange}>
        <SelectTrigger size="sm" className="w-52">
          <SelectValue placeholder="Barcha postlar" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Barcha postlar</SelectItem>
          {posts.map((post) => (
            <SelectItem key={post.id} value={post.id}>
              {post.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

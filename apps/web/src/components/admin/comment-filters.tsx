"use client";

import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

type TimePreset = "all" | "today" | "7d" | "30d" | "custom";

function presetFor(from?: string, to?: string): TimePreset {
  if (!from && !to) return "all";
  const today = toDateOnly(new Date());
  if (from === today && to === today) return "today";
  if (to === today && from) {
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
    if (days === 6) return "7d";
    if (days === 29) return "30d";
  }
  return "custom";
}

function rangeForPreset(preset: TimePreset): { from?: string; to?: string } {
  if (preset === "all") return {};
  const today = new Date();
  const to = toDateOnly(today);
  if (preset === "today") return { from: to, to };
  const days = preset === "7d" ? 6 : preset === "30d" ? 29 : 0;
  const from = new Date(today);
  from.setDate(from.getDate() - days);
  return { from: toDateOnly(from), to };
}

export function CommentFilters({
  posts,
  status,
  postId,
  q,
  source = "all",
  from,
  to,
  sourceCounts,
}: {
  posts: { id: string; title: string }[];
  status: string;
  postId?: string;
  q?: string;
  source?: string;
  from?: string;
  to?: string;
  sourceCounts?: { all: number; web: number; telegram: number };
}) {
  const router = useRouter();

  function navigate(overrides: Record<string, string | undefined>) {
    const params: Record<string, string | undefined> = {
      status: status !== "all" ? status : undefined,
      source: source !== "all" ? source : undefined,
      postId,
      q,
      from,
      to,
      ...overrides,
    };
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value) search.set(key, value);
    }
    const qs = search.toString();
    router.push(qs ? `/admin/fikrlar?${qs}` : "/admin/fikrlar");
  }

  const activePreset = presetFor(from, to);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <form action="/admin/fikrlar" method="get" className="flex items-center gap-2">
        {status !== "all" ? <input type="hidden" name="status" value={status} /> : null}
        {source !== "all" ? <input type="hidden" name="source" value={source} /> : null}
        {postId ? <input type="hidden" name="postId" value={postId} /> : null}
        {from ? <input type="hidden" name="from" value={from} /> : null}
        {to ? <input type="hidden" name="to" value={to} /> : null}
        <Input
          type="search"
          name="q"
          placeholder="Qidirish…"
          defaultValue={q}
          aria-label="Fikrlarni qidirish"
          className="w-48"
        />
      </form>

      <Select value={postId ?? "all"} onValueChange={(value) => navigate({ postId: value === "all" ? undefined : value })}>
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

      <Select value={source} onValueChange={(value) => navigate({ source: value === "all" ? undefined : value })}>
        <SelectTrigger size="sm" className="w-40" aria-label="Manba">
          <SelectValue placeholder="Manba" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Manba: Hammasi{sourceCounts ? ` (${sourceCounts.all})` : ""}</SelectItem>
          <SelectItem value="web">Web{sourceCounts ? ` (${sourceCounts.web})` : ""}</SelectItem>
          <SelectItem value="telegram">Telegram{sourceCounts ? ` (${sourceCounts.telegram})` : ""}</SelectItem>
        </SelectContent>
      </Select>

      <Select
        value={activePreset}
        onValueChange={(value) => navigate(rangeForPreset(value as TimePreset))}
      >
        <SelectTrigger size="sm" className="w-36" aria-label="Vaqt">
          <SelectValue placeholder="Vaqt" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Hammasi</SelectItem>
          <SelectItem value="today">Bugun</SelectItem>
          <SelectItem value="7d">7 kun</SelectItem>
          <SelectItem value="30d">30 kun</SelectItem>
          <SelectItem value="custom">Boshqa oraliq…</SelectItem>
        </SelectContent>
      </Select>

      {activePreset === "custom" ? (
        <div className="flex items-center gap-1.5">
          <Input
            type="date"
            aria-label="Boshlanish sanasi"
            defaultValue={from}
            className="w-36"
            onChange={(e) => navigate({ from: e.target.value || undefined })}
          />
          <span className="text-xs text-muted-foreground">—</span>
          <Input
            type="date"
            aria-label="Tugash sanasi"
            defaultValue={to}
            className="w-36"
            onChange={(e) => navigate({ to: e.target.value || undefined })}
          />
        </div>
      ) : null}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { toast } from "sonner";
import { ReactionMeResponseSchema, ReactionResponseSchema, type PostDetail, type ReactionType } from "@blog/shared";
import { site } from "@/lib/site";
import { cn } from "@/lib/utils";

function applyReactionDelta(
  likes: number,
  dislikes: number,
  prevMine: ReactionType | null,
  next: ReactionType | null,
) {
  let l = likes;
  let d = dislikes;
  if (prevMine === "like") l -= 1;
  if (prevMine === "dislike") d -= 1;
  if (next === "like") l += 1;
  if (next === "dislike") d += 1;
  return { likes: l, dislikes: d };
}

/**
 * Post ostidagi like/dislike pillari. Faqat `reactionsEnabled` bo'lganda
 * render qilinadi. Boshlang'ich "mening" holatim alohida `/reactions/me`
 * so'rovi bilan olinadi (izohlar ro'yxatini qayta yuklamaslik uchun).
 */
export function PostReactions({ post }: { post: PostDetail }) {
  if (!post.settings.reactionsEnabled) return null;
  return <PostReactionsInner post={post} />;
}

function PostReactionsInner({ post }: { post: PostDetail }) {
  const [likes, setLikes] = useState(post.counts.likes);
  const [dislikes, setDislikes] = useState(post.counts.dislikes);
  const [mine, setMine] = useState<ReactionType | null>(null);
  const [busy, setBusy] = useState(false);
  const [popLike, setPopLike] = useState(0);
  const [popDislike, setPopDislike] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const res = await fetch(`${site.apiUrl}/posts/${encodeURIComponent(post.slug)}/reactions/me`, {
          credentials: "include",
        });
        if (!res.ok) return;
        const data = ReactionMeResponseSchema.parse(await res.json());
        if (!cancelled) setMine(data.mine);
      } catch {
        // jim — boshlang'ich holat neytral qoladi
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [post.slug]);

  async function tap(type: ReactionType) {
    if (busy) return;

    const next = mine === type ? null : type;
    const prevMine = mine;
    const prevLikes = likes;
    const prevDislikes = dislikes;
    const optimistic = applyReactionDelta(likes, dislikes, prevMine, next);

    setMine(next);
    setLikes(optimistic.likes);
    setDislikes(optimistic.dislikes);
    if (type === "like") setPopLike((n) => n + 1);
    else setPopDislike((n) => n + 1);

    setBusy(true);
    try {
      const res = await fetch(`${site.apiUrl}/posts/${encodeURIComponent(post.slug)}/reactions`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: next }),
      });
      if (!res.ok) throw new Error("reaction failed");
      const data = ReactionResponseSchema.parse(await res.json());
      setLikes(data.likes);
      setDislikes(data.dislikes);
      setMine(data.mine);
    } catch {
      setMine(prevMine);
      setLikes(prevLikes);
      setDislikes(prevDislikes);
      toast.error("Bajarib bo'lmadi, qayta urinib ko'ring");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2 border-y border-border py-4" aria-live="polite">
      <button
        type="button"
        onClick={() => void tap("like")}
        disabled={busy}
        aria-pressed={mine === "like"}
        aria-label={`Yoqtirish${likes > 0 ? ` (${likes})` : ""}`}
        className={cn(
          "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
          mine === "like"
            ? "border-foreground bg-foreground text-background"
            : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
        )}
      >
        <ThumbsUp key={popLike} aria-hidden="true" className={cn("size-4", popLike > 0 && "reaction-pop")} />
        {likes > 0 ? likes : null}
      </button>

      {post.settings.showDislike ? (
        <button
          type="button"
          onClick={() => void tap("dislike")}
          disabled={busy}
          aria-pressed={mine === "dislike"}
          aria-label={`Yoqtirmaslik${dislikes > 0 ? ` (${dislikes})` : ""}`}
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
            mine === "dislike"
              ? "border-foreground bg-foreground text-background"
              : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
          )}
        >
          <ThumbsDown key={popDislike} aria-hidden="true" className={cn("size-4", popDislike > 0 && "reaction-pop")} />
          {dislikes > 0 ? dislikes : null}
        </button>
      ) : null}
    </div>
  );
}

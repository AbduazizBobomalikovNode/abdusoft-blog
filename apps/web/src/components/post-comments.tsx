"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BadgeCheck, ThumbsDown, ThumbsUp } from "lucide-react";
import { toast } from "sonner";
import {
  CommentsListResponseSchema,
  CreateCommentResponseSchema,
  DeviceMeSchema,
  ReactionResponseSchema,
  type CommentNode,
  type CommentSort,
  type DeviceMe,
  type PostDetail,
  type ReactionType,
} from "@blog/shared";
import { RelativeTime } from "@/components/relative-time";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { signIn, signOut } from "@/lib/auth-client";
import { site } from "@/lib/site";
import { useSiteConfig } from "@/lib/site-config";
import { cn } from "@/lib/utils";

const AUTHOR_NAME_KEY = "blog:comment-author-name";
const MAX_VISIBLE_REPLIES = 2;
const MAX_VISUAL_DEPTH = 2;
const INDENT_CLASSES = ["", "ml-6 sm:ml-8", "ml-12 sm:ml-16"];

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        opts: {
          sitekey: string;
          callback: (token: string) => void;
          "expired-callback"?: () => void;
        },
      ) => string;
      reset: (widgetId?: string) => void;
    };
  }
}

// ---------------------------------------------------------------------------
// Yordamchi funksiyalar — daraxtni lokal holatda yangilash uchun
// ---------------------------------------------------------------------------

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

function insertReplyInTree(nodes: CommentNode[], parentId: string, child: CommentNode): CommentNode[] {
  return nodes.map((n) => {
    if (n.id === parentId) return { ...n, replies: [child, ...n.replies] };
    if (n.replies.length > 0) return { ...n, replies: insertReplyInTree(n.replies, parentId, child) };
    return n;
  });
}

function updateCommentInTree(nodes: CommentNode[], id: string, patch: Partial<CommentNode>): CommentNode[] {
  return nodes.map((n) => {
    if (n.id === id) return { ...n, ...patch };
    if (n.replies.length > 0) return { ...n, replies: updateCommentInTree(n.replies, id, patch) };
    return n;
  });
}

function deleteCommentInTree(nodes: CommentNode[], id: string): CommentNode[] {
  const out: CommentNode[] = [];
  for (const n of nodes) {
    if (n.id === id) {
      if (n.replies.length === 0) continue;
      out.push({ ...n, deleted: true, body: "", bodyHtml: "" });
      continue;
    }
    if (n.replies.length > 0) {
      out.push({ ...n, replies: deleteCommentInTree(n.replies, id) });
      continue;
    }
    out.push(n);
  }
  return out;
}

async function extractError(res: Response, fallback: string): Promise<string> {
  try {
    const data: unknown = await res.json();
    if (data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string") {
      return (data as { error: string }).error;
    }
  } catch {
    // ignore
  }
  return fallback;
}

async function fetchDeviceMe(): Promise<DeviceMe | null> {
  try {
    const res = await fetch(`${site.apiUrl}/me`, { credentials: "include" });
    if (!res.ok) return null;
    return DeviceMeSchema.parse(await res.json());
  } catch {
    return null;
  }
}

function hashHue(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  return hash % 360;
}

function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

function Avatar({ name, image, className }: { name: string; image?: string | null; className?: string }) {
  if (image) {
    // eslint-disable-next-line @next/next/no-img-element -- tashqi (GitHub) domendan rasm
    return <img src={image} alt="" className={cn("rounded-full object-cover", className)} />;
  }
  return (
    <span
      aria-hidden="true"
      className={cn("flex shrink-0 items-center justify-center rounded-full text-[0.65rem] font-semibold text-white", className)}
      style={{ backgroundColor: `hsl(${hashHue(name || "?")} 55% 42%)` }}
    >
      {initialsOf(name)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Cloudflare Turnstile — lazy script + widget hook
// ---------------------------------------------------------------------------

/**
 * "Tahrirlash" oynasi 15 daqiqada yopilishini aniqlash uchun soat — render
 * paytida to'g'ridan-to'g'ri `Date.now()` chaqirmaslik uchun, qiymat state'da
 * saqlanadi va vaqti-vaqti bilan effekt orqali yangilanadi.
 */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}

function useTurnstile(siteKey: string) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;
    let poll: ReturnType<typeof setInterval> | null = null;

    function renderWidget() {
      if (cancelled || !containerRef.current || !window.turnstile || widgetIdRef.current) return;
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        callback: (t) => setToken(t),
        "expired-callback": () => setToken(null),
      });
    }

    if (window.turnstile) {
      renderWidget();
    } else {
      if (!document.getElementById("cf-turnstile-script")) {
        const script = document.createElement("script");
        script.id = "cf-turnstile-script";
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
      poll = setInterval(() => {
        if (window.turnstile) {
          if (poll) clearInterval(poll);
          renderWidget();
        }
      }, 200);
    }

    return () => {
      cancelled = true;
      if (poll) clearInterval(poll);
    };
  }, [siteKey]);

  const reset = useCallback(() => {
    setToken(null);
    if (window.turnstile && widgetIdRef.current) {
      try {
        window.turnstile.reset(widgetIdRef.current);
      } catch {
        // jim
      }
    }
  }, []);

  return { containerRef, token, reset };
}

// ---------------------------------------------------------------------------
// Composer — yangi izoh / javob yozish formasi
// ---------------------------------------------------------------------------

interface ComposerSubmitPayload {
  authorName?: string;
  body: string;
  website: string;
  turnstileToken?: string;
}

function Composer({
  deviceMe,
  allowAnonymous,
  onSignOut,
  onSubmit,
  onPosted,
  onCancel,
  autoFocus,
  submitLabel,
}: {
  deviceMe: DeviceMe | null;
  allowAnonymous: boolean;
  onSignOut: () => void;
  onSubmit: (payload: ComposerSubmitPayload) => Promise<CommentNode>;
  onPosted: (node: CommentNode) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
  submitLabel?: string;
}) {
  const config = useSiteConfig();
  const [authorName, setAuthorName] = useState(() => {
    if (typeof window === "undefined") return "";
    try {
      return window.localStorage.getItem(AUTHOR_NAME_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [body, setBody] = useState("");
  const [website, setWebsite] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { containerRef: turnstileRef, token: turnstileToken, reset: resetTurnstile } = useTurnstile(
    config.turnstileSiteKey,
  );

  const signedIn = Boolean(deviceMe?.user);

  async function handleSubmit(event?: React.FormEvent) {
    event?.preventDefault();
    if (submitting) return;
    const trimmedBody = body.trim();
    if (trimmedBody.length === 0) return;
    if (!signedIn && authorName.trim().length < 2) {
      toast.error("Ism kiriting (kamida 2 ta belgi)");
      return;
    }

    setSubmitting(true);
    try {
      const node = await onSubmit({
        authorName: signedIn ? undefined : authorName.trim(),
        body: trimmedBody,
        website,
        turnstileToken: turnstileToken ?? undefined,
      });
      if (!signedIn) {
        try {
          window.localStorage.setItem(AUTHOR_NAME_KEY, authorName.trim());
        } catch {
          // jim
        }
      }
      setBody("");
      resetTurnstile();
      onPosted(node);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Fikr yuborilmadi");
    } finally {
      setSubmitting(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void handleSubmit();
    }
  }

  if (!allowAnonymous && !signedIn) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border px-4 py-4 text-sm text-muted-foreground">
        {config.githubLoginEnabled ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => void signIn.social({ provider: "github", callbackURL: window.location.href })}
          >
            GitHub bilan kirish
          </Button>
        ) : (
          <p>Fikr bildirish uchun tizimga kiring.</p>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-2">
      {signedIn && deviceMe?.user ? (
        <div className="flex items-center gap-2">
          <Avatar name={deviceMe.user.name ?? "Foydalanuvchi"} image={deviceMe.user.image} className="size-7" />
          <span className="text-sm font-medium">{deviceMe.user.name ?? "Foydalanuvchi"}</span>
          <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={onSignOut}>
            Chiqish
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={authorName}
            onChange={(event) => setAuthorName(event.target.value)}
            placeholder="Ismingiz"
            minLength={2}
            maxLength={40}
            required
            className="max-w-56"
          />
          {config.githubLoginEnabled ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void signIn.social({ provider: "github", callbackURL: window.location.href })}
            >
              GitHub bilan kirish
            </Button>
          ) : null}
        </div>
      )}

      <Textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Fikringizni yozing…"
        maxLength={4000}
        autoFocus={autoFocus}
        className="min-h-20"
      />

      {/* Honeypot — botlar uchun, odam ko'rmaydi */}
      <input
        type="text"
        name="website"
        value={website}
        onChange={(event) => setWebsite(event.target.value)}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute -left-[9999px] h-0 w-0 opacity-0"
      />

      {config.turnstileSiteKey ? <div ref={turnstileRef} /> : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          **qalin**, _kursiv_, `kod` qo&apos;llab-quvvatlanadi
        </p>
        <div className="flex items-center gap-2">
          {onCancel ? (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Bekor qilish
            </Button>
          ) : null}
          <Button type="submit" size="sm" disabled={submitting || body.trim().length === 0}>
            {submitting ? "Yuborilmoqda…" : (submitLabel ?? "Yuborish")}
          </Button>
        </div>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Izoh tuguni (rekursiv) va uning reaksiya tugmalari
// ---------------------------------------------------------------------------

interface ThreadCtx {
  deviceMe: DeviceMe | null;
  allowAnonymous: boolean;
  showDislike: boolean;
  meReactions: Record<string, ReactionType>;
  popMap: Record<string, number>;
  onSignOut: () => void;
  onReaction: (comment: CommentNode, type: ReactionType) => void;
  onReplyPosted: (parentId: string, node: CommentNode) => void;
  onEditSaved: (id: string, body: string) => Promise<boolean>;
  onDeleted: (comment: CommentNode) => Promise<void>;
  submitComment: (parentId: string, payload: ComposerSubmitPayload) => Promise<CommentNode>;
}

function ReactionButtons({ comment, ctx }: { comment: CommentNode; ctx: ThreadCtx }) {
  const mine = ctx.meReactions[comment.id] ?? null;
  const popLike = ctx.popMap[`${comment.id}:like`] ?? 0;
  const popDislike = ctx.popMap[`${comment.id}:dislike`] ?? 0;

  return (
    <span className="flex items-center gap-3" aria-live="polite">
      <button
        type="button"
        onClick={() => ctx.onReaction(comment, "like")}
        aria-pressed={mine === "like"}
        aria-label={`Yoqtirish${comment.likes > 0 ? ` (${comment.likes})` : ""}`}
        className={cn("flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", mine === "like" && "font-medium text-foreground")}
      >
        <ThumbsUp key={popLike} aria-hidden="true" className={cn("size-3.5", popLike > 0 && "reaction-pop")} />
        {comment.likes > 0 ? comment.likes : null}
      </button>
      {ctx.showDislike ? (
        <button
          type="button"
          onClick={() => ctx.onReaction(comment, "dislike")}
          aria-pressed={mine === "dislike"}
          aria-label={`Yoqtirmaslik${comment.dislikes > 0 ? ` (${comment.dislikes})` : ""}`}
          className={cn("flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", mine === "dislike" && "font-medium text-foreground")}
        >
          <ThumbsDown key={popDislike} aria-hidden="true" className={cn("size-3.5", popDislike > 0 && "reaction-pop")} />
          {comment.dislikes > 0 ? comment.dislikes : null}
        </button>
      ) : null}
    </span>
  );
}

function EditForm({
  initialBody,
  onSave,
  onCancel,
}: {
  initialBody: string;
  onSave: (body: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialBody);
  const [saving, setSaving] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <Textarea value={value} onChange={(event) => setValue(event.target.value)} maxLength={4000} className="min-h-16" autoFocus />
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={saving || value.trim().length === 0}
          onClick={() => {
            setSaving(true);
            void onSave(value.trim()).then((ok) => {
              setSaving(false);
              if (ok) onCancel();
            });
          }}
        >
          {saving ? "Saqlanmoqda…" : "Saqlash"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Bekor qilish
        </Button>
      </div>
    </div>
  );
}

function CommentThread({
  comment,
  ctx,
  replyToName,
  isFlat,
}: {
  comment: CommentNode;
  ctx: ThreadCtx;
  replyToName?: string;
  isFlat?: boolean;
}) {
  const [replyOpen, setReplyOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const now = useNow();

  const indentIndex = Math.min(comment.depth, MAX_VISUAL_DEPTH);
  const canEdit =
    comment.isMine && !comment.deleted && comment.editableUntil !== null && now < new Date(comment.editableUntil).getTime();
  const canDelete = comment.isMine && !comment.deleted;

  const replies = comment.replies;
  const visibleReplies = expanded ? replies : replies.slice(0, MAX_VISIBLE_REPLIES);
  const hiddenCount = replies.length - visibleReplies.length;

  return (
    <div className={cn("flex flex-col gap-2 py-3", INDENT_CLASSES[indentIndex])}>
      <div className="flex items-start gap-2.5">
        <Avatar name={comment.authorName} image={comment.authorImage} className="size-8" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            {isFlat && replyToName ? <span className="text-xs text-muted-foreground">@{replyToName}</span> : null}
            <span className="font-medium">{comment.authorName}</span>
            {comment.authorIsAdmin ? (
              <Badge variant="secondary" className="h-4 px-1.5 text-[0.6rem]">
                Muallif
              </Badge>
            ) : comment.authorVerified ? (
              <BadgeCheck className="size-3.5 text-muted-foreground" aria-label="Tasdiqlangan" />
            ) : null}
            <RelativeTime iso={comment.createdAt} className="text-xs text-muted-foreground" />
            {comment.editedAt ? <span className="text-xs text-muted-foreground">(tahrirlangan)</span> : null}
          </div>

          {comment.deleted ? (
            <p className="text-sm text-muted-foreground italic">[o&apos;chirilgan]</p>
          ) : editing ? (
            <EditForm
              initialBody={comment.body}
              onCancel={() => setEditing(false)}
              onSave={(body) => ctx.onEditSaved(comment.id, body)}
            />
          ) : (
            <>
              {comment.pending ? <p className="text-xs text-muted-foreground">Moderatsiyadan so&apos;ng ko&apos;rinadi</p> : null}
              <div className="prose-article text-sm" dangerouslySetInnerHTML={{ __html: comment.bodyHtml }} />
            </>
          )}

          {!comment.deleted && !editing ? (
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <button type="button" onClick={() => setReplyOpen((v) => !v)} className="rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Javob
              </button>
              <ReactionButtons comment={comment} ctx={ctx} />
              {canEdit ? (
                <button type="button" onClick={() => setEditing(true)} className="rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  Tahrirlash
                </button>
              ) : null}
              {canDelete ? (
                <button
                  type="button"
                  onClick={() => setDeleteOpen(true)}
                  className="rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  O&apos;chirish
                </button>
              ) : null}
            </div>
          ) : comment.deleted && replies.length > 0 ? (
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <button type="button" onClick={() => setReplyOpen((v) => !v)} className="rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Javob
              </button>
            </div>
          ) : null}

          {replyOpen ? (
            <Composer
              deviceMe={ctx.deviceMe}
              allowAnonymous={ctx.allowAnonymous}
              onSignOut={ctx.onSignOut}
              autoFocus
              submitLabel="Javob yuborish"
              onCancel={() => setReplyOpen(false)}
              onSubmit={(payload) => ctx.submitComment(comment.id, payload)}
              onPosted={(node) => {
                ctx.onReplyPosted(comment.id, node);
                setReplyOpen(false);
              }}
            />
          ) : null}
        </div>
      </div>

      {visibleReplies.map((child) => (
        <CommentThread
          key={child.id}
          comment={child}
          ctx={ctx}
          isFlat={child.depth >= 3}
          replyToName={child.depth >= 3 ? comment.authorName : undefined}
        />
      ))}

      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="ml-10 w-fit rounded text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Yana {hiddenCount} ta javob
        </button>
      ) : null}

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Fikrni o&apos;chirish</AlertDialogTitle>
            <AlertDialogDescription>Bu fikr o&apos;chiriladi. Bu amalni qaytarib bo&apos;lmaydi.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void ctx.onDeleted(comment)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              O&apos;chirish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Asosiy komponent
// ---------------------------------------------------------------------------

export function PostComments({ post }: { post: PostDetail }) {
  if (!post.settings.commentsEnabled) {
    return (
      <section className="border-t border-border pt-8 text-center text-sm text-muted-foreground">
        Bu postda fikrlar yopilgan.
      </section>
    );
  }
  return <PostCommentsInner post={post} />;
}

function PostCommentsInner({ post }: { post: PostDetail }) {
  const [sort, setSort] = useState<CommentSort>("new");
  const [items, setItems] = useState<CommentNode[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [commentsCount, setCommentsCount] = useState(post.counts.comments);
  const [deviceMe, setDeviceMe] = useState<DeviceMe | null>(null);
  const [meReactions, setMeReactions] = useState<Record<string, ReactionType>>({});
  const [popMap, setPopMap] = useState<Record<string, number>>({});

  useEffect(() => {
    void fetchDeviceMe().then(setDeviceMe);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const data = await fetchComments(post.slug, sort, null);
      if (cancelled) return;
      if (data) {
        setItems(data.items);
        setNextCursor(data.nextCursor);
        setMeReactions(data.me.reactions);
      } else {
        toast.error("Fikrlarni yuklab bo'lmadi");
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [sort, post.slug]);

  async function fetchComments(slug: string, targetSort: CommentSort, cursor: string | null) {
    const search = new URLSearchParams({ sort: targetSort });
    if (cursor) search.set("cursor", cursor);
    try {
      const res = await fetch(`${site.apiUrl}/posts/${encodeURIComponent(slug)}/comments?${search.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) return null;
      return CommentsListResponseSchema.parse(await res.json());
    } catch {
      return null;
    }
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    const data = await fetchComments(post.slug, sort, nextCursor);
    if (data) {
      setItems((prev) => [...prev, ...data.items]);
      setNextCursor(data.nextCursor);
      setMeReactions((prev) => ({ ...prev, ...data.me.reactions }));
    } else {
      toast.error("Fikrlarni yuklab bo'lmadi");
    }
    setLoadingMore(false);
  }

  async function handleSignOut() {
    try {
      await signOut();
    } catch {
      // jim
    }
    setDeviceMe(await fetchDeviceMe());
  }

  async function postComment(parentId: string | null, payload: ComposerSubmitPayload): Promise<CommentNode> {
    const res = await fetch(`${site.apiUrl}/posts/${encodeURIComponent(post.slug)}/comments`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentId, ...payload }),
    });
    if (res.status === 429) throw new Error("Biroz kuting — juda ko'p fikr yubordingiz");
    if (!res.ok) throw new Error(await extractError(res, "Fikr yuborilmadi"));
    const data = CreateCommentResponseSchema.parse(await res.json());
    return data.comment;
  }

  function insertComment(node: CommentNode, parentId: string | null) {
    if (!node.pending) setCommentsCount((c) => c + 1);
    setItems((prev) => (parentId ? insertReplyInTree(prev, parentId, node) : [node, ...prev]));
    if (node.pending) {
      toast.success("Fikringiz yuborildi, moderatsiyadan so'ng ko'rinadi");
    } else if (!parentId && sort === "top") {
      // "Top" tartibida yangi fikr (0 layk bilan) haqiqiy o'rniga emas, ro'yxat
      // boshiga optimistik qo'yiladi — chalkashlikning oldini olish uchun
      // ko'rinishni "Yangi"ga almashtiramiz va foydalanuvchiga xabar beramiz.
      setSort("new");
      toast.message("Tartib \"Yangi\"ga almashtirildi — fikringiz yuqorida ko'rinishi uchun");
    }
  }

  async function handleEditSave(id: string, body: string): Promise<boolean> {
    try {
      const res = await fetch(`${site.apiUrl}/comments/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        toast.error(await extractError(res, "Tahrirlab bo'lmadi"));
        return false;
      }
      const data = (await res.json()) as { body: string; bodyHtml: string; editedAt: string };
      setItems((prev) => updateCommentInTree(prev, id, { body: data.body, bodyHtml: data.bodyHtml, editedAt: data.editedAt }));
      return true;
    } catch {
      toast.error("Bajarib bo'lmadi, qayta urinib ko'ring");
      return false;
    }
  }

  async function handleDeleteComment(comment: CommentNode) {
    try {
      const res = await fetch(`${site.apiUrl}/comments/${comment.id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) {
        toast.error(await extractError(res, "O'chirib bo'lmadi"));
        return;
      }
      setItems((prev) => deleteCommentInTree(prev, comment.id));
      if (!comment.pending) setCommentsCount((c) => Math.max(0, c - 1));
    } catch {
      toast.error("Bajarib bo'lmadi, qayta urinib ko'ring");
    }
  }

  async function reactToComment(comment: CommentNode, type: ReactionType) {
    setPopMap((p) => ({ ...p, [`${comment.id}:${type}`]: (p[`${comment.id}:${type}`] ?? 0) + 1 }));

    const prevMine = meReactions[comment.id] ?? null;
    const next = prevMine === type ? null : type;
    const optimistic = applyReactionDelta(comment.likes, comment.dislikes, prevMine, next);

    setMeReactions((prev) => {
      const copy = { ...prev };
      if (next) copy[comment.id] = next;
      else delete copy[comment.id];
      return copy;
    });
    setItems((prev) => updateCommentInTree(prev, comment.id, optimistic));

    try {
      const res = await fetch(`${site.apiUrl}/comments/${comment.id}/reactions`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: next }),
      });
      if (!res.ok) throw new Error("reaction failed");
      const data = ReactionResponseSchema.parse(await res.json());
      setItems((prev) => updateCommentInTree(prev, comment.id, { likes: data.likes, dislikes: data.dislikes }));
      setMeReactions((prev) => {
        const copy = { ...prev };
        if (data.mine) copy[comment.id] = data.mine;
        else delete copy[comment.id];
        return copy;
      });
    } catch {
      setItems((prev) => updateCommentInTree(prev, comment.id, { likes: comment.likes, dislikes: comment.dislikes }));
      setMeReactions((prev) => {
        const copy = { ...prev };
        if (prevMine) copy[comment.id] = prevMine;
        else delete copy[comment.id];
        return copy;
      });
      toast.error("Bajarib bo'lmadi, qayta urinib ko'ring");
    }
  }

  const ctx: ThreadCtx = {
    deviceMe,
    allowAnonymous: post.settings.allowAnonymousComments,
    showDislike: post.settings.showDislike,
    meReactions,
    popMap,
    onSignOut: () => void handleSignOut(),
    onReaction: (comment, type) => void reactToComment(comment, type),
    onReplyPosted: (parentId, node) => insertComment(node, parentId),
    onEditSaved: handleEditSave,
    onDeleted: handleDeleteComment,
    submitComment: (parentId, payload) => postComment(parentId, payload),
  };

  return (
    <section className="flex flex-col gap-5 border-t border-border pt-8">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Fikrlar ({commentsCount})</h2>
        <div className="flex items-center gap-1 rounded-full border border-border p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setSort("new")}
            aria-pressed={sort === "new"}
            className={cn(
              "rounded-full px-2.5 py-1 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              sort === "new" ? "bg-foreground text-background" : "text-muted-foreground",
            )}
          >
            Yangi
          </button>
          <button
            type="button"
            onClick={() => setSort("top")}
            aria-pressed={sort === "top"}
            className={cn(
              "rounded-full px-2.5 py-1 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              sort === "top" ? "bg-foreground text-background" : "text-muted-foreground",
            )}
          >
            Top
          </button>
        </div>
      </div>

      <Composer
        deviceMe={deviceMe}
        allowAnonymous={post.settings.allowAnonymousComments}
        onSignOut={() => void handleSignOut()}
        onSubmit={(payload) => postComment(null, payload)}
        onPosted={(node) => insertComment(node, null)}
      />

      {loading ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Yuklanmoqda…</p>
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Bu yerda hali sukunat hukm suradi.</p>
      ) : (
        <div className="flex flex-col divide-y divide-border">
          {items.map((comment) => (
            <CommentThread key={comment.id} comment={comment} ctx={ctx} />
          ))}
        </div>
      )}

      {nextCursor ? (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? "Yuklanmoqda…" : "Yana yuklash"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

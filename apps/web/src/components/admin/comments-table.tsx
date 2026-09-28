"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ExternalLink, Eye, EyeOff, MessageCircle, MoreHorizontal, Reply, ShieldBan, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { AdminCommentItem } from "@blog/shared";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/admin/empty-state";
import { AdminApiError, adminApi } from "@/lib/admin-client";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { site } from "@/lib/site";

const STATUS_LABEL: Record<AdminCommentItem["status"], string> = {
  visible: "Ko'rinadigan",
  pending: "Kutilmoqda",
  hidden: "Yashirilgan",
  deleted: "O'chirilgan",
};

const STATUS_VARIANT: Record<AdminCommentItem["status"], "default" | "secondary" | "outline" | "destructive"> = {
  visible: "default",
  pending: "secondary",
  hidden: "outline",
  deleted: "destructive",
};

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function excerpt(html: string, max = 80): string {
  const text = stripHtml(html);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Manba belgisi — Web/Telegram (+ @username, bo'lsa) — jadval va mobil kartada bir xil ishlatiladi. */
function SourceBadge({ comment }: { comment: AdminCommentItem }) {
  if (comment.source !== "telegram") {
    return (
      <Badge variant="outline" className="h-4 shrink-0 px-1.5 text-[0.6rem]">
        Web
      </Badge>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <Badge variant="outline" className="h-4 shrink-0 px-1.5 text-[0.6rem] text-sky-600 dark:text-sky-400">
        Telegram
      </Badge>
      {comment.tgUsername ? <span className="text-xs text-muted-foreground">@{comment.tgUsername}</span> : null}
    </span>
  );
}

function CommentRowActions({ comment }: { comment: AdminCommentItem }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [banOpen, setBanOpen] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [banReason, setBanReason] = useState("");

  function run(action: () => Promise<unknown>, successMessage: string) {
    setPending(true);
    void action()
      .then(() => {
        toast.success(successMessage);
        router.refresh();
      })
      .catch((error: unknown) => {
        toast.error(error instanceof AdminApiError ? error.message : "Xatolik yuz berdi");
      })
      .finally(() => setPending(false));
  }

  async function handleDelete() {
    try {
      await adminApi.deleteComment(comment.id);
      toast.success("Fikr o'chirildi");
      setDeleteOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "O'chirib bo'lmadi");
    }
  }

  async function handleBan() {
    try {
      await adminApi.banCommentDevice(comment.id, banReason.trim() || undefined);
      toast.success("Qurilma bloklandi");
      setBanOpen(false);
      setBanReason("");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Bloklab bo'lmadi");
    }
  }

  async function handleReply() {
    if (!replyBody.trim()) return;
    try {
      await adminApi.replyToComment(comment.id, replyBody.trim());
      toast.success("Javob yuborildi");
      setReplyOpen(false);
      setReplyBody("");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Javob yuborilmadi");
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={pending}
            aria-label="Amallar"
            className="relative before:absolute before:-inset-2 before:content-['']"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {comment.status === "pending" && comment.source === "web" ? (
            <DropdownMenuItem onSelect={() => run(() => adminApi.updateCommentStatus(comment.id, "visible"), "Tasdiqlandi")}>
              <Check />
              Tasdiqlash
            </DropdownMenuItem>
          ) : null}
          {comment.source === "telegram" && comment.tgThreadUrl ? (
            <DropdownMenuItem asChild>
              <a href={comment.tgThreadUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink />
                Telegram&apos;da ochish
              </a>
            </DropdownMenuItem>
          ) : null}
          {comment.status !== "hidden" ? (
            <DropdownMenuItem onSelect={() => run(() => adminApi.updateCommentStatus(comment.id, "hidden"), "Yashirildi")}>
              <EyeOff />
              Yashirish
            </DropdownMenuItem>
          ) : null}
          {comment.status === "hidden" ? (
            <DropdownMenuItem onSelect={() => run(() => adminApi.updateCommentStatus(comment.id, "visible"), "Ko'rinadigan qilindi")}>
              <Eye />
              Ko&apos;rinadigan qilish
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => setReplyOpen(true)}>
            <Reply />
            Javob berish
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setBanOpen(true)}>
            <ShieldBan />
            Bloklash
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
            <Trash2 />
            O&apos;chirish
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Fikrni o&apos;chirish</AlertDialogTitle>
            <AlertDialogDescription>Bu amalni ortga qaytarib bo&apos;lmaydi.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              O&apos;chirish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={banOpen} onOpenChange={setBanOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Qurilmani bloklash</AlertDialogTitle>
            <AlertDialogDescription>
              Bu qurilmaning barcha ko&apos;rinadigan fikrlari yashiriladi va keyingi fikr bildirishlari bloklanadi.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            value={banReason}
            onChange={(event) => setBanReason(event.target.value)}
            placeholder="Sabab (ixtiyoriy)"
            className="min-h-16"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
            <AlertDialogAction onClick={handleBan} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Bloklash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={replyOpen} onOpenChange={setReplyOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Javob berish</DialogTitle>
            <DialogDescription>Admin nomidan javob yuboriladi va darhol ko&apos;rinadi bo&apos;ladi.</DialogDescription>
          </DialogHeader>
          <Textarea
            value={replyBody}
            onChange={(event) => setReplyBody(event.target.value)}
            className="min-h-24"
            placeholder="Javob matni…"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setReplyOpen(false)}>
              Bekor qilish
            </Button>
            <Button onClick={() => void handleReply()} disabled={!replyBody.trim()}>
              Yuborish
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Jadval gorizontal skroll qilinganida o'ng chetda xira soya ko'rsatadi (skroll mumkinligini bildiradi). */
function useScrollFade<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [scrollable, setScrollable] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    function check() {
      if (!el) return;
      const max = el.scrollWidth - el.clientWidth;
      setScrollable(max > 4 && el.scrollLeft < max - 4);
    }
    check();
    el.addEventListener("scroll", check);
    window.addEventListener("resize", check);
    return () => {
      el.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, []);

  return { ref, scrollable };
}

export function CommentsTable({ initialItems }: { initialItems: AdminCommentItem[] }) {
  const [items, setItems] = useState(initialItems);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPending, setBulkPending] = useState(false);
  const [prevInitialItems, setPrevInitialItems] = useState(initialItems);
  const router = useRouter();

  // `router.refresh()` server'dan yangi `initialItems` bilan qayta render qiladi —
  // shu paytda lokal holatni sinxronlaymiz (effekt emas, render paytida moslashtirish).
  if (initialItems !== prevInitialItems) {
    setPrevInitialItems(initialItems);
    setItems(initialItems);
    setSelected(new Set());
  }

  const { ref: scrollRef, scrollable } = useScrollFade<HTMLDivElement>();
  const allSelected = items.length > 0 && selected.size === items.length;

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)));
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function bulk(status: "visible" | "hidden" | "deleted", label: string) {
    if (selected.size === 0) return;
    setBulkPending(true);
    try {
      await adminApi.bulkUpdateComments([...selected], status);
      toast.success(label);
      setSelected(new Set());
      router.refresh();
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Xatolik yuz berdi");
    } finally {
      setBulkPending(false);
    }
  }

  if (items.length === 0) {
    return <EmptyState icon={MessageCircle} message="Bu bo'limda hali fikrlar yo'q." />;
  }

  const bulkBar = (
    <>
      <span className="font-medium">{selected.size} ta tanlandi</span>
      <Button size="sm" variant="outline" disabled={bulkPending} onClick={() => void bulk("visible", "Tasdiqlandi")}>
        Tasdiqlash
      </Button>
      <Button size="sm" variant="outline" disabled={bulkPending} onClick={() => void bulk("hidden", "Yashirildi")}>
        Yashirish
      </Button>
      <Button size="sm" variant="destructive" disabled={bulkPending} onClick={() => void bulk("deleted", "O'chirildi")}>
        O&apos;chirish
      </Button>
    </>
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Desktop bulk-tanlov paneli — jadval ustida */}
      {selected.size > 0 ? (
        <div className="hidden flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm md:flex">
          {bulkBar}
        </div>
      ) : null}

      {/* Mobil kartalar */}
      <div className="flex flex-col gap-2 md:hidden">
        {items.length > 1 ? (
          <label className="flex min-h-11 items-center gap-2 px-1 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              aria-label="Barchasini tanlash"
              className="size-4 accent-foreground"
            />
            Barchasini tanlash
          </label>
        ) : null}
        {items.map((item) => (
          <div key={item.id} className="flex gap-3 rounded-lg border border-border p-3">
            <input
              type="checkbox"
              checked={selected.has(item.id)}
              onChange={() => toggleOne(item.id)}
              aria-label={`${item.authorName} fikrini tanlash`}
              className="mt-1 size-4 shrink-0 accent-foreground"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{item.authorName}</span>
                  {item.authorIsAdmin ? (
                    <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-[0.6rem]">
                      Admin
                    </Badge>
                  ) : null}
                  <SourceBadge comment={item} />
                </div>
                <CommentRowActions comment={item} />
              </div>
              <p className="text-xs text-muted-foreground">{formatRelativeTime(item.createdAt)}</p>
              <p className="line-clamp-2 text-sm">{excerpt(item.bodyHtml, 160)}</p>
              <a
                href={`${site.url}/${item.postSlug}`}
                target="_blank"
                rel="noopener noreferrer"
                className="line-clamp-1 text-xs text-primary underline underline-offset-2"
              >
                {item.postTitle}
              </a>
              <div className="flex flex-wrap items-center gap-2.5 pt-0.5">
                <Badge variant={STATUS_VARIANT[item.status]}>{STATUS_LABEL[item.status]}</Badge>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <ThumbsUp className="size-3.5" /> {item.likes}
                </span>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <ThumbsDown className="size-3.5" /> {item.dislikes}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Mobil sticky bulk-panel — pastki navigatsiya ustida */}
      {selected.size > 0 ? (
        <div
          className="fixed inset-x-3 z-30 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm shadow-lg md:hidden"
          style={{ bottom: "calc(4rem + env(safe-area-inset-bottom))" }}
        >
          {bulkBar}
        </div>
      ) : null}

      {/* Desktop jadval */}
      <div className="relative hidden md:block">
        <div ref={scrollRef} className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    aria-label="Barchasini tanlash"
                    className="size-4 accent-foreground"
                  />
                </TableHead>
                <TableHead>Muallif</TableHead>
                <TableHead className="min-w-[220px]">Fikr</TableHead>
                <TableHead className="min-w-[140px]">Post</TableHead>
                <TableHead>Vaqt</TableHead>
                <TableHead>Holat</TableHead>
                <TableHead>👍/👎</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <input
                      type="checkbox"
                      checked={selected.has(item.id)}
                      onChange={() => toggleOne(item.id)}
                      aria-label={`${item.authorName} fikrini tanlash`}
                      className="size-4 accent-foreground"
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{item.authorName}</span>
                      {item.authorIsAdmin ? (
                        <Badge variant="secondary" className="h-4 px-1.5 text-[0.6rem]">
                          Admin
                        </Badge>
                      ) : null}
                      <SourceBadge comment={item} />
                    </div>
                    {item.ipHashShort ? (
                      <span className="font-mono text-[0.65rem] text-muted-foreground">{item.ipHashShort}…</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-80 truncate text-sm" title={stripHtml(item.bodyHtml)}>
                    {excerpt(item.bodyHtml)}
                  </TableCell>
                  <TableCell>
                    <a
                      href={`${site.url}/${item.postSlug}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={item.postTitle}
                      className="block max-w-40 truncate text-sm hover:underline"
                    >
                      {item.postTitle}
                    </a>
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                    {formatDateTime(item.createdAt)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[item.status]}>{STATUS_LABEL[item.status]}</Badge>
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                    {item.likes} / {item.dislikes}
                  </TableCell>
                  <TableCell>
                    <CommentRowActions comment={item} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {scrollable ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 w-10 rounded-r-lg bg-gradient-to-l from-background to-transparent"
          />
        ) : null}
      </div>
    </div>
  );
}

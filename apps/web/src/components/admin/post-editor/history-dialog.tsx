"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, History, Loader2, ScrollText, Undo2 } from "lucide-react";
import { toast } from "sonner";
import type { AdminPostDetail, AdminPostStatus, PostRevision, PostRevisionListItem } from "@blog/shared";
import { ViaBadge } from "@/components/admin/via-badge";
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
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { AdminApiError, adminApi } from "@/lib/admin-client";
import { actorName, isAutomatedVia, revisionReasonLabel } from "@/lib/admin-labels";
import { changedFields, REVISION_FIELD_LABELS, type RevisionField } from "@/lib/editor/revision-diff";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PostStatusBadge } from "@/components/admin/post-status-badge";
import { RevisionContent } from "./revision-preview";

/** Chop etilgan/rejalashtirilgan postda eski slug'ni qaytarish jonli havolani buzadi — standart: joriy slug saqlanadi. */
export function slugIsLive(status: AdminPostStatus): boolean {
  return status === "published" || status === "scheduled";
}

export function RevisionRow({
  item,
  selected,
  onSelect,
}: {
  item: PostRevisionListItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const automated = isAutomatedVia(item.via);
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        data-testid="revision-row"
        data-via={item.via}
        className={cn(
          "flex w-full flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors max-md:min-h-11",
          selected ? "border-foreground/40 bg-muted" : "border-border hover:bg-muted/60",
          // Oxirida: `border-border` yon chegara rangini ham bosib ketmasin (tailwind-merge tartibi).
          automated && "border-l-4 border-l-violet-500/60",
        )}
      >
        <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{formatDateTime(item.createdAt)}</span>
          <ViaBadge via={item.via} />
        </span>
        <span className="text-xs text-muted-foreground">
          {actorName(item.createdBy, item.via)} · {revisionReasonLabel(item.reason)}
        </span>
        <span className="line-clamp-1 text-xs text-muted-foreground" title={item.title}>
          {item.title}
        </span>
      </button>
    </li>
  );
}

export function RevisionDetail({
  revision,
  current,
  postStatus,
}: {
  revision: PostRevision;
  current: AdminPostDetail | null;
  postStatus: AdminPostStatus;
}) {
  const diff: RevisionField[] | null = useMemo(
    () =>
      current
        ? changedFields(revision, {
            title: current.title,
            slug: current.slug,
            excerpt: current.excerpt,
            coverUrl: current.coverUrl,
            tagSlugs: current.tags.map((tag) => tag.slug),
            contentJson: current.contentJson,
            settings: current.settings as unknown as Record<string, unknown>,
          })
        : null,
    [revision, current],
  );
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className="font-medium">{formatDateTime(revision.createdAt)}</span>
          <ViaBadge via={revision.via} />
          <PostStatusBadge status={revision.status} />
        </div>
        <p className="text-xs text-muted-foreground">
          {actorName(revision.createdBy, revision.via)} · {revisionReasonLabel(revision.reason)}
        </p>
        <div className="text-xs" data-testid="revision-diff">
          {diff === null ? (
            <span className="text-muted-foreground">Joriy versiya bilan solishtirib bo&apos;lmadi.</span>
          ) : diff.length === 0 ? (
            <span className="text-muted-foreground">Joriy versiyadan farq yo&apos;q.</span>
          ) : (
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground">Joriy versiyadan farqi:</span>
              {diff.map((field) => (
                <span key={field} className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-800 dark:text-amber-300">
                  {REVISION_FIELD_LABELS[field]}
                </span>
              ))}
            </span>
          )}
        </div>
        {slugIsLive(postStatus) && current && revision.slug !== current.slug ? (
          <p className="text-xs text-muted-foreground">
            Bu versiyada havola boshqacha: <span className="font-mono">/{revision.slug}</span>
          </p>
        ) : null}
      </div>

      <article className="flex min-w-0 flex-col gap-3" aria-label="Versiya ko'rinishi">
        <h3 className="text-xl font-semibold tracking-tight text-balance break-words">{revision.title}</h3>
        {revision.excerpt ? <p className="text-sm text-muted-foreground break-words">{revision.excerpt}</p> : null}
        {revision.tagSlugs.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {revision.tagSlugs.map((slug) => (
              <span key={slug} className="rounded-full border border-border px-1.5 py-0.5 text-[0.65rem] text-muted-foreground">
                {slug}
              </span>
            ))}
          </div>
        ) : null}
        {revision.coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- CMS kontenti
          <img src={revision.coverUrl} alt="" className="max-h-56 w-full rounded-lg object-cover" />
        ) : null}
        <RevisionContent key={revision.id} contentJson={revision.contentJson} />
      </article>
    </div>
  );
}

/**
 * "Tarix": postning avvalgi versiyalari ro'yxati + tanlangan versiyaning o'qish-uchun ko'rinishi + "Shu versiyaga qaytarish".
 * Qaytarishning o'zi (avval kutayotgan matnni saqlash, tokenli so'rov, tahrirlagichni yangilash) `onRestore`da — chaqiruvchida.
 */
export function HistoryDialog({
  open,
  onOpenChange,
  ...panel
}: {
  postId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  postStatus: AdminPostStatus;
  /** Tiklash ruxsati (xodim faqat o'z qoralamasida; o'qish-uchun rejimda yo'q). */
  canRestore: boolean;
  /** Admin: "Shu postning jurnali" havolasi. */
  showJournalLink?: boolean;
  onRestore: (revisionId: string, opts: { restoreSlug: boolean }) => Promise<boolean>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[92svh] w-full max-w-[calc(100%-1rem)] flex-col gap-3 overflow-hidden p-4 sm:max-w-5xl"
        data-testid="history-dialog"
      >
        {/* Panel faqat ochiq paytda o'rnatiladi — har ochilishda toza holat va yangi ro'yxat. */}
        <HistoryPanel {...panel} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function HistoryPanel({
  postId,
  onClose,
  postStatus,
  canRestore,
  showJournalLink = false,
  onRestore,
}: {
  postId: string;
  onClose: () => void;
  postStatus: AdminPostStatus;
  /** Tiklash ruxsati (xodim faqat o'z qoralamasida; o'qish-uchun rejimda yo'q). */
  canRestore: boolean;
  /** Admin: "Shu postning jurnali" havolasi. */
  showJournalLink?: boolean;
  onRestore: (revisionId: string, opts: { restoreSlug: boolean }) => Promise<boolean>;
}) {
  const [items, setItems] = useState<PostRevisionListItem[] | null>(null);
  const [current, setCurrent] = useState<AdminPostDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, PostRevision>>({});
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restoreSlug, setRestoreSlug] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [mobileDetail, setMobileDetail] = useState(false);
  const requestRef = useRef(0);
  const detailsRef = useRef<Record<string, PostRevision>>({});

  const select = useCallback(
    async (id: string, opts: { showDetail?: boolean } = {}) => {
      setSelectedId(id);
      setMobileDetail(opts.showDetail ?? true);
      setRestoreSlug(false);
      setDetailError(null);
      if (detailsRef.current[id]) return;
      const ticket = ++requestRef.current;
      setLoadingDetail(true);
      try {
        const revision = await adminApi.getRevision(postId, id);
        detailsRef.current = { ...detailsRef.current, [id]: revision };
        setDetails(detailsRef.current);
      } catch (e) {
        if (ticket === requestRef.current) setDetailError(e instanceof AdminApiError ? e.message : "Versiyani yuklab bo'lmadi");
      } finally {
        if (ticket === requestRef.current) setLoadingDetail(false);
      }
    },
    [postId],
  );

  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([adminApi.listRevisions(postId), adminApi.getPost(postId).catch(() => null)])
      .then(([list, post]) => {
        if (cancelled) return;
        setItems(list.items);
        setCurrent(post);
        // Katta ekranda eng yangisi avtomatik tanlanadi (o'ng panel bo'sh turmasin); telefonda ro'yxat ko'rinib turadi.
        const first = list.items[0];
        if (first && window.matchMedia("(min-width: 768px)").matches) void select(first.id, { showDetail: false });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof AdminApiError ? e.message : "Tarixni yuklab bo'lmadi");
      });
    return () => {
      cancelled = true;
    };
  }, [postId, select, reloadTick]);

  const selected = selectedId ? details[selectedId] : undefined;
  const slugDiffers = !!selected && !!current && slugIsLive(postStatus) && selected.slug !== current.slug;

  async function confirmRestore() {
    if (!selectedId) return;
    setRestoring(true);
    try {
      const done = await onRestore(selectedId, { restoreSlug: slugDiffers && restoreSlug });
      if (done) {
        setConfirmOpen(false);
        onClose();
      }
    } catch (e) {
      toast.error(e instanceof AdminApiError ? e.message : "Qaytarib bo'lmadi");
    } finally {
      setRestoring(false);
    }
  }

  return (
    <>
      <>
        <>
          <DialogHeader className="pr-10">
            <DialogTitle className="flex items-center gap-2 text-base">
              <History className="size-4" aria-hidden="true" />
              Tarix
            </DialogTitle>
            <DialogDescription>
              Postning avvalgi versiyalari. Tanlang, ko&apos;rib chiqing va kerak bo&apos;lsa shu versiyaga qayting.
            </DialogDescription>
            {showJournalLink ? (
              <Link
                href={`/admin/jurnal?entityType=post&entityId=${postId}`}
                className="inline-flex w-fit items-center gap-1.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline max-md:min-h-11"
              >
                <ScrollText className="size-3.5" aria-hidden="true" />
                Shu postning jurnali
              </Link>
            ) : null}
          </DialogHeader>

          {error ? (
            <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border p-4 text-sm">
              <p className="text-destructive">{error}</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setError(null);
                  setReloadTick((tick) => tick + 1);
                }}
              >
                Qayta urinish
              </Button>
            </div>
          ) : items === null ? (
            <div className="flex flex-col gap-2" aria-busy="true">
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-16 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-10 text-center">
              <History className="size-8 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">Hali avvalgi versiyalar yo&apos;q. Post tahrirlangach bu yerda paydo bo&apos;ladi.</p>
            </div>
          ) : (
            <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[18rem_1fr]">
              <div className={cn("min-h-0 overflow-y-auto pr-1", mobileDetail && "max-md:hidden")}>
                <ul className="flex flex-col gap-1.5" aria-label="Versiyalar ro'yxati">
                  {items.map((item) => (
                    <RevisionRow key={item.id} item={item} selected={item.id === selectedId} onSelect={() => void select(item.id)} />
                  ))}
                </ul>
              </div>
              <div className={cn("flex min-h-0 min-w-0 flex-col gap-3", !mobileDetail && "max-md:hidden")}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-fit md:hidden max-md:h-11"
                  onClick={() => setMobileDetail(false)}
                >
                  <ArrowLeft className="size-4" />
                  Versiyalar
                </Button>
                <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                  {!selectedId ? (
                    <p className="p-6 text-center text-sm text-muted-foreground">Ko&apos;rish uchun versiyani tanlang.</p>
                  ) : detailError ? (
                    <div className="flex flex-col items-start gap-2 text-sm">
                      <p className="text-destructive">{detailError}</p>
                      <Button size="sm" variant="outline" onClick={() => void select(selectedId)}>
                        Qayta urinish
                      </Button>
                    </div>
                  ) : selected ? (
                    <RevisionDetail revision={selected} current={current} postStatus={postStatus} />
                  ) : loadingDetail ? (
                    <div className="flex flex-col gap-2" aria-busy="true">
                      <Skeleton className="h-16 w-full" />
                      <Skeleton className="h-40 w-full" />
                    </div>
                  ) : null}
                </div>
                {selected && canRestore ? (
                  <div className="flex flex-col gap-2 border-t border-border pt-3">
                    {slugDiffers ? (
                      <label className="flex cursor-pointer items-start gap-2 text-xs max-md:min-h-11">
                        <input
                          type="checkbox"
                          className="mt-0.5 size-4"
                          checked={restoreSlug}
                          onChange={(event) => setRestoreSlug(event.target.checked)}
                          data-testid="restore-slug"
                        />
                        <span>
                          Havolani ham qaytarish (<span className="font-mono">/{selected.slug}</span>)
                          <span className="block text-amber-700 dark:text-amber-400">
                            Diqqat: post hozir saytda joriy havola (<span className="font-mono">/{current?.slug}</span>) bilan ochiladi —
                            uni o&apos;zgartirsangiz, eski havolalar ishlamay qoladi. Belgilanmasa, havola o&apos;zgarmaydi.
                          </span>
                        </span>
                      </label>
                    ) : null}
                    <Button className="w-fit max-md:h-11" onClick={() => setConfirmOpen(true)} data-testid="restore-revision">
                      <Undo2 className="size-4" />
                      Shu versiyaga qaytarish
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </>
      </>

      <AlertDialog open={confirmOpen} onOpenChange={(next) => (restoring ? undefined : setConfirmOpen(next))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Shu versiyaga qaytarilsinmi?</AlertDialogTitle>
            <AlertDialogDescription>
              Postning hozirgi holati avval Tarixga saqlanadi — shuning uchun bu amalni ham qaytarib olish mumkin.
              {slugDiffers
                ? restoreSlug
                  ? ` Havola /${selected?.slug} ga o'zgaradi — eski havolalar ishlamay qoladi.`
                  : ` Havola o'zgarmaydi (/${current?.slug}).`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoring} className="max-sm:h-11">
              Bekor qilish
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={restoring}
              className="max-sm:h-11"
              onClick={(event) => {
                event.preventDefault();
                void confirmRestore();
              }}
            >
              {restoring ? <Loader2 className="size-4 animate-spin" /> : null}
              Qaytarish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

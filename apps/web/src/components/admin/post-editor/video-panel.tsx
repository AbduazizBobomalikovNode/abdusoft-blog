"use client";

import { useCallback, useEffect, useState } from "react";
import { Clapperboard, Copy, Download, Loader2, Star, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";
import type { MotionJob, MotionJobDetail, PostMainVideo } from "@blog/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AdminApiError, adminApi } from "@/lib/admin-client";
import { useVideoEnabled } from "@/components/admin/video-context";
import { formatDateTime } from "@/lib/format";
import { formatBytes, isActiveJob, JOB_KIND_LABEL, JOB_STATUS_LABEL, jobErrorText } from "@/lib/video-labels";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<MotionJob["status"], string> = {
  queued: "bg-muted text-muted-foreground",
  running: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  ready: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  failed: "bg-destructive/15 text-destructive",
  cancelled: "bg-muted text-muted-foreground",
};

/** Amal allaqachon boshqa joyda (konflikt oynasi) ko'rsatilgan: toast chiqarilmaydi. */
class HandledElsewhere extends Error {}

export type MainVideoControl = {
  /** Hozirgi asosiy video ishi (`null` — yo'q). */
  jobId: string | null;
  /** `true` — saqlandi; `false` — konflikt sifatida muharrir o'zi ko'rsatdi. Boshqa xatolar tashlanadi. */
  set: (jobId: string | null, video?: PostMainVideo) => Promise<boolean>;
};

/** Tayyor render ishidan asosiy video kartasi uchun ma'lumot (mp4 + birinchi ko'rik kadri); mp4 yo'q bo'lsa `null`. */
export function mainVideoFromJob(job: MotionJob): PostMainVideo | null {
  const mp4 = job.assets.find((a) => a.kind === "mp4");
  if (!mp4) return null;
  const still = job.assets.find((a) => a.kind === "still");
  return {
    jobId: job.id,
    url: mp4.url,
    posterUrl: still?.url ?? null,
    width: mp4.width && mp4.width > 0 ? Math.round(mp4.width) : 1280,
    height: mp4.height && mp4.height > 0 ? Math.round(mp4.height) : 720,
    seconds: mp4.seconds ?? job.durationSeconds,
    mime: "video/mp4",
  };
}

function JobCard({ job, onChanged, mainVideo }: { job: MotionJob; onChanged: () => void; mainVideo?: MainVideoControl }) {
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<MotionJobDetail | null>(null);
  const [showJson, setShowJson] = useState(false);
  const files = job.assets.filter((a) => a.kind !== "still");
  const stills = job.assets.filter((a) => a.kind === "still");

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await action();
      toast.success(done);
      onChanged();
    } catch (error) {
      if (!(error instanceof HandledElsewhere)) toast.error(error instanceof AdminApiError ? error.message : "Amal bajarilmadi");
    } finally {
      setBusy(false);
    }
  }

  const canBeMain = mainVideo !== undefined && job.kind === "render" && job.status === "ready" && job.assets.some((a) => a.kind === "mp4");
  const isMain = mainVideo !== undefined && mainVideo.jobId === job.id;
  const toggleMain = (next: string | null, done: string) =>
    run(async () => {
      if (!(await mainVideo!.set(next, next ? (mainVideoFromJob(job) ?? undefined) : undefined))) throw new HandledElsewhere();
    }, done);

  async function toggleJson() {
    if (!showJson && !detail) {
      try {
        setDetail(await adminApi.getVideoJob(job.id));
      } catch {
        toast.error("Storyboard'ni yuklab bo'lmadi");
        return;
      }
    }
    setShowJson((v) => !v);
  }

  return (
    <li className="flex flex-col gap-2 rounded-lg border p-3" data-testid="video-job" data-status={job.status}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{job.title ?? JOB_KIND_LABEL[job.kind]}</span>
          <span className="text-xs text-muted-foreground">
            {JOB_KIND_LABEL[job.kind]} · {job.durationSeconds.toFixed(0)} s · {formatDateTime(job.createdAt)} · {job.via === "mcp" ? (job.clientName ?? "Claude") : "panel"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isMain ? <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground" data-testid="main-video-badge">Asosiy video</span> : null}
          <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", STATUS_TONE[job.status])}>
            {JOB_STATUS_LABEL[job.status]}
            {job.status === "queued" && job.queuePosition ? ` (${job.queuePosition})` : ""}
          </span>
        </div>
      </div>

      {job.status === "running" ? (
        <div className="flex flex-col gap-1" role="progressbar" aria-valuenow={job.progress} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-sky-500 transition-all" style={{ width: `${job.progress}%` }} />
          </div>
          <span className="text-xs text-muted-foreground">
            {job.progress}% {job.message ? `· ${job.message}` : ""}
          </span>
        </div>
      ) : null}

      {job.status === "failed" || job.status === "cancelled" ? <p className="text-sm text-destructive">{job.status === "failed" ? jobErrorText(job) : "Bekor qilindi."}</p> : null}

      {stills.length > 0 ? (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {stills.map((s) => (
            // eslint-disable-next-line @next/next/no-img-element -- server tomonida allaqachon kichraytirilgan ko'rik kadrlari
            <img key={s.id} src={s.url} alt={`Ko'rik: ${s.sceneIndex !== null ? s.sceneIndex + 1 : ""}-sahna`} className="h-20 w-auto shrink-0 rounded border" loading="lazy" />
          ))}
        </div>
      ) : null}

      {files.map((f) => (
        <div key={f.id} className="flex flex-wrap items-center gap-2">
          {f.kind === "mp4" ? <video src={f.url} controls preload="metadata" className="max-h-48 rounded border" /> : null}
          {/* eslint-disable-next-line @next/next/no-img-element -- GIF ko'rinishi */}
          {f.kind === "gif" ? <img src={f.url} alt="GIF" className="max-h-32 rounded border" /> : null}
          <span className="text-xs text-muted-foreground">{formatBytes(f.size)}</span>
          <Button asChild size="sm" variant="outline" className="max-md:h-11">
            <a href={f.url} download target="_blank" rel="noopener noreferrer">
              <Download className="size-4" /> Yuklab olish
            </a>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="max-md:h-11"
            onClick={() => void navigator.clipboard.writeText(f.url).then(() => toast.success("Havola nusxalandi"), () => toast.error("Nusxalab bo'lmadi"))}
          >
            <Copy className="size-4" /> Havolani nusxalash
          </Button>
        </div>
      ))}

      <div className="flex flex-wrap gap-2">
        {canBeMain ? (
          isMain ? (
            <Button size="sm" variant="outline" className="max-md:h-11" disabled={busy} data-testid="main-video-clear" onClick={() => void toggleMain(null, "Asosiy video olib tashlandi")}>
              Asosiy videodan olib tashlash
            </Button>
          ) : (
            <Button size="sm" variant="outline" className="max-md:h-11" disabled={busy} data-testid="main-video-set" onClick={() => void toggleMain(job.id, "Asosiy video o'rnatildi")}>
              <Star className="size-4" /> Asosiy video qilish
            </Button>
          )
        ) : null}
        {isActiveJob(job) ? (
          <Button size="sm" variant="outline" className="max-md:h-11" disabled={busy} onClick={() => void run(() => adminApi.cancelVideoJob(job.id), "Bekor qilindi")}>
            <XCircle className="size-4" /> Bekor qilish
          </Button>
        ) : (
          <Button size="sm" variant="ghost" className="max-md:h-11 text-destructive" disabled={busy} onClick={() => void run(() => adminApi.deleteVideoJob(job.id), "O'chirildi")}>
            <Trash2 className="size-4" /> O&apos;chirish
          </Button>
        )}
        <Button size="sm" variant="ghost" className="max-md:h-11" onClick={() => void toggleJson()}>
          {showJson ? "Storyboard'ni yashirish" : "Storyboard JSON"}
        </Button>
      </div>
      {showJson && detail ? <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(detail.storyboard, null, 2)}</pre> : null}
    </li>
  );
}

/** Postdagi video ishlari: holat, ko'rik kadrlari, yuklab olish/havola, asosiy video qilish, bekor qilish va o'chirish. Storyboard'ni yordamchi (Claude) yozadi. */
export function VideoPanel({
  postId,
  mainVideo,
  open: openProp,
  onOpenChange,
}: {
  postId: string;
  mainVideo?: MainVideoControl;
  /** Ixtiyoriy: dialog holatini tashqaridan boshqarish (berilmasa o'zi boshqaradi). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  // Yoqilganmi: `/admin/me` (`videoEnabled`) bo'yicha — alohida so'rov yo'q.
  const enabled = useVideoEnabled();
  const [innerOpen, setInnerOpen] = useState(false);
  const open = openProp ?? innerOpen;
  const setOpen = (next: boolean) => {
    setInnerOpen(next);
    onOpenChange?.(next);
  };
  const [jobs, setJobs] = useState<MotionJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    adminApi.listVideoJobs(postId).then(
      (r) => {
        if (!alive) return;
        setJobs(r.items);
        setError(null);
      },
      (e: unknown) => alive && setError(e instanceof AdminApiError ? e.message : "Yuklab bo'lmadi"),
    );
    return () => {
      alive = false;
    };
  }, [open, postId, tick]);

  const anyActive = jobs?.some(isActiveJob) ?? false;
  useEffect(() => {
    if (!open || !anyActive) return;
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
  }, [open, anyActive, reload]);

  if (!enabled) return null;
  return (
    <>
      <Button type="button" variant="outline" size="sm" className="w-fit max-md:h-11" onClick={() => setOpen(true)} data-testid="open-video">
        <Clapperboard className="size-4" /> Video
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Video</DialogTitle>
            <DialogDescription>Bu postning video ishlari. Storyboard&apos;ni yordamchi (Claude) yozadi va ishni boshlaydi; bu yerda natijani ko&apos;rasiz va boshqarasiz.</DialogDescription>
          </DialogHeader>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {jobs === null && !error ? <Loader2 className="size-5 animate-spin" aria-label="Yuklanmoqda" /> : null}
          {jobs?.length === 0 ? <p className="text-sm text-muted-foreground">Hali video yo&apos;q. Yordamchidan shu post uchun qisqa tushuntirish videosi tayyorlashni so&apos;rang.</p> : null}
          <ul className="flex flex-col gap-3">
            {jobs?.map((j) => (
              <JobCard key={j.id} job={j} onChanged={reload} {...(mainVideo ? { mainVideo } : {})} />
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}

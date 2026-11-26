"use client";

import { useCallback, useEffect, useState } from "react";
import { Clapperboard, Copy, Download, Loader2, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";
import type { MotionJob, MotionJobDetail } from "@blog/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AdminApiError, adminApi } from "@/lib/admin-client";
import { formatDateTime } from "@/lib/format";
import { formatBytes, isActiveJob, JOB_KIND_LABEL, JOB_STATUS_LABEL, jobErrorText } from "@/lib/video-labels";
import { cn } from "@/lib/utils";

/** Bayroq o'chiq bo'lsa server 404 qaytaradi: shu holda UI umuman ko'rinmaydi (kirish nuqtasi ham yo'q). */
let enabledProbe: Promise<boolean> | null = null;
function probeEnabled(): Promise<boolean> {
  enabledProbe ??= adminApi.getVideoStatus().then(
    () => true,
    () => false,
  );
  return enabledProbe;
}

const STATUS_TONE: Record<MotionJob["status"], string> = {
  queued: "bg-muted text-muted-foreground",
  running: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  ready: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  failed: "bg-destructive/15 text-destructive",
  cancelled: "bg-muted text-muted-foreground",
};

function JobCard({ job, onChanged }: { job: MotionJob; onChanged: () => void }) {
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
      toast.error(error instanceof AdminApiError ? error.message : "Amal bajarilmadi");
    } finally {
      setBusy(false);
    }
  }

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
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", STATUS_TONE[job.status])}>
          {JOB_STATUS_LABEL[job.status]}
          {job.status === "queued" && job.queuePosition ? ` (${job.queuePosition})` : ""}
        </span>
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

/** Postdagi video ishlari: holat, ko'rik kadrlari, yuklab olish/havola, bekor qilish va o'chirish. Storyboard'ni yordamchi (Claude) yozadi. */
export function VideoPanel({ postId }: { postId: string }) {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<MotionJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void probeEnabled().then((v) => alive && setEnabled(v));
    return () => {
      alive = false;
    };
  }, []);

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
              <JobCard key={j.id} job={j} onChanged={reload} />
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}

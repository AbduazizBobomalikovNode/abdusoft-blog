"use client";

import { useEffect, useState } from "react";
import type { MotionGithubSettings, MotionStatus } from "@blog/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AdminApiError, adminApi } from "@/lib/admin-client";
import { useVideoEnabled } from "@/components/admin/video-context";
import { formatDateTime } from "@/lib/format";
import { toast } from "sonner";

/** GitHub runner uchun token va repozitoriy (token shifrlangan saqlanadi, qaytmaydi; maska ko'rinadi). */
function GithubForm({ settings, onSaved }: { settings: MotionGithubSettings; onSaved: (s: MotionGithubSettings) => void }) {
  const [token, setToken] = useState("");
  const [repo, setRepo] = useState(settings.repo.value);
  const [workflow, setWorkflow] = useState(settings.workflow.value);
  const [ref, setRef] = useState(settings.ref.value);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const next = await adminApi.saveVideoSettings({ ...(token ? { githubToken: token } : {}), githubRepo: repo, githubWorkflow: workflow, githubRef: ref });
      setToken("");
      onSaved(next);
      toast.success("Saqlandi");
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Saqlab bo'lmadi");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-3 flex flex-col gap-2" data-testid="video-github-form">
      <label className="flex flex-col gap-1 text-xs">
        Render repozitoriysi (egasi/nomi; blogning o&apos;zi emas)
        <Input value={repo} onChange={(e) => setRepo(e.target.value)} disabled={settings.repo.source === "env"} placeholder="egasi/abdusoft-blog-render" autoComplete="off" />
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs">
          Workflow fayli (default {settings.workflow.default})
          <Input value={workflow} onChange={(e) => setWorkflow(e.target.value)} disabled={settings.workflow.source === "env"} placeholder={settings.workflow.default} autoComplete="off" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Shox (default {settings.ref.default})
          <Input value={ref} onChange={(e) => setRef(e.target.value)} disabled={settings.ref.source === "env"} placeholder={settings.ref.default} autoComplete="off" />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs">
        GitHub token (fine-grained, FAQAT render repozitoriysi, Actions: Read and write) {settings.token.isSet ? `— saqlangan: ${settings.token.masked}` : ""}
        <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} disabled={settings.token.source === "env"} placeholder={settings.token.isSet ? "o'zgartirish uchun yangisini kiriting" : "github_pat_…"} autoComplete="off" />
      </label>
      {settings.problem ? <p className="text-xs text-destructive" data-testid="video-github-problem">{settings.problem}</p> : null}
      {settings.token.unreadable ? <p className="text-xs text-destructive">Saqlangan token o&apos;qib bo&apos;lmadi (maxfiy kalit o&apos;zgargan) — qaytadan kiriting.</p> : null}
      <Button type="button" size="sm" className="w-fit max-md:h-11" disabled={busy} onClick={() => void save()}>
        Saqlash
      </Button>
    </div>
  );
}

/** Sozlamalarda video xizmati holati: backend, nima sozlangan (qiymatlarsiz) va oxirgi muvaffaqiyatli run. Yoqilmagan bo'lsa (`/admin/me`) hech narsa va hech qanday so'rov yo'q. */
export function VideoStatusLine() {
  const enabled = useVideoEnabled();
  const [status, setStatus] = useState<MotionStatus | null>(null);
  const [settings, setSettings] = useState<MotionGithubSettings | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    adminApi.getVideoStatus().then(
      (s) => alive && setStatus(s),
      () => undefined,
    );
    adminApi.getVideoSettings().then(
      (s) => alive && setSettings(s),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [enabled]);
  if (!enabled || !status) return null;
  const gh = status.github;
  return (
    <div className="rounded-lg border p-3 text-sm" data-testid="video-status-line" role="status">
      <p>
        <span className="font-medium">Video xizmati: yoqilgan ({status.runner === "github" ? "GitHub Actions runner" : "serverda mahalliy ishchi"}).</span>{" "}
        {gh ? (
          <>
            Token: {gh.tokenConfigured ? "bor" : <span className="text-destructive">yo&apos;q</span>}, runner siri: {gh.secretConfigured ? "bor" : <span className="text-destructive">yo&apos;q</span>}, repozitoriy:{" "}
            {gh.repoConfigured ? gh.repo : <span className="text-destructive">yo&apos;q</span>}. Workflow: {gh.workflow}@{gh.ref}. Oxirgi muvaffaqiyatli run: {gh.lastSuccessAt ? formatDateTime(gh.lastSuccessAt) : "hali yo'q"}.
            {gh.problem ? <span className="text-destructive" data-testid="video-status-problem"> {gh.problem}</span> : null}
          </>
        ) : status.local ? (
          status.local.preflightOk ? (
            "Mahalliy tekshiruv o'tgan."
          ) : (
            <span className="text-destructive">Mahalliy tekshiruv o&apos;tmagan — egasi scripts/setup-motion-browser.sh ni ishga tushirishi kerak.</span>
          )
        ) : null}{" "}
        <span className="text-muted-foreground">
          Navbat: {status.queue.running} ishlayapti, {status.queue.queued} kutmoqda. Bugun: {status.quotas.rendersToday}/{status.quotas.maxRendersPerDay || "∞"} video, {status.quotas.previewsToday}/{status.quotas.maxPreviewsPerDay || "∞"} ko&apos;rik.
        </span>
      </p>
      {status.runner === "github" && settings ? <GithubForm settings={settings} onSaved={(s) => { setSettings(s); void adminApi.getVideoStatus().then(setStatus, () => undefined); }} /> : null}
    </div>
  );
}

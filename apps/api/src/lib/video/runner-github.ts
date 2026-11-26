import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import { motionJobs } from "../../db/schema.js";
import { cancelWorkflowRun, dispatchWorkflow, getGithubConfig } from "./github.js";
import { failJob, jobTimeoutSeconds } from "./jobs.js";
import { runnerSecretConfigured } from "./runner-token.js";

type JobRow = typeof motionJobs.$inferSelect;

/** Time a claimed job may use on top of its render clock: bundle build, upload of the parts and finalisation. */
export const POST_CLAIM_GRACE_MS = 180_000;
export const MAX_DISPATCH_ATTEMPTS = 3;
const dispatchBackoffMs = (attempt: number): number => 5_000 * 2 ** attempt;

export async function githubReadiness(): Promise<{ ok: true } | { ok: false; code: string; hint: string }> {
  if (!runnerSecretConfigured()) {
    return { ok: false, code: "runner_not_configured", hint: "The owner must set VIDEO_RUNNER_SECRET (at least 32 random characters) in the API environment and as a secret of the GitHub environment 'video-render'. See docs/video.md." };
  }
  const c = await getGithubConfig();
  if (!c.token || !c.repo) {
    return { ok: false, code: "runner_not_configured", hint: "The owner must save a GitHub token and repository in the blog settings (Video) or set VIDEO_GITHUB_TOKEN and VIDEO_GITHUB_REPO. See docs/video.md." };
  }
  return { ok: true };
}

const dispatching = new Set<string>();

/** Test hook: replaces the GitHub call (the local end-to-end run launches the runner script here). */
type DispatchFn = (jobId: string) => Promise<{ ok: true; runId: string | null } | { ok: false; code: string; retryable: boolean; message: string }>;
let dispatchHook: DispatchFn | null = null;
export function setDispatchHookForTests(fn: typeof dispatchHook): void {
  dispatchHook = fn;
}

/** Sends the workflow dispatch for one running job and records the outcome. Safe to repeat: the runner's claim is single-use. */
export async function dispatchJob(row: JobRow, now: Date = new Date()): Promise<void> {
  if (dispatching.has(row.id)) return;
  dispatching.add(row.id);
  try {
    const send: DispatchFn = dispatchHook ?? dispatchWorkflow;
    const res = await send(row.id);
    if (res.ok) {
      const updated = await db
        .update(motionJobs)
        .set({ runnerDispatchedAt: now, runnerRunId: res.runId, phase: "waiting_runner", message: "waiting for a GitHub runner" })
        .where(and(eq(motionJobs.id, row.id), eq(motionJobs.status, "running"), isNull(motionJobs.runnerDispatchedAt)))
        .returning();
      // Cancelled/finished while the dispatch was in flight: stop the run that was just created.
      if (updated.length === 0 && res.runId) {
        const [cur] = await db.select({ status: motionJobs.status }).from(motionJobs).where(eq(motionJobs.id, row.id)).limit(1);
        if (!cur || cur.status !== "running") void cancelWorkflowRun(res.runId);
      }
      return;
    }
    if (res.retryable && row.dispatchAttempts + 1 < MAX_DISPATCH_ATTEMPTS) {
      await db
        .update(motionJobs)
        .set({ dispatchAttempts: row.dispatchAttempts + 1, dispatchAfter: new Date(now.getTime() + dispatchBackoffMs(row.dispatchAttempts)), message: "retrying the GitHub dispatch" })
        .where(and(eq(motionJobs.id, row.id), eq(motionJobs.status, "running")));
      return;
    }
    await failJob(row.id, res.code, res.message, {});
  } finally {
    dispatching.delete(row.id);
  }
}

export const renderTimeoutMsOf = (row: Pick<JobRow, "kind">): number => jobTimeoutSeconds(row.kind) * 1000;

/**
 * Watchdog for GitHub-backed jobs; pure in `now` so tests drive it with a fake clock.
 *  - dispatch missing (API restarted before it was sent, or a transient failure waiting for its retry) -> (re)dispatch;
 *  - dispatched but nobody claimed within VIDEO_RUNNER_START_TIMEOUT_SECONDS -> `runner_not_started`;
 *  - claimed but not completed within the render/preview timeout (+ grace for bundle, upload, finalisation) -> `runner_timeout`.
 * Both failures also ask GitHub to cancel the run (best effort).
 */
export async function superviseGithubJobs(now: Date = new Date()): Promise<{ redispatched: number; notStarted: number; timedOut: number }> {
  const out = { redispatched: 0, notStarted: 0, timedOut: 0 };
  const rows = await db
    .select()
    .from(motionJobs)
    .where(and(eq(motionJobs.status, "running"), eq(motionJobs.runner, "github")));
  const startMs = config.VIDEO_RUNNER_START_TIMEOUT_SECONDS * 1000;
  for (const row of rows) {
    if (row.runnerClaimedAt) {
      if (now.getTime() > row.runnerClaimedAt.getTime() + renderTimeoutMsOf(row) + POST_CLAIM_GRACE_MS) {
        if (await failJob(row.id, "runner_timeout", "The GitHub runner did not finish within the time limit and the run was cancelled.", {})) out.timedOut++;
        void cancelWorkflowRun(row.runnerRunId);
      }
      continue;
    }
    const since = row.runnerDispatchedAt ?? row.startedAt ?? row.createdAt;
    if (now.getTime() - since.getTime() > startMs) {
      const code = row.runnerDispatchedAt ? "runner_not_started" : "runner_unavailable";
      const msg = row.runnerDispatchedAt
        ? `No GitHub runner picked the job up within ${config.VIDEO_RUNNER_START_TIMEOUT_SECONDS} s (the queue of the repository may be full, Actions may be disabled, or the workflow/environment is not set up). The run was cancelled.`
        : "The workflow could not be dispatched in time.";
      if (await failJob(row.id, code, msg, {})) out.notStarted++;
      void cancelWorkflowRun(row.runnerRunId);
      continue;
    }
    if (!row.runnerDispatchedAt && !dispatching.has(row.id) && (!row.dispatchAfter || row.dispatchAfter.getTime() <= now.getTime())) {
      void dispatchJob(row, now);
      out.redispatched++;
    }
  }
  return out;
}

/** Claim queued jobs (atomic, up to VIDEO_MAX_RUNNING) and send their dispatch. */
export async function tickGithub(claimNext: (runner: "github") => Promise<JobRow | null>, now: Date = new Date()): Promise<void> {
  await superviseGithubJobs(now);
  const ready = await githubReadiness();
  if (!ready.ok) {
    // Nothing can start: jobs queued before the settings were removed must not wait forever.
    await db
      .update(motionJobs)
      .set({ status: "failed", errorCode: ready.code, errorMessage: ready.hint, finishedAt: new Date() })
      .where(and(eq(motionJobs.status, "queued"), sql`${motionJobs.createdAt} < ${new Date(now.getTime() - 60_000)}`));
    return;
  }
  for (let i = 0; i < config.VIDEO_MAX_RUNNING; i++) {
    const job = await claimNext("github");
    if (!job) return;
    void dispatchJob(job, now);
  }
}

export const activeGithubJobIds = async (): Promise<string[]> =>
  (await db.select({ id: motionJobs.id }).from(motionJobs).where(and(eq(motionJobs.runner, "github"), inArray(motionJobs.status, ["queued", "running"])))).map((r) => r.id);

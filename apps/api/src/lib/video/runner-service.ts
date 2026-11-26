import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import { motionJobs } from "../../db/schema.js";
import { failJob, jobTimeoutSeconds, phasePercent, previewWidthOf, storeAndFinalize, type JobOptions, type StagedFile } from "./jobs.js";
import { POST_CLAIM_GRACE_MS } from "./runner-github.js";
import { PART_BYTES, assembledPath, removeUploads, rulesFor, uploadDirOf } from "./uploads.js";
import { existsSync, statSync } from "node:fs";

type JobRow = typeof motionJobs.$inferSelect;

/** An answer the route turns into `{ code }` with this HTTP status. Never carries server paths or stack traces. */
export class RunnerError extends Error {
  readonly status: 401 | 404 | 409 | 410 | 422;
  readonly code: string;
  constructor(status: RunnerError["status"], code: string) {
    super(code);
    this.name = "RunnerError";
    this.status = status;
    this.code = code;
  }
}

export interface ClaimResponse {
  kind: "preview" | "render" | "gif";
  storyboard: unknown;
  options: JobOptions;
  timeoutSeconds: number;
  concurrency: number;
  partBytes: number;
  maxFiles: number;
  stillMaxBytes: number;
  videoName: string | null;
  videoMaxBytes: number;
}

async function loadJob(id: string): Promise<JobRow> {
  const [row] = await db.select().from(motionJobs).where(eq(motionJobs.id, id)).limit(1);
  if (!row || row.runner !== "github") throw new RunnerError(404, "job_not_found");
  return row;
}

/** Number of preview frames the runner may upload: `at` count, 4 for one scene, else one per scene (never more than 16). */
export function expectedStills(row: Pick<JobRow, "storyboard" | "options">): number {
  const o = row.options as JobOptions;
  if (o.at && o.at.length > 0) return o.at.length;
  if (o.scene !== undefined) return 4;
  const scenes = (row.storyboard as { scenes?: unknown } | null)?.scenes;
  return Array.isArray(scenes) ? scenes.length : 16;
}

export const rulesOfJob = (row: JobRow) => rulesFor(row.kind, row.kind === "preview" ? expectedStills(row) : 1);

/** A live job: running, not cancelled and still inside its deadline. */
export function assertLive(row: JobRow, now: Date = new Date()): void {
  if (row.status === "cancelled") throw new RunnerError(409, "job_cancelled");
  if (row.status !== "running") throw new RunnerError(409, "job_finished");
  if (row.runnerClaimedAt) {
    if (now.getTime() > row.runnerClaimedAt.getTime() + jobTimeoutSeconds(row.kind) * 1000 + POST_CLAIM_GRACE_MS) throw new RunnerError(410, "job_expired");
  } else if (now.getTime() > (row.runnerDispatchedAt ?? row.startedAt ?? row.createdAt).getTime() + config.VIDEO_RUNNER_START_TIMEOUT_SECONDS * 1000 + 60_000) {
    throw new RunnerError(410, "job_expired");
  }
}

export async function loadLiveClaimed(id: string, now: Date = new Date()): Promise<JobRow> {
  const row = await loadJob(id);
  assertLive(row, now);
  if (!row.runnerClaimedAt) throw new RunnerError(409, "not_claimed");
  return row;
}

function claimPayload(row: JobRow): ClaimResponse {
  const rules = rulesOfJob(row);
  const options = row.options as JobOptions;
  return {
    kind: row.kind,
    storyboard: row.storyboard,
    options: { ...options, ...(row.kind === "preview" ? { width: previewWidthOf(options) } : {}) },
    timeoutSeconds: jobTimeoutSeconds(row.kind),
    concurrency: config.VIDEO_RUNNER_CONCURRENCY,
    partBytes: PART_BYTES,
    maxFiles: rules.maxFiles,
    stillMaxBytes: config.VIDEO_MAX_STILL_BYTES,
    videoName: row.kind === "gif" ? "clip.gif" : row.kind === "render" ? "video.mp4" : null,
    videoMaxBytes: row.kind === "gif" ? config.VIDEO_MAX_GIF_BYTES : config.VIDEO_MAX_MP4_BYTES,
  };
}

export const ClaimBody = z.strictObject({ runId: z.string().regex(/^\d{1,20}$/), attempt: z.number().int().min(1).max(100) });

/** Single use: the first run to claim wins; a different run id (a duplicated dispatch) is refused; the SAME run may repeat it (lost response). */
export async function claim(id: string, body: z.infer<typeof ClaimBody>, now: Date = new Date()): Promise<ClaimResponse> {
  const row = await loadJob(id);
  assertLive(row, now);
  if (row.runnerClaimedAt) {
    if (row.runnerRunId === body.runId && row.runnerAttempt === body.attempt) return claimPayload(row);
    throw new RunnerError(409, "already_claimed");
  }
  const [claimed] = await db
    .update(motionJobs)
    .set({ runnerClaimedAt: now, runnerRunId: body.runId, runnerAttempt: body.attempt, phase: "starting", message: "the runner started" })
    .where(and(eq(motionJobs.id, id), eq(motionJobs.status, "running"), eq(motionJobs.runner, "github"), isNull(motionJobs.runnerClaimedAt)))
    .returning();
  if (!claimed) {
    const again = await loadJob(id);
    if (again.status !== "running") throw new RunnerError(409, again.status === "cancelled" ? "job_cancelled" : "job_finished");
    throw new RunnerError(409, "already_claimed");
  }
  return claimPayload(claimed);
}

export const ProgressBody = z.strictObject({ phase: z.string().min(1).max(30), fraction: z.number().min(0).max(1).nullable(), message: z.string().max(200) });

/** Updates the progress and returns whether the runner must stop (the job was cancelled). */
export async function progress(id: string, body: z.infer<typeof ProgressBody>, now: Date = new Date()): Promise<{ cancel: boolean }> {
  const row = await loadJob(id);
  if (row.status === "cancelled" || (row.status === "running" && row.cancelRequested)) return { cancel: true };
  assertLive(row, now);
  if (!row.runnerClaimedAt) throw new RunnerError(409, "not_claimed");
  await db
    .update(motionJobs)
    .set({ progress: phasePercent(body.phase, body.fraction), phase: body.phase.replace(/[^a-z_]/g, "").slice(0, 30) || null, message: body.message.replace(/[\u0000-\u001f]/g, " ").slice(0, 120) })
    .where(and(eq(motionJobs.id, id), eq(motionJobs.status, "running")));
  return { cancel: false };
}

const finiteSeconds = z.number().finite().min(0).max(3600);
export const CompleteBody = z.strictObject({
  kind: z.enum(["preview", "render", "gif"]),
  stills: z
    .array(z.strictObject({ name: z.string().max(20), seconds: finiteSeconds, scene: z.number().int().min(0).max(63), sceneType: z.string().max(20) }))
    .max(16)
    .optional(),
  video: z.strictObject({ name: z.string().max(20), seconds: finiteSeconds, frames: z.number().int().min(0).max(100_000), renderMs: z.number().finite().min(0).max(24 * 3600 * 1000) }).optional(),
  timings: z.strictObject({ renderMs: z.number().finite().min(0).max(24 * 3600 * 1000), uploadMs: z.number().finite().min(0).max(24 * 3600 * 1000) }),
});

/**
 * Completion: the verified files are copied into media storage under their final keys (temp name then rename), the existing finalisation
 * transaction runs, and the temporary uploads are removed in EVERY outcome. Repeating it for a finished job is harmless.
 */
export async function complete(id: string, body: z.infer<typeof CompleteBody>, now: Date = new Date()): Promise<{ ok: true }> {
  const row = await loadJob(id);
  if (row.status === "ready") return { ok: true };
  try {
    assertLive(row, now);
    if (!row.runnerClaimedAt) throw new RunnerError(409, "not_claimed");
    if (body.kind !== row.kind) throw new RunnerError(422, "kind_mismatch");
    const rules = rulesOfJob(row);
    const options = row.options as JobOptions;
    const files: StagedFile[] = [];
    const need = (name: string): string => {
      if (!rules.allowed(name)) throw new RunnerError(422, "bad_file_name");
      const file = assembledPath(id, name);
      if (!existsSync(file) || !statSync(file).isFile()) throw new RunnerError(422, "missing_file");
      return file;
    };
    if (row.kind === "preview") {
      const stills = body.stills ?? [];
      if (stills.length === 0 || stills.length > rules.maxFiles || new Set(stills.map((s) => s.name)).size !== stills.length) throw new RunnerError(422, "bad_file_list");
      const width = previewWidthOf(options);
      for (const s of stills) {
        files.push({ path: need(s.name), kind: "still", mime: "image/jpeg", ext: "jpg", width, height: Math.round((width * 9) / 16), seconds: s.seconds, sceneIndex: s.scene, sceneType: /^[A-Za-z]{1,20}$/.test(s.sceneType) ? s.sceneType : "scene" });
      }
    } else {
      const v = body.video;
      if (!v) throw new RunnerError(422, "bad_file_list");
      files.push(
        row.kind === "gif"
          ? { path: need(v.name), kind: "gif", mime: "image/gif", ext: "gif", width: 800, height: 450, seconds: v.seconds }
          : { path: need(v.name), kind: "mp4", mime: "video/mp4", ext: "mp4", width: 1920, height: 1080, seconds: v.seconds },
      );
    }
    const claimedAt = row.runnerClaimedAt as Date;
    const timings: Record<string, number> = {
      queueMs: row.startedAt ? Math.max(0, claimedAt.getTime() - row.createdAt.getTime()) : 0,
      wallMs: Math.max(0, now.getTime() - claimedAt.getTime()),
      renderMs: Math.round(body.video?.renderMs ?? body.timings.renderMs),
      uploadMs: Math.round(body.timings.uploadMs),
    };
    const done = await storeAndFinalize(row, files, timings);
    if (!done) throw new RunnerError(409, "job_finished");
    return { ok: true };
  } finally {
    removeUploads(id);
  }
}

const FAIL_MAP: Record<string, string> = {
  engine_mismatch: "engine_mismatch",
  invalid_storyboard: "invalid_storyboard",
  render_failed: "render_failed",
  browser_missing: "browser_missing",
  timeout: "timeout",
  gif_limit: "gif_limit",
  scene_not_found: "scene_not_found",
  too_large: "too_large",
  disk_full: "disk_full",
  upload_failed: "upload_failed",
  runner_internal: "runner_failed",
  cancelled: "runner_cancelled",
};

export const FailBody = z.strictObject({ code: z.string().max(40), message: z.string().max(400) });

/** A sanitized, bounded failure reported by the runner. Unknown codes become `runner_failed`. Repeating it is harmless. */
export async function failFromRunner(id: string, body: z.infer<typeof FailBody>): Promise<{ ok: true; state: string }> {
  const row = await loadJob(id);
  if (row.status !== "running") return { ok: true, state: row.status };
  const code = FAIL_MAP[body.code] ?? "runner_failed";
  const withText = code === "engine_mismatch" || code === "render_failed" || code === "invalid_storyboard" || code === "gif_limit" || code === "scene_not_found";
  const timings: Record<string, number> = row.runnerClaimedAt ? { wallMs: Date.now() - row.runnerClaimedAt.getTime() } : {};
  await failJob(id, code, code === "runner_cancelled" ? "The GitHub run was cancelled before it finished." : withText ? body.message : undefined, timings);
  return { ok: true, state: "failed" };
}

/** Disk-full while receiving: fail the job once so the runner does not keep retrying against a full disk. */
export async function failDiskFull(id: string): Promise<void> {
  await failJob(id, "disk_full", undefined, {});
}

export { uploadDirOf };

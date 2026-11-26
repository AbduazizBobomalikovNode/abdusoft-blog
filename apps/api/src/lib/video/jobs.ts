import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { mkdirSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { MotionAsset, MotionJob, MotionJobDetail, MotionJobKind } from "@blog/shared";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import { motionAssets, motionJobs, motionUsage, posts } from "../../db/schema.js";
import { recordAuditSafe } from "../audit.js";
import { deleteStoredFile, listStoredObjects, storeFileFromPath } from "../media/store.js";
import { fail, ok, SCHEDULER_ACTOR, type Actor, type ServiceResult } from "../posts/types.js";
import type { Executor } from "../executor.js";
import { loadMotion, type MotionTimeline, type StoryboardIssue } from "./motion.js";
import { cacheDirOf, dataDir, jobDirOf, jobsRoot, motionDir } from "./paths.js";
import { probeResources } from "./resources.js";
import { localPreflight } from "./local-preflight.js";
import { listUploadDirs, removeUploads } from "./uploads.js";
import { killStaleWorker, runWorker, type RunReport, type WorkerSpec } from "./runner.js";

type JobRow = typeof motionJobs.$inferSelect;
type AssetRow = typeof motionAssets.$inferSelect;

export interface JobOptions {
  /** preview: seconds to capture (default: one still per scene). */
  at?: number[];
  /** Only this scene (id or 1-based position). */
  scene?: string;
  /** preview: still width in px (320-640, default 480). */
  width?: number;
  /** gif: window in seconds, or `loop` for a closing scene's seamless hold. */
  from?: number;
  to?: number;
  loop?: boolean;
}

export const PREVIEW_MAX_STILLS = 8;
/** Ko'rik kadrining standart kengligi (px): kichik — rasm natijasi javob hajmiga sig'ishi uchun. */
export const PREVIEW_WIDTH = 480;
export const previewWidthOf = (options: JobOptions): number => Math.min(640, Math.max(320, Math.round(options.width ?? PREVIEW_WIDTH)));
/** Vosita chaqiruvi 240 soniyadan oldin javob berishi uchun ko'rik ishlari shundan uzoq ishlamaydi. */
export const PREVIEW_MAX_SECONDS = 180;
const STALE_QUEUE_MINUTES = 60;
/** Ishchi o'z taymeridan keyin ham tugamasa, ota jarayon shuncha vaqtdan keyin butun guruhni o'ldiradi. */
let killMarginMs = 20_000;
/** Ishchi paket (bundle) qurilishi (sovuq ~10-25 s) ishchining O'Z soati boshlanishidan oldin bajariladi: tashqi o'ldirish taymeri shuncha ko'proq kutadi. */
let bundleAllowanceMs = 180_000;
/** Faqat testlar uchun. */
export const setKillMarginForTests = (ms: number, bundleMs = 0): void => {
  killMarginMs = ms;
  bundleAllowanceMs = bundleMs;
};

/**
 * Ko'rik vositasi ishni kutadigan eng uzun vaqt: `VIDEO_PREVIEW_WAIT_SECONDS` (standart 40, ko'pi bilan 50) — proksi 60 soniyada uzadi,
 * shuning uchun vosita HECH QACHON undan uzoq kutmaydi; tayyor bo'lmasa ish raqami va `get_video_job` ko'rsatmasi qaytadi.
 */
let previewWaitOverrideMs: number | null = null;
export const previewWaitMs = (): number => previewWaitOverrideMs ?? Math.min(50, Math.max(5, config.VIDEO_PREVIEW_WAIT_SECONDS)) * 1000;
/** Faqat testlar uchun. */
export const setPreviewWaitForTests = (ms: number | null): void => {
  previewWaitOverrideMs = ms;
};

// --------------------------------------------------------------------------- DTO

const titleOf = (storyboard: unknown): string | null => {
  const t = (storyboard as { title?: unknown } | null)?.title;
  return typeof t === "string" ? t.slice(0, 100) : null;
};

export function toAssetDto(a: AssetRow): MotionAsset {
  return {
    id: a.id,
    kind: a.kind as MotionAsset["kind"],
    url: a.url,
    mime: a.mime,
    size: a.size,
    width: a.width,
    height: a.height,
    seconds: a.seconds,
    sceneIndex: a.sceneIndex,
    sceneType: a.sceneType,
  };
}

export function toJobDto(row: JobRow, assets: AssetRow[], queuePosition: number | null): MotionJob {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    postId: row.postId,
    title: titleOf(row.storyboard),
    durationSeconds: row.durationSeconds,
    progress: row.progress,
    phase: row.phase,
    message: row.message,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    cancelRequested: row.cancelRequested,
    via: row.via,
    clientName: row.clientName,
    queuePosition,
    timings: row.timings as Record<string, number>,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    assets: assets.map(toAssetDto),
  };
}

export const toJobDetail = (row: JobRow, assets: AssetRow[], queuePosition: number | null): MotionJobDetail => ({
  ...toJobDto(row, assets, queuePosition),
  storyboard: row.storyboard,
  options: row.options as Record<string, unknown>,
});

async function queuePositionOf(row: JobRow): Promise<number | null> {
  if (row.status !== "queued") return null;
  const [ahead] = await db
    .select({ n: count() })
    .from(motionJobs)
    .where(
      and(
        eq(motionJobs.status, "queued"),
        row.kind === "preview"
          ? and(eq(motionJobs.kind, "preview"), lt(motionJobs.createdAt, row.createdAt))
          : or(eq(motionJobs.kind, "preview"), lt(motionJobs.createdAt, row.createdAt)),
      ),
    );
  return (ahead?.n ?? 0) + 1;
}

async function assetsOf(jobIds: string[]): Promise<Map<string, AssetRow[]>> {
  const map = new Map<string, AssetRow[]>();
  if (jobIds.length === 0) return map;
  const rows = await db.select().from(motionAssets).where(inArray(motionAssets.jobId, jobIds)).orderBy(asc(motionAssets.sceneIndex), asc(motionAssets.createdAt));
  for (const r of rows) map.set(r.jobId, [...(map.get(r.jobId) ?? []), r]);
  return map;
}

export async function getJob(id: string): Promise<{ row: JobRow; assets: AssetRow[] } | null> {
  const [row] = await db.select().from(motionJobs).where(eq(motionJobs.id, id)).limit(1);
  if (!row) return null;
  return { row, assets: (await assetsOf([id])).get(id) ?? [] };
}

export async function getJobDetail(id: string): Promise<MotionJobDetail | null> {
  const found = await getJob(id);
  return found ? toJobDetail(found.row, found.assets, await queuePositionOf(found.row)) : null;
}

export async function listJobs(filter: { postId?: string; kind?: MotionJobKind; limit?: number } = {}): Promise<MotionJob[]> {
  const where = and(filter.postId ? eq(motionJobs.postId, filter.postId) : undefined, filter.kind ? eq(motionJobs.kind, filter.kind) : undefined);
  const rows = await db.select().from(motionJobs).where(where).orderBy(desc(motionJobs.createdAt)).limit(Math.min(filter.limit ?? 30, 100));
  const assets = await assetsOf(rows.map((r) => r.id));
  return Promise.all(rows.map(async (r) => toJobDto(r, assets.get(r.id) ?? [], await queuePositionOf(r))));
}

// --------------------------------------------------------------------------- estimate

/**
 * Taxminiy ishlash vaqti. Boshlang'ich qiymatlar `docs/video.md`dagi o'lchovlardan (M1 noutbuk ~1.9 s/soniya, kichik server uchun ~2x zaxira bilan; concurrency 1);
 * kamida 3 ta tugagan ish bo'lsa, ularning haqiqiy tezligi (kadr/soniya) ishlatiladi.
 */
export const ESTIMATE_DEFAULTS = {
  previewBaseSeconds: 10,
  previewPerStillSeconds: 0.8,
  renderBaseSeconds: 12,
  renderSecondsPerVideoSecond: 4,
  gifSecondsPerVideoSecond: 3,
};

export async function estimateSeconds(kind: MotionJobKind, videoSeconds: number, stills = 0): Promise<{ seconds: number; basis: "measured" | "default" }> {
  const d = ESTIMATE_DEFAULTS;
  if (kind === "preview") return { seconds: Math.round(d.previewBaseSeconds + d.previewPerStillSeconds * stills), basis: "default" };
  const recent = await db
    .select({ timings: motionJobs.timings, duration: motionJobs.durationSeconds })
    .from(motionJobs)
    .where(and(eq(motionJobs.kind, kind), eq(motionJobs.status, "ready")))
    .orderBy(desc(motionJobs.finishedAt))
    .limit(5);
  const rates = recent
    .map((r) => ((r.timings as { renderMs?: number }).renderMs ?? 0) / 1000 / Math.max(1, r.duration))
    .filter((x) => x > 0)
    .sort((a, b) => a - b);
  const perSecond = rates.length >= 3 ? (rates[Math.floor(rates.length / 2)] as number) : kind === "gif" ? d.gifSecondsPerVideoSecond : d.renderSecondsPerVideoSecond;
  return { seconds: Math.round(d.renderBaseSeconds + perSecond * videoSeconds), basis: rates.length >= 3 ? "measured" : "default" };
}

// --------------------------------------------------------------------------- validation helpers

export type ValidatedStoryboard = { storyboard: unknown; timeline: MotionTimeline; title: string; sceneCount: number };

/** Ishonchsiz kiritma: avval bayt hajmi, keyin sxema. `ok: false` — aniq xatolar ro'yxati bilan. */
export async function validateInput(input: unknown): Promise<{ ok: true; value: ValidatedStoryboard } | { ok: false; issues: StoryboardIssue[] }> {
  const motion = await loadMotion();
  let text: string;
  try {
    text = JSON.stringify(input);
  } catch {
    return { ok: false, issues: [{ path: "$", code: "invalid_json", message: "the storyboard is not plain JSON data" }] };
  }
  if (typeof text !== "string") return { ok: false, issues: [{ path: "$", code: "invalid_json", message: "the storyboard must be a JSON object" }] };
  const result = motion.validateStoryboardJson(text);
  if (!result.ok) return result;
  return { ok: true, value: { storyboard: JSON.parse(text) as unknown, timeline: result.timeline, title: result.storyboard.title, sceneCount: result.timeline.scenes.length } };
}

/** Sahnani id yoki 1-dan boshlanuvchi tartib raqami bo'yicha topadi (renderdagi bilan bir xil qoida). */
export function findScene(timeline: MotionTimeline, ref: string): MotionTimeline["scenes"][number] | null {
  const byId = timeline.scenes.find((s) => s.id === ref);
  if (byId) return byId;
  if (/^\d+$/.test(ref)) return timeline.scenes[Number(ref) - 1] ?? null;
  return null;
}

/** GIF chegaralari render boshlanishidan OLDIN tekshiriladi (ishchi ham qayta tekshiradi). */
export async function gifWindowSeconds(timeline: MotionTimeline, options: JobOptions): Promise<{ ok: true; seconds: number } | { ok: false; message: string }> {
  const motion = await loadMotion();
  const max = motion.GIF_LIMITS.maxSeconds;
  let from = options.from ?? 0;
  let to = options.to ?? timeline.totalSeconds;
  if (options.scene !== undefined) {
    const scene = findScene(timeline, options.scene);
    if (!scene) return { ok: false, message: `no scene "${options.scene}" in this storyboard (use a scene id or its 1-based position)` };
    from = scene.startFrame / timeline.fps;
    to = scene.endFrame / timeline.fps;
  }
  const seconds = to - from;
  if (!Number.isFinite(seconds) || seconds <= 0 || from < 0 || to > timeline.totalSeconds + 1e-9) return { ok: false, message: `GIF range ${from}-${to} s is invalid for a ${timeline.totalSeconds.toFixed(1)} s storyboard` };
  if (seconds > max + 1e-9) return { ok: false, message: `GIF clips are limited to ${max} s but ${seconds.toFixed(1)} s was requested: choose one scene or a window of at most ${max} s, or render an MP4 instead` };
  return { ok: true, seconds };
}

// --------------------------------------------------------------------------- create

const DAY_MS = 24 * 60 * 60 * 1000;
/** Postgres advisory-lock key serialising "check quotas + insert" (works on PGlite and Postgres). */
const CREATE_LOCK_KEY = 7_302_501;

const bucketOf = (kind: MotionJobKind): "preview" | "render" => (kind === "preview" ? "preview" : "render");

/** Daily usage counts from `motion_usage` (one row per created job; deleting jobs does NOT erase it). */
async function usedSince(ex: Executor, bucket: "preview" | "render", since: Date): Promise<number> {
  const [r] = await ex
    .select({ n: count() })
    .from(motionUsage)
    .where(and(eq(motionUsage.bucket, bucket), gte(motionUsage.createdAt, since)));
  return r?.n ?? 0;
}

export async function queueCounts(ex: Executor = db): Promise<{ queued: number; running: number }> {
  const rows = await ex.select({ status: motionJobs.status, n: count() }).from(motionJobs).where(inArray(motionJobs.status, ["queued", "running"])).groupBy(motionJobs.status);
  return { queued: rows.find((r) => r.status === "queued")?.n ?? 0, running: rows.find((r) => r.status === "running")?.n ?? 0 };
}

/** Quotas, one active job per post, queue length and server resources. Every refusal names what to do. Runs inside the create transaction. */
export async function checkQuotas(kind: MotionJobKind, postId: string | null, ex: Executor = db): Promise<ServiceResult<null>> {
  const since = new Date(Date.now() - DAY_MS);
  if (kind !== "preview" && postId) {
    const [active] = await ex
      .select({ id: motionJobs.id })
      .from(motionJobs)
      .where(and(eq(motionJobs.postId, postId), inArray(motionJobs.kind, ["render", "gif"]), inArray(motionJobs.status, ["queued", "running"])))
      .limit(1);
    if (active) return fail("conflict", "Bu post uchun video allaqachon navbatda yoki tayyorlanmoqda", { code: "post_busy", activeJobId: active.id, hint: "Wait for it to finish or cancel it (cancel_video_job), then start again." });
  }
  const q = await queueCounts(ex);
  if (q.queued >= config.VIDEO_MAX_QUEUE) {
    return fail("rate_limited", "Video navbati to'la", { code: "queue_full", queued: q.queued, limit: config.VIDEO_MAX_QUEUE, retryAfterSeconds: 60, hint: "Wait for the running jobs to finish (get_video_job) and try again in a minute." });
  }
  if (kind === "preview") {
    const limit = config.VIDEO_MAX_PREVIEWS_PER_DAY;
    if (limit > 0 && (await usedSince(ex, "preview", since)) >= limit) {
      return fail("rate_limited", "Bugungi ko'rik (preview) chegarasiga yetildi", { code: "daily_previews", limit, env: "VIDEO_MAX_PREVIEWS_PER_DAY", retryAfterSeconds: 3600, hint: "Use validate_storyboard (free) to check the storyboard, or try again later; the owner can raise VIDEO_MAX_PREVIEWS_PER_DAY." });
    }
  } else {
    const limit = config.VIDEO_MAX_RENDERS_PER_DAY;
    if (limit > 0 && (await usedSince(ex, "render", since)) >= limit) {
      return fail("rate_limited", "Bugungi video render chegarasiga yetildi", { code: "daily_renders", limit, env: "VIDEO_MAX_RENDERS_PER_DAY", retryAfterSeconds: 3600, hint: "Renders are capped per rolling 24 hours (deleting jobs does not reset the count); try later, or the owner can raise VIDEO_MAX_RENDERS_PER_DAY." });
    }
  }
  const res = probeResources();
  if (res.freeDiskMb !== null && res.freeDiskMb < config.VIDEO_MIN_FREE_DISK_MB) {
    return fail("rate_limited", "Serverda bo'sh disk yetarli emas", { code: "low_disk", freeDiskMb: res.freeDiskMb, minFreeDiskMb: config.VIDEO_MIN_FREE_DISK_MB, retryAfterSeconds: 600, hint: "The server is low on disk space. Ask the owner to free space (or lower VIDEO_MIN_FREE_DISK_MB)." });
  }
  // Memory matters only when the render runs on this machine.
  if (config.VIDEO_RUNNER === "local" && res.freeMemoryMb !== null && res.freeMemoryMb < config.VIDEO_MIN_FREE_MEMORY_MB) {
    return fail("rate_limited", "Serverda bo'sh xotira yetarli emas", { code: "low_memory", freeMemoryMb: res.freeMemoryMb, minFreeMemoryMb: config.VIDEO_MIN_FREE_MEMORY_MB, retryAfterSeconds: 120, hint: "The server is short of memory right now (the blog comes first). Try again in a few minutes." });
  }
  return ok(null);
}

async function liveSlug(postId: string): Promise<{ id: string } | null> {
  const [p] = await db.select({ id: posts.id, deletedAt: posts.deletedAt }).from(posts).where(eq(posts.id, postId)).limit(1);
  return p && !p.deletedAt ? { id: p.id } : null;
}

export interface CreateJobInput {
  kind: MotionJobKind;
  /** Raw (untrusted) storyboard. */
  storyboard: unknown;
  postId?: string | null;
  options?: JobOptions;
  /** Already validated by the caller (the storyboard is validated ONCE per request in the API). */
  validated?: ValidatedStoryboard;
}

/** Is the unique-index violation that protects "one active render per post" (any driver error shape)? */
function isActivePostViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const err = e as { code?: unknown; message?: unknown; constraint?: unknown };
    if (err.code === "23505" || err.constraint === "motion_jobs_one_active_per_post_idx") return true;
    if (typeof err.message === "string" && err.message.includes("motion_jobs_one_active_per_post_idx")) return true;
  }
  return false;
}

export async function createJob(actor: Actor, input: CreateJobInput): Promise<ServiceResult<MotionJobDetail>> {
  const options = input.options ?? {};
  const checked = input.validated ? { ok: true as const, value: input.validated } : await validateInput(input.storyboard);
  if (!checked.ok) return fail("unprocessable", "Storyboard noto'g'ri", { code: "invalid_storyboard", issues: checked.issues });
  const { storyboard, timeline } = checked.value;

  if (input.postId && !(await liveSlug(input.postId))) return fail("not_found", "Post topilmadi (yoki chiqindi qutisida)", { code: "post_not_found" });
  if (input.kind === "gif") {
    const w = await gifWindowSeconds(timeline, options);
    if (!w.ok) return fail("unprocessable", "GIF chegarasidan oshdi", { code: "gif_limit", hint: w.message });
  }
  if (options.scene !== undefined && !findScene(timeline, options.scene)) return fail("unprocessable", "Sahna topilmadi", { code: "scene_not_found", hint: `no scene "${options.scene}"; use a scene id or its 1-based position` });
  if (input.kind === "preview" && options.at && options.at.length > PREVIEW_MAX_STILLS) return fail("unprocessable", "Ko'rik uchun juda ko'p kadr", { code: "too_many_stills", limit: PREVIEW_MAX_STILLS });

  const ready = await backendReadiness();
  if (!ready.ok) return fail("unprocessable", "Video xizmati hali sozlanmagan", { code: ready.code, hint: ready.hint });

  try {
    const created = await db.transaction(async (tx) => {
      // One writer at a time: the checks and the insert below are one atomic step, so parallel calls cannot overshoot a quota.
      await tx.execute(sql`select pg_advisory_xact_lock(${CREATE_LOCK_KEY})`);
      const quota = await checkQuotas(input.kind, input.postId ?? null, tx);
      if (!quota.ok) return quota;
      const [row] = await tx
        .insert(motionJobs)
        .values({
          kind: input.kind,
          postId: input.postId ?? null,
          storyboard,
          options: options as Record<string, unknown>,
          durationSeconds: timeline.totalSeconds,
          requestedBy: actor.userId,
          via: actor.via,
          clientName: actor.mcp?.clientName ?? null,
          ...(input.kind === "preview" ? { expiresAt: new Date(Date.now() + config.VIDEO_PREVIEW_TTL_HOURS * 3600_000) } : {}),
        })
        .returning();
      if (!row) return fail("bad_request", "Ishni yaratib bo'lmadi");
      await tx.insert(motionUsage).values({ bucket: bucketOf(input.kind) });
      return ok(row);
    });
    if (!created.ok) return created;
    const row = created.data;
    await recordAuditSafe(actor, {
      action: input.kind === "preview" ? "video.preview" : "video.render",
      entityType: "video",
      entityId: row.id,
      summary: input.kind === "preview" ? "Video ko'rik kadrlari so'raldi" : input.kind === "gif" ? "GIF render boshlandi" : "Video render boshlandi",
      meta: { kind: input.kind, postId: input.postId ?? null, seconds: Math.round(timeline.totalSeconds * 10) / 10, scenes: timeline.scenes.length, runner: config.VIDEO_RUNNER },
    });
    kickQueue();
    return ok(toJobDetail(row, [], await queuePositionOf(row)));
  } catch (error) {
    if (isActivePostViolation(error)) {
      return fail("conflict", "Bu post uchun video allaqachon navbatda yoki tayyorlanmoqda", { code: "post_busy", hint: "Wait for it to finish or cancel it (cancel_video_job), then start again." });
    }
    throw error;
  }
}

/** Is the chosen backend able to take a job right now? Refusing at creation keeps the queue from filling with jobs that cannot start. */
export async function backendReadiness(): Promise<{ ok: true } | { ok: false; code: string; hint: string }> {
  if (config.VIDEO_RUNNER === "github") {
    const { githubReadiness } = await import("./runner-github.js");
    return githubReadiness();
  }
  const pre = localPreflight();
  return pre.ok ? { ok: true } : { ok: false, code: "local_preflight_missing", hint: pre.hint };
}

// --------------------------------------------------------------------------- queue / execution

const running = new Set<string>();
const controllers = new Map<string, AbortController>();
let ticking = false;
let idleWaiters: Array<() => void> = [];

export const kickQueue = (): void => {
  void tickQueue().catch((e: unknown) => console.error("Video navbati xatosi:", e instanceof Error ? e.message : e));
};

/** Render soati (soniya): ko'rik yoki render/GIF. Runner va watchdog shu qiymatni ishlatadi. */
export const jobTimeoutSeconds = (kind: MotionJobKind): number => (kind === "preview" ? Math.min(PREVIEW_MAX_SECONDS, config.VIDEO_PREVIEW_TIMEOUT_SECONDS) : config.VIDEO_RENDER_TIMEOUT_SECONDS);

/** Bir vaqtda ishlayotganlar soni chegarasi: `local` backendda ko'pi bilan 2 (bitta kichik server), `github`da VIDEO_MAX_RUNNING. */
const maxRunning = (runner: "github" | "local"): number => (runner === "local" ? Math.min(2, config.VIDEO_MAX_RUNNING) : config.VIDEO_MAX_RUNNING);

/** Atomik "claim": `queued -> running`. Bir vaqtda ishlayotganlar soni chegaradan oshmaydi. Ko'riklar oldin. */
export async function claimNextJob(runner: "github" | "local" = config.VIDEO_RUNNER): Promise<JobRow | null> {
  const [row] = await db
    .update(motionJobs)
    .set({ status: "running", runner, startedAt: new Date(), progress: 0, phase: runner === "github" ? "dispatching" : "starting", message: runner === "github" ? "starting a GitHub runner" : "starting" })
    .where(
      and(
        eq(
          motionJobs.id,
          sql`(select id from motion_jobs where status = 'queued' order by (kind = 'preview') desc, created_at asc limit 1 for update skip locked)`,
        ),
        eq(motionJobs.status, "queued"),
        sql`(select count(*) from motion_jobs where status = 'running') < ${maxRunning(runner)}`,
      ),
    )
    .returning();
  return row ?? null;
}

export async function tickQueue(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    if (config.VIDEO_RUNNER === "github") {
      const { tickGithub } = await import("./runner-github.js");
      await tickGithub(claimNextJob);
      return;
    }
    await failStaleQueued();
    // The local backend refuses to start anything until the setup script has proven this machine can render.
    if (!localPreflight().ok) return;
    while (running.size < maxRunning("local")) {
      const res = probeResources();
      const lowMem = res.freeMemoryMb !== null && res.freeMemoryMb < config.VIDEO_MIN_FREE_MEMORY_MB;
      const lowDisk = res.freeDiskMb !== null && res.freeDiskMb < config.VIDEO_MIN_FREE_DISK_MB;
      if (lowMem || lowDisk) break; // jobs wait in the queue; the blog comes first
      const job = await claimNextJob("local");
      if (!job) break;
      running.add(job.id);
      void execute(job)
        .catch((e: unknown) => console.error("Video ishi xatosi:", e instanceof Error ? e.message : e))
        .finally(() => {
          running.delete(job.id);
          const waiters = idleWaiters;
          idleWaiters = [];
          if (running.size === 0) for (const w of waiters) w();
          else idleWaiters = waiters;
          kickQueue();
        });
    }
  } finally {
    ticking = false;
  }
}

/** Testlar: hozir ishlayotgan hamma ish tugaguncha kutadi. */
export function whenVideoIdle(): Promise<void> {
  if (running.size === 0) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

async function failStaleQueued(): Promise<void> {
  const res = probeResources();
  const low = (res.freeMemoryMb !== null && res.freeMemoryMb < config.VIDEO_MIN_FREE_MEMORY_MB) || (res.freeDiskMb !== null && res.freeDiskMb < config.VIDEO_MIN_FREE_DISK_MB);
  if (!low) return;
  await db
    .update(motionJobs)
    .set({ status: "failed", errorCode: "low_resources", errorMessage: "The server stayed short of memory or disk for too long, so the job was not started. Start it again later.", finishedAt: new Date() })
    .where(and(eq(motionJobs.status, "queued"), lt(motionJobs.createdAt, new Date(Date.now() - STALE_QUEUE_MINUTES * 60_000))));
}

export function phasePercent(phase: string, fraction: number | null): number {
  const f = fraction ?? 0;
  switch (phase) {
    case "validate":
      return 1;
    case "highlight":
      return 3;
    case "bundle":
      return Math.round(5 + 20 * f);
    case "browser":
      return Math.round(25 + 5 * f);
    case "stills":
    case "render":
      return Math.round(30 + 60 * f);
    case "encode":
      return Math.round(90 + 9 * f);
    case "uploading":
      return Math.round(95 + 4 * f);
    case "done":
      return 100;
    default:
      return 0;
  }
}

/** Ishchidan kelgan xabarni xavfsiz qiladi: tizim yo'llari, qator ko'chirishlar va uzunlik. */
export function safeMessage(text: string): string {
  let out = text;
  for (const p of [dataDir(), motionDir(), process.cwd()]) if (p.length > 3) out = out.split(p).join("<server>");
  out = out.replace(/\/(?:home|Users|root|var|tmp|opt|private)\/[^\s'"`)]+/g, "<path>");
  return out.replace(/\s+/g, " ").trim().slice(0, 400);
}

const MESSAGES: Record<string, string> = {
  timeout: "The render did not finish within the time limit and was stopped.",
  memory: "The render used more memory than the limit and was stopped.",
  browser_missing: "The headless browser is not available to the renderer (on the local backend the owner must run scripts/setup-motion-browser.sh; on GitHub the workflow installs it).",
  interrupted: "The API server restarted while this job was running. Start it again.",
  storage_failed: "The result could not be saved to the media storage.",
  invalid_storyboard: "The storyboard did not pass validation inside the renderer.",
  engine_mismatch: "The API accepted the storyboard but the render engine rejected it (the engine version on the runner differs from the API).",
  disk_full: "The disk is full, so the result could not be written. The owner must free space.",
  too_large: "The result is larger than the size limit. Shorten the storyboard.",
  upload_failed: "The runner could not upload the result to the API.",
  runner_failed: "The GitHub runner reported a failure.",
  runner_timeout: "The GitHub runner did not finish within the time limit.",
  runner_not_started: "No GitHub runner picked the job up in time.",
};

/** Ishni `failed` qiladi (faqat hali `running` bo'lsa). `true` — shu chaqiruv o'zgartirdi. Natija jurnalga yoziladi. */
export async function failJob(id: string, code: string, message: string | undefined, timings: Record<string, number>): Promise<boolean> {
  const [row] = await db
    .update(motionJobs)
    .set({ status: "failed", errorCode: code, errorMessage: message ? safeMessage(message) : (MESSAGES[code] ?? "The render failed."), finishedAt: new Date(), timings, workerPid: null, phase: null })
    .where(and(eq(motionJobs.id, id), eq(motionJobs.status, "running")))
    .returning();
  if (!row) return false;
  removeUploads(id);
  await auditOutcome(row);
  return true;
}

/** Har bir ish natijasi (tayyor / muvaffaqiyatsiz) jurnalga yoziladi — mahalliy ham, GitHub ham bir xil amal bilan. */
export async function auditOutcome(row: JobRow): Promise<void> {
  await recordAuditSafe(SCHEDULER_ACTOR, {
    action: "video.finish",
    entityType: "video",
    entityId: row.id,
    summary: row.status === "ready" ? "Video ishi tayyor" : "Video ishi muvaffaqiyatsiz",
    meta: { kind: row.kind, status: row.status, errorCode: row.errorCode, runner: row.runner, runId: row.runnerRunId, postId: row.postId },
  });
}

async function execute(job: JobRow): Promise<void> {
  const ac = new AbortController();
  controllers.set(job.id, ac);
  const jobDir = jobDirOf(job.id);
  const queueMs = job.startedAt ? job.startedAt.getTime() - job.createdAt.getTime() : 0;
  const timings: Record<string, number> = { queueMs };
  try {
    const [fresh] = await db.select({ cancelRequested: motionJobs.cancelRequested }).from(motionJobs).where(eq(motionJobs.id, job.id)).limit(1);
    if (fresh?.cancelRequested) {
      await db.update(motionJobs).set({ status: "cancelled", finishedAt: new Date(), timings }).where(and(eq(motionJobs.id, job.id), eq(motionJobs.status, "running")));
      return;
    }
    mkdirSync(path.join(jobDir, "out"), { recursive: true });
    mkdirSync(cacheDirOf(), { recursive: true });
    const storyboardFile = path.join(jobDir, "storyboard.json");
    // The storyboard was validated once when the job was created; the worker validates it again with the engine itself.
    writeFileSync(storyboardFile, JSON.stringify(job.storyboard));
    const options = job.options as JobOptions;
    const spec: WorkerSpec = {
      kind: job.kind,
      storyboardFile,
      outDir: path.join(jobDir, "out"),
      cacheDir: cacheDirOf(),
      concurrency: config.VIDEO_CONCURRENCY,
      maxOutputBytes: job.kind === "preview" ? config.VIDEO_MAX_STILL_BYTES : job.kind === "gif" ? config.VIDEO_MAX_GIF_BYTES : config.VIDEO_MAX_MP4_BYTES,
      ...(job.kind === "preview" ? { width: previewWidthOf(options), ...(options.at ? { at: options.at.slice(0, PREVIEW_MAX_STILLS) } : {}) } : { outName: job.kind === "gif" ? "clip.gif" : "video.mp4" }),
      ...(options.scene !== undefined ? { scene: options.scene } : {}),
      ...(job.kind === "gif" ? { ...(options.from !== undefined ? { from: options.from } : {}), ...(options.to !== undefined ? { to: options.to } : {}), ...(options.loop ? { loop: true } : {}) } : {}),
      ...(config.VIDEO_BROWSER_PATH ? { browserExecutable: config.VIDEO_BROWSER_PATH } : {}),
    };
    const timeoutMs = jobTimeoutSeconds(job.kind) * 1000;
    spec.timeoutMs = timeoutMs;

    let lastWrite = 0;
    let lastPhase = "";
    const report: RunReport = await runWorker({
      jobId: job.id,
      spec,
      // The worker builds the bundle BEFORE its own clock starts (cold: 10-25 s); the outer kill timer allows for it.
      timeoutMs: timeoutMs + killMarginMs + bundleAllowanceMs,
      memoryLimitMb: config.VIDEO_WORKER_MEMORY_MB,
      signal: ac.signal,
      onSpawn: (pid) => void db.update(motionJobs).set({ workerPid: pid }).where(eq(motionJobs.id, job.id)).catch(() => undefined),
      onProgress: (m) => {
        const now = Date.now();
        if (m.phase === lastPhase && now - lastWrite < 1000) return;
        lastPhase = m.phase;
        lastWrite = now;
        void db
          .update(motionJobs)
          .set({ progress: phasePercent(m.phase, m.fraction), phase: m.phase, message: m.message.slice(0, 120) })
          .where(and(eq(motionJobs.id, job.id), eq(motionJobs.status, "running")))
          .catch(() => undefined);
      },
    });
    timings.wallMs = report.wallMs;
    timings.peakRssMb = report.peakRssMb;
    const o = report.outcome;
    if (o.outcome === "cancelled") {
      await db.update(motionJobs).set({ status: "cancelled", finishedAt: new Date(), timings, workerPid: null, phase: null }).where(and(eq(motionJobs.id, job.id), eq(motionJobs.status, "running")));
      return;
    }
    if (o.outcome === "timeout") {
      await failJob(job.id, "timeout", undefined, timings);
      return;
    }
    if (o.outcome === "memory") {
      await failJob(job.id, "memory", o.unknown ? "The memory of the render could not be measured, so it was stopped for safety." : `The render used more than ${config.VIDEO_WORKER_MEMORY_MB} MB (peak ${o.peakRssMb} MB) and was stopped.`, timings);
      return;
    }
    if (o.outcome === "crashed") {
      await failJob(job.id, "crashed", o.message, timings);
      return;
    }
    if (o.outcome === "error") {
      await failJob(job.id, o.code, o.code === "browser_missing" ? MESSAGES.browser_missing : o.message, timings);
      return;
    }
    await finishWithResult(job, o.result, jobDir, timings);
  } catch (error) {
    console.error(`Video ishi (${job.id}) kutilmagan xato:`, error instanceof Error ? error.message : error);
    await failJob(job.id, "internal_error", "The render failed unexpectedly. See the server log.", timings);
  } finally {
    controllers.delete(job.id);
    rmSync(jobDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

/** Ichki ishchi natijasi (local backend): fayllarni saqlash qatlamiga yuklaydi (hajm chegaralari bilan) va ishni `ready` qiladi. */
async function finishWithResult(job: JobRow, result: Extract<Awaited<ReturnType<typeof runWorker>>["outcome"], { outcome: "result" }>["result"], jobDir: string, timings: Record<string, number>): Promise<void> {
  const outRoot = path.resolve(jobDir, "out") + path.sep;
  const inside = (file: string): boolean => path.resolve(file).startsWith(outRoot);
  const files: StagedFile[] = [];
  const width = previewWidthOf(job.options as JobOptions);
  if (result.kind === "preview") {
    for (const s of result.stills) {
      if (!inside(s.file)) throw new Error("worker reported a file outside its output directory");
      files.push({ path: s.file, kind: "still", mime: "image/jpeg", ext: "jpg", width, height: Math.round((width * 9) / 16), seconds: s.seconds, sceneIndex: s.scene, sceneType: s.sceneType });
    }
  } else {
    if (!inside(result.file)) throw new Error("worker reported a file outside its output directory");
    timings.renderMs = result.renderMs;
    files.push(
      result.kind === "gif"
        ? { path: result.file, kind: "gif", mime: "image/gif", ext: "gif", width: 800, height: 450, seconds: result.seconds }
        : { path: result.file, kind: "mp4", mime: "video/mp4", ext: "mp4", width: 1920, height: 1080, seconds: result.seconds },
    );
  }
  await storeAndFinalize(job, files, timings);
}

/** A verified result file waiting on disk to be moved into media storage. */
export interface StagedFile {
  path: string;
  kind: "mp4" | "gif" | "still";
  mime: string;
  ext: string;
  width: number | null;
  height: number | null;
  seconds: number | null;
  sceneIndex?: number;
  sceneType?: string;
}

/**
 * Natija fayllarini saqlash qatlamiga yuklaydi (hajm chegaralari bilan) va YAGONA yakunlash tranzaksiyasini ishga tushiradi.
 * Mahalliy ishchi ham, GitHub runner ham shu yo'ldan o'tadi. `true` — ish `ready` bo'ldi.
 */
export async function storeAndFinalize(job: JobRow, files: StagedFile[], timings: Record<string, number>): Promise<boolean> {
  const stored: Array<typeof motionAssets.$inferInsert> = [];
  const storedKeys: string[] = [];
  try {
    for (const f of files) {
      const size = statSync(f.path).size;
      const limit = f.kind === "still" ? config.VIDEO_MAX_STILL_BYTES : f.kind === "gif" ? config.VIDEO_MAX_GIF_BYTES : config.VIDEO_MAX_MP4_BYTES;
      if (size > limit) {
        await Promise.all(storedKeys.map((k) => deleteStoredFile(k).catch(() => undefined)));
        await failJob(job.id, "too_large", f.kind === "still" ? `A preview frame is ${size} bytes; the limit is ${limit}.` : `The ${f.kind === "gif" ? "GIF" : "MP4"} is ${Math.round(size / 1024 / 1024)} MB; the limit is ${Math.round(limit / 1024 / 1024)} MB. Shorten the storyboard.`, timings);
        return false;
      }
      const up = await storeFileFromPath({ path: f.path, ext: f.ext, mime: f.mime });
      storedKeys.push(up.key);
      stored.push({ jobId: job.id, kind: f.kind, key: up.key, url: up.url, mime: f.mime, size: up.size, width: f.width, height: f.height, seconds: f.seconds, sceneIndex: f.sceneIndex ?? null, sceneType: f.sceneType ?? null });
    }
  } catch (error) {
    await Promise.all(storedKeys.map((k) => deleteStoredFile(k).catch(() => undefined)));
    const code = (error as { code?: unknown } | null)?.code === "ENOSPC" ? "disk_full" : "storage_failed";
    console.error(`Video natijasini saqlashda xatolik (${job.id}):`, error instanceof Error ? error.message : error);
    await failJob(job.id, code, undefined, timings);
    return false;
  }
  const settled = await db.transaction(async (tx) => {
    const [cur] = await tx.select({ status: motionJobs.status }).from(motionJobs).where(eq(motionJobs.id, job.id)).limit(1);
    if (!cur || cur.status !== "running") return null; // deleted, cancelled or settled meanwhile
    await tx.insert(motionAssets).values(stored);
    const [row] = await tx.update(motionJobs).set({ status: "ready", progress: 100, phase: "done", message: "ready", finishedAt: new Date(), timings, workerPid: null }).where(eq(motionJobs.id, job.id)).returning();
    return row ?? null;
  });
  if (!settled) {
    await Promise.all(storedKeys.map((k) => deleteStoredFile(k).catch(() => undefined)));
    return false;
  }
  await auditOutcome(settled);
  if (job.postId && job.kind !== "preview") await pruneRendersForPost(job.postId).catch(() => undefined);
  return true;
}

// --------------------------------------------------------------------------- cancel / delete

export async function cancelJob(actor: Actor, id: string): Promise<ServiceResult<MotionJobDetail>> {
  const found = await getJob(id);
  if (!found) return fail("not_found", "Video ishi topilmadi", { code: "job_not_found" });
  let row = found.row;
  if (row.status === "queued") {
    const changed = await db.update(motionJobs).set({ status: "cancelled", finishedAt: new Date(), cancelRequested: true }).where(and(eq(motionJobs.id, id), eq(motionJobs.status, "queued"))).returning();
    // The scheduler may have claimed the job a moment ago: then it is a running job and is cancelled as such.
    if (changed.length === 0) row = (await getJob(id))?.row ?? row;
  }
  if (row.status === "queued") {
    // cancelled just above
  } else if (row.status === "running" && row.runner === "github") {
    // The state is in the database: the job is cancelled at once; the runner sees the flag at its next progress call and the run is cancelled (best effort).
    await db.update(motionJobs).set({ status: "cancelled", cancelRequested: true, finishedAt: new Date(), phase: null }).where(and(eq(motionJobs.id, id), eq(motionJobs.status, "running")));
    removeUploads(id);
    const { cancelWorkflowRun } = await import("./github.js");
    void cancelWorkflowRun(row.runnerRunId);
  } else if (row.status === "running") {
    await db.update(motionJobs).set({ cancelRequested: true }).where(eq(motionJobs.id, id));
    const ac = controllers.get(id);
    if (ac) ac.abort();
    else await db.update(motionJobs).set({ status: "cancelled", finishedAt: new Date() }).where(and(eq(motionJobs.id, id), eq(motionJobs.status, "running"))); // not ours (stale row)
  } else {
    return fail("conflict", "Bu ish allaqachon tugagan", { code: "job_finished", status: row.status, hint: "Only queued or running jobs can be cancelled; use delete_video_job to remove a finished one." });
  }
  await recordAuditSafe(actor, { action: "video.cancel", entityType: "video", entityId: id, summary: "Video ishi bekor qilindi", meta: { kind: row.kind, wasStatus: row.status, runner: row.runner, runId: row.runnerRunId } });
  const after = await getJob(id);
  return ok(toJobDetail(after!.row, after!.assets, await queuePositionOf(after!.row)));
}

/** Postlar (qoralamalar ham): shu URL post tanasida yoki muqovada ishlatilganmi. */
export async function postsUsingUrls(urls: string[]): Promise<Array<{ id: string; title: string }>> {
  if (urls.length === 0) return [];
  const conds = urls.flatMap((url) => {
    const escaped = url.replace(/[%_\\]/g, (c) => `\\${c}`);
    return [eq(posts.coverUrl, url), sql`${posts.contentJson}::text like ${`%${escaped.replace(/"/g, '\\"')}%`}`];
  });
  return db.select({ id: posts.id, title: posts.title }).from(posts).where(or(...conds)).limit(10);
}

async function removeJobFiles(jobId: string): Promise<void> {
  const rows = await db.select().from(motionAssets).where(eq(motionAssets.jobId, jobId));
  await Promise.all(rows.map((r) => deleteStoredFile(r.key).catch((e: unknown) => console.error("Video faylini o'chirib bo'lmadi:", e instanceof Error ? e.message : e))));
}

/** Faylli ishni o'chirish: havola qilingan (postda ishlatilgan) video HECH QACHON o'chirilmaydi. */
async function deleteJobRow(id: string): Promise<{ deleted: boolean; usedBy?: Array<{ id: string; title: string }> }> {
  const assets = await db.select({ url: motionAssets.url }).from(motionAssets).where(eq(motionAssets.jobId, id));
  const usedBy = await postsUsingUrls(assets.map((a) => a.url));
  if (usedBy.length > 0) return { deleted: false, usedBy };
  await removeJobFiles(id);
  await db.delete(motionJobs).where(eq(motionJobs.id, id));
  removeUploads(id);
  return { deleted: true };
}

export async function deleteJob(actor: Actor, id: string): Promise<ServiceResult<{ id: string }>> {
  const found = await getJob(id);
  if (!found) return fail("not_found", "Video ishi topilmadi", { code: "job_not_found" });
  if (found.row.status === "running") return fail("conflict", "Ish hozir bajarilmoqda — avval bekor qiling", { code: "job_running", hint: "Cancel it first (cancel_video_job), then delete." });
  const res = await deleteJobRow(id);
  if (!res.deleted) return fail("conflict", "Video post ichida ishlatilgan — o'chirilmadi", { code: "job_referenced", usedBy: res.usedBy, hint: "Remove the video link from those posts first." });
  await recordAuditSafe(actor, { action: "video.delete", entityType: "video", entityId: id, summary: "Video ishi o'chirildi", meta: { kind: found.row.kind, assets: found.assets.length } });
  return ok({ id });
}

// --------------------------------------------------------------------------- retention

/** Har bir postda oxirgi N ta tayyor render/GIF qoladi; havola qilinganlar hech qachon o'chirilmaydi. */
export async function pruneRendersForPost(postId: string): Promise<number> {
  const ready = await db
    .select({ id: motionJobs.id })
    .from(motionJobs)
    .where(and(eq(motionJobs.postId, postId), inArray(motionJobs.kind, ["render", "gif"]), eq(motionJobs.status, "ready")))
    .orderBy(desc(motionJobs.finishedAt), desc(motionJobs.createdAt));
  let removed = 0;
  for (const { id } of ready.slice(config.VIDEO_KEEP_RENDERS_PER_POST)) if ((await deleteJobRow(id)).deleted) removed++;
  return removed;
}

export interface RetentionReport {
  previews: number;
  renders: number;
  failed: number;
  orphanDirs: number;
}

export async function runRetention(now: Date = new Date()): Promise<RetentionReport> {
  const report: RetentionReport = { previews: 0, renders: 0, failed: 0, orphanDirs: 0 };
  // 1) ko'riklar: muddati o'tganlari
  const expired = await db.select({ id: motionJobs.id }).from(motionJobs).where(and(eq(motionJobs.kind, "preview"), isNotNull(motionJobs.expiresAt), lt(motionJobs.expiresAt, now), ne(motionJobs.status, "running")));
  for (const { id } of expired) if ((await deleteJobRow(id)).deleted) report.previews++;
  // 2) har bir postda oxirgi N ta render
  const postIds = await db.selectDistinct({ postId: motionJobs.postId }).from(motionJobs).where(and(isNotNull(motionJobs.postId), inArray(motionJobs.kind, ["render", "gif"]), eq(motionJobs.status, "ready")));
  for (const { postId } of postIds) if (postId) report.renders += await pruneRendersForPost(postId);
  // 3) postsiz (post o'chirilgan) tayyor renderlar va muvaffaqiyatsiz/bekor qilinganlar: TTL
  const cutoff = new Date(now.getTime() - config.VIDEO_FAILED_TTL_DAYS * DAY_MS);
  const stale = await db
    .select({ id: motionJobs.id, status: motionJobs.status })
    .from(motionJobs)
    .where(and(lt(motionJobs.createdAt, cutoff), or(inArray(motionJobs.status, ["failed", "cancelled"]), and(eq(motionJobs.status, "ready"), sql`${motionJobs.postId} is null`, ne(motionJobs.kind, "preview")))));
  for (const { id, status } of stale) {
    if (!(await deleteJobRow(id)).deleted) continue;
    if (status === "ready") report.renders++;
    else report.failed++;
  }
  // 4) kvota hisobining eski qatorlari (kunlik oynadan tashqari)
  await db.delete(motionUsage).where(lt(motionUsage.createdAt, new Date(now.getTime() - 2 * DAY_MS)));
  // 5) yetim yuklash papkalari va ish qatori yo'q saqlash obyektlari
  report.orphanDirs += await sweepRunnerOrphans(now);
  // 6) yetim ish papkalari (hech qaysi ish ishlamayotgan paytdagi qoldiqlar)
  try {
    const activeIds = new Set(running);
    for (const name of readdirSync(jobsRoot())) {
      if (activeIds.has(name)) continue;
      const age = now.getTime() - statSync(path.join(jobsRoot(), name)).mtimeMs;
      if (age > 30 * 60_000) {
        rmSync(path.join(jobsRoot(), name), { recursive: true, force: true });
        report.orphanDirs++;
      }
    }
  } catch {
    // papka yo'q
  }
  return report;
}

// --------------------------------------------------------------------------- startup recovery

export interface RecoveryReport {
  failedRunning: number;
  killedStale: number;
  sweptDirs: number;
}

/**
 * API ishga tushganda: `running` holatida qolgan ishlar (oldingi jarayon qulagan/to'xtagan) `failed` — aniq sababi bilan; qolib ketgan
 * ishchi guruhlari o'ldiriladi; ish papkalari tozalanadi. Ishchi hali ishlamagan `queued` ishlar navbatda qoladi.
 */
export async function recoverVideoJobs(): Promise<RecoveryReport> {
  // GitHub-backed jobs keep all their state in the database and the run lives on GitHub: a restart loses nothing, so they are NOT
  // failed here (the watchdog still enforces their deadlines). Only jobs whose worker lived inside the previous API process are orphans.
  const orphanWhere = and(eq(motionJobs.status, "running"), or(isNull(motionJobs.runner), ne(motionJobs.runner, "github")));
  const orphans = await db.select({ id: motionJobs.id, pid: motionJobs.workerPid }).from(motionJobs).where(orphanWhere);
  let killedStale = 0;
  for (const o of orphans) if (o.pid && (await killStaleWorker(o.pid))) killedStale++;
  if (orphans.length > 0) {
    const failed = await db
      .update(motionJobs)
      .set({ status: "failed", errorCode: "interrupted", errorMessage: MESSAGES.interrupted, finishedAt: new Date(), workerPid: null, phase: null })
      .where(orphanWhere)
      .returning();
    for (const row of failed) await auditOutcome(row);
  }
  let sweptDirs = 0;
  try {
    for (const name of readdirSync(jobsRoot())) {
      rmSync(path.join(jobsRoot(), name), { recursive: true, force: true });
      sweptDirs++;
    }
  } catch {
    // papka hali yo'q
  }
  return { failedRunning: orphans.length, killedStale, sweptDirs };
}

/** API to'xtaganda: ishlayotgan ishlarni bekor qiladi (ishchi guruhlari `runner`da o'ldiriladi). */
export function abortAllRunning(): number {
  for (const ac of controllers.values()) ac.abort();
  return controllers.size;
}

export const runningJobCount = (): number => running.size;

/** Preview uchun: kutish o'rniga "band" deb javob berish kerakmi. */
export async function previewQueueState(): Promise<{ busy: boolean; running: number; queued: number }> {
  const q = await queueCounts();
  // Only the local backend (one machine, one job at a time) answers "busy"; GitHub runners are separate machines, a preview just queues.
  return { busy: config.VIDEO_RUNNER === "local" && q.running + q.queued > 0, ...q };
}

/** Ish tugaguncha (yoki `budgetMs` o'tguncha) kutadi. */
export async function awaitJob(id: string, budgetMs: number): Promise<{ row: JobRow; assets: AssetRow[] } | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const found = await getJob(id);
    if (!found) return null;
    if (found.row.status !== "queued" && found.row.status !== "running") return found;
    if (Date.now() >= deadline) return found;
    await new Promise((r) => setTimeout(r, 300));
  }
}

export const countCreatedToday = async (): Promise<{ renders: number; previews: number }> => {
  const since = new Date(Date.now() - DAY_MS);
  return { renders: await usedSince(db, "render", since), previews: await usedSince(db, "preview", since) };
};

/**
 * Yetim qoldiqlar: (1) yuklash papkalari — ishi yo'q yoki endi `running` GitHub ishi bo'lmagan va 30 daqiqadan eski;
 * (2) saqlash qatlamidagi `video/` obyektlari — hech bir `motion_assets` qatoriga tegishli bo'lmagan va 1 soatdan eski
 * (yakunlash tranzaksiyasi yiqilgan bo'lsa qoladi), shuningdek `.tmp-` qoldiqlari.
 */
export async function sweepRunnerOrphans(now: Date = new Date()): Promise<number> {
  let removed = 0;
  const active = new Set((await db.select({ id: motionJobs.id }).from(motionJobs).where(and(eq(motionJobs.status, "running"), eq(motionJobs.runner, "github")))).map((r) => r.id));
  for (const d of listUploadDirs()) {
    if (active.has(d.jobId) || d.ageMs < 30 * 60_000) continue;
    removeUploads(d.jobId);
    removed++;
  }
  try {
    const known = new Set((await db.select({ key: motionAssets.key }).from(motionAssets)).map((r) => r.key));
    for (const o of await listStoredObjects("video/")) {
      if (known.has(o.key) || now.getTime() - o.modifiedAt.getTime() < 60 * 60_000) continue;
      await deleteStoredFile(o.key).catch(() => undefined);
      removed++;
    }
  } catch (error) {
    console.error("Video saqlash qoldiqlarini tozalab bo'lmadi:", error instanceof Error ? error.message : error);
  }
  return removed;
}


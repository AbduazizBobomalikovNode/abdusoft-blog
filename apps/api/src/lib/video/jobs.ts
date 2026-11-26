import { and, asc, count, desc, eq, gte, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { mkdirSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { MotionAsset, MotionJob, MotionJobDetail, MotionJobKind } from "@blog/shared";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import { motionAssets, motionJobs, posts } from "../../db/schema.js";
import { recordAuditSafe } from "../audit.js";
import { deleteStoredFile, storeFileFromPath } from "../media/store.js";
import { fail, ok, type Actor, type ServiceResult } from "../posts/types.js";
import { loadMotion, type MotionTimeline, type StoryboardIssue } from "./motion.js";
import { cacheDirOf, dataDir, jobDirOf, jobsRoot, motionDir } from "./paths.js";
import { probeResources } from "./resources.js";
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
/** Faqat testlar uchun. */
export const setKillMarginForTests = (ms: number): void => {
  killMarginMs = ms;
};

/** Ko'rik vositasi ishni kutadigan eng uzun vaqt (240 soniyalik vosita chegarasidan ancha past). */
let previewWaitOverrideMs: number | null = null;
export const previewWaitMs = (): number => previewWaitOverrideMs ?? Math.min(PREVIEW_MAX_SECONDS, config.VIDEO_PREVIEW_TIMEOUT_SECONDS) * 1000 + 30_000;
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

async function createdSince(kinds: MotionJobKind[], since: Date): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(motionJobs)
    .where(and(inArray(motionJobs.kind, kinds), gte(motionJobs.createdAt, since)));
  return r?.n ?? 0;
}

export async function queueCounts(): Promise<{ queued: number; running: number }> {
  const rows = await db.select({ status: motionJobs.status, n: count() }).from(motionJobs).where(inArray(motionJobs.status, ["queued", "running"])).groupBy(motionJobs.status);
  return { queued: rows.find((r) => r.status === "queued")?.n ?? 0, running: rows.find((r) => r.status === "running")?.n ?? 0 };
}

/** Quotas, one active job per post, queue length and server resources. Every refusal names what to do. */
export async function checkQuotas(kind: MotionJobKind, postId: string | null): Promise<ServiceResult<null>> {
  const since = new Date(Date.now() - DAY_MS);
  if (kind !== "preview" && postId) {
    const [active] = await db
      .select({ id: motionJobs.id })
      .from(motionJobs)
      .where(and(eq(motionJobs.postId, postId), inArray(motionJobs.kind, ["render", "gif"]), inArray(motionJobs.status, ["queued", "running"])))
      .limit(1);
    if (active) return fail("conflict", "Bu post uchun video allaqachon navbatda yoki tayyorlanmoqda", { code: "post_busy", activeJobId: active.id, hint: "Wait for it to finish or cancel it (cancel_video_job), then start again." });
  }
  const q = await queueCounts();
  if (q.queued >= config.VIDEO_MAX_QUEUE) {
    return fail("rate_limited", "Video navbati to'la", { code: "queue_full", queued: q.queued, limit: config.VIDEO_MAX_QUEUE, retryAfterSeconds: 60, hint: "Wait for the running jobs to finish (get_video_job) and try again in a minute." });
  }
  if (kind === "preview") {
    const limit = config.VIDEO_MAX_PREVIEWS_PER_DAY;
    if (limit > 0 && (await createdSince(["preview"], since)) >= limit) {
      return fail("rate_limited", "Bugungi ko'rik (preview) chegarasiga yetildi", { code: "daily_previews", limit, env: "VIDEO_MAX_PREVIEWS_PER_DAY", retryAfterSeconds: 3600, hint: "Use validate_storyboard (free) to check the storyboard, or try again later; the owner can raise VIDEO_MAX_PREVIEWS_PER_DAY." });
    }
  } else {
    const limit = config.VIDEO_MAX_RENDERS_PER_DAY;
    if (limit > 0 && (await createdSince(["render", "gif"], since)) >= limit) {
      return fail("rate_limited", "Bugungi video render chegarasiga yetildi", { code: "daily_renders", limit, env: "VIDEO_MAX_RENDERS_PER_DAY", retryAfterSeconds: 3600, hint: "Renders are capped per rolling 24 hours; try later, or the owner can raise VIDEO_MAX_RENDERS_PER_DAY." });
    }
  }
  const res = probeResources();
  if (res.freeDiskMb !== null && res.freeDiskMb < config.VIDEO_MIN_FREE_DISK_MB) {
    return fail("rate_limited", "Serverda bo'sh disk yetarli emas", { code: "low_disk", freeDiskMb: res.freeDiskMb, minFreeDiskMb: config.VIDEO_MIN_FREE_DISK_MB, retryAfterSeconds: 600, hint: "The server is low on disk space. Ask the owner to free space (or lower VIDEO_MIN_FREE_DISK_MB)." });
  }
  if (res.freeMemoryMb !== null && res.freeMemoryMb < config.VIDEO_MIN_FREE_MEMORY_MB) {
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
  /** Already validated by the caller (saves a second validation). */
  validated?: ValidatedStoryboard;
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

  const quota = await checkQuotas(input.kind, input.postId ?? null);
  if (!quota.ok) return quota;

  const [row] = await db
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

  await recordAuditSafe(actor, {
    action: input.kind === "preview" ? "video.preview" : "video.render",
    entityType: "video",
    entityId: row.id,
    summary: input.kind === "preview" ? "Video ko'rik kadrlari so'raldi" : input.kind === "gif" ? "GIF render boshlandi" : "Video render boshlandi",
    meta: { kind: input.kind, postId: input.postId ?? null, seconds: Math.round(timeline.totalSeconds * 10) / 10, scenes: timeline.scenes.length },
  });
  kickQueue();
  return ok(toJobDetail(row, [], await queuePositionOf(row)));
}

// --------------------------------------------------------------------------- queue / execution

const running = new Set<string>();
const controllers = new Map<string, AbortController>();
let ticking = false;
let idleWaiters: Array<() => void> = [];

export const kickQueue = (): void => {
  void tickQueue().catch((e: unknown) => console.error("Video navbati xatosi:", e instanceof Error ? e.message : e));
};

/** Atomik "claim": `queued -> running`. Bir vaqtda ishlayotganlar soni `VIDEO_MAX_RUNNING`dan oshmaydi. Ko'riklar oldin. */
export async function claimNextJob(): Promise<JobRow | null> {
  const [row] = await db
    .update(motionJobs)
    .set({ status: "running", startedAt: new Date(), progress: 0, phase: "starting", message: "starting" })
    .where(
      and(
        eq(
          motionJobs.id,
          sql`(select id from motion_jobs where status = 'queued' order by (kind = 'preview') desc, created_at asc limit 1 for update skip locked)`,
        ),
        eq(motionJobs.status, "queued"),
        sql`(select count(*) from motion_jobs where status = 'running') < ${config.VIDEO_MAX_RUNNING}`,
      ),
    )
    .returning();
  return row ?? null;
}

export async function tickQueue(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await failStaleQueued();
    while (running.size < config.VIDEO_MAX_RUNNING) {
      const res = probeResources();
      const lowMem = res.freeMemoryMb !== null && res.freeMemoryMb < config.VIDEO_MIN_FREE_MEMORY_MB;
      const lowDisk = res.freeDiskMb !== null && res.freeDiskMb < config.VIDEO_MIN_FREE_DISK_MB;
      if (lowMem || lowDisk) break; // jobs wait in the queue; the blog comes first
      const job = await claimNextJob();
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

function phasePercent(phase: string, fraction: number | null): number {
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
  browser_missing: "The headless browser is not installed on the server. The owner must run scripts/setup-motion-browser.sh once.",
  interrupted: "The API server restarted while this job was running. Start it again.",
  storage_failed: "The result could not be saved to the media storage.",
  invalid_storyboard: "The storyboard did not pass validation inside the render worker.",
};

async function fail_(id: string, code: string, message: string | undefined, timings: Record<string, number>): Promise<void> {
  await db
    .update(motionJobs)
    .set({ status: "failed", errorCode: code, errorMessage: message ? safeMessage(message) : (MESSAGES[code] ?? "The render failed."), finishedAt: new Date(), timings, workerPid: null, phase: null })
    .where(and(eq(motionJobs.id, id), eq(motionJobs.status, "running")));
}

async function execute(job: JobRow): Promise<void> {
  const ac = new AbortController();
  controllers.set(job.id, ac);
  const jobDir = jobDirOf(job.id);
  const queueMs = job.startedAt ? job.startedAt.getTime() - job.createdAt.getTime() : 0;
  const timings: Record<string, number> = { queueMs };
  try {
    // 3rd validation: before a worker is started (untrusted input, stored data is not trusted either).
    const checked = await validateInput(job.storyboard);
    if (!checked.ok) return await fail_(job.id, "invalid_storyboard", undefined, timings);
    const [fresh] = await db.select({ cancelRequested: motionJobs.cancelRequested }).from(motionJobs).where(eq(motionJobs.id, job.id)).limit(1);
    if (fresh?.cancelRequested) {
      await db.update(motionJobs).set({ status: "cancelled", finishedAt: new Date(), timings }).where(and(eq(motionJobs.id, job.id), eq(motionJobs.status, "running")));
      return;
    }
    mkdirSync(path.join(jobDir, "out"), { recursive: true });
    mkdirSync(cacheDirOf(), { recursive: true });
    const storyboardFile = path.join(jobDir, "storyboard.json");
    writeFileSync(storyboardFile, JSON.stringify(checked.value.storyboard));
    const options = job.options as JobOptions;
    const spec: WorkerSpec = {
      kind: job.kind,
      storyboardFile,
      outDir: path.join(jobDir, "out"),
      cacheDir: cacheDirOf(),
      concurrency: config.VIDEO_CONCURRENCY,
      ...(job.kind === "preview" ? { width: previewWidthOf(options), ...(options.at ? { at: options.at.slice(0, PREVIEW_MAX_STILLS) } : {}) } : { outName: job.kind === "gif" ? "clip.gif" : "video.mp4" }),
      ...(options.scene !== undefined ? { scene: options.scene } : {}),
      ...(job.kind === "gif" ? { ...(options.from !== undefined ? { from: options.from } : {}), ...(options.to !== undefined ? { to: options.to } : {}), ...(options.loop ? { loop: true } : {}) } : {}),
      ...(config.VIDEO_BROWSER_PATH ? { browserExecutable: config.VIDEO_BROWSER_PATH } : {}),
    };
    const timeoutMs = (job.kind === "preview" ? Math.min(PREVIEW_MAX_SECONDS, config.VIDEO_PREVIEW_TIMEOUT_SECONDS) : config.VIDEO_RENDER_TIMEOUT_SECONDS) * 1000;
    spec.timeoutMs = timeoutMs;

    let lastWrite = 0;
    let lastPhase = "";
    const report: RunReport = await runWorker({
      jobId: job.id,
      spec,
      timeoutMs: timeoutMs + killMarginMs,
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
    if (o.outcome === "timeout") return await fail_(job.id, "timeout", undefined, timings);
    if (o.outcome === "memory") return await fail_(job.id, "memory", `The render used more than ${config.VIDEO_WORKER_MEMORY_MB} MB (peak ${o.peakRssMb} MB) and was stopped.`, timings);
    if (o.outcome === "crashed") return await fail_(job.id, "crashed", o.message, timings);
    if (o.outcome === "error") return await fail_(job.id, o.code, o.code === "browser_missing" ? MESSAGES.browser_missing : o.message, timings);
    await finishWithResult(job, o.result, jobDir, timings);
  } catch (error) {
    console.error(`Video ishi (${job.id}) kutilmagan xato:`, error instanceof Error ? error.message : error);
    await fail_(job.id, "internal_error", "The render failed unexpectedly. See the server log.", timings);
  } finally {
    controllers.delete(job.id);
    rmSync(jobDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

/** Natija fayllarini saqlash qatlamiga yuklaydi (hajm chegaralari bilan) va ishni `ready` qiladi. */
async function finishWithResult(job: JobRow, result: Extract<Awaited<ReturnType<typeof runWorker>>["outcome"], { outcome: "result" }>["result"], jobDir: string, timings: Record<string, number>): Promise<void> {
  const outRoot = path.resolve(jobDir, "out") + path.sep;
  const inside = (file: string): boolean => path.resolve(file).startsWith(outRoot);
  const stored: Array<typeof motionAssets.$inferInsert> = [];
  const storedKeys: string[] = [];
  try {
    if (result.kind === "preview") {
      for (const s of result.stills) {
        if (!inside(s.file)) throw new Error("worker reported a file outside its output directory");
        const size = statSync(s.file).size;
        if (size > config.VIDEO_MAX_STILL_BYTES) return await fail_(job.id, "too_large", `A preview frame is ${size} bytes; the limit is ${config.VIDEO_MAX_STILL_BYTES}.`, timings);
        const up = await storeFileFromPath({ path: s.file, ext: "jpg", mime: "image/jpeg" });
        storedKeys.push(up.key);
        stored.push({ jobId: job.id, kind: "still", key: up.key, url: up.url, mime: "image/jpeg", size: up.size, width: previewWidthOf(job.options as JobOptions), height: Math.round((previewWidthOf(job.options as JobOptions) * 9) / 16), seconds: s.seconds, sceneIndex: s.scene, sceneType: s.sceneType });
      }
    } else {
      if (!inside(result.file)) throw new Error("worker reported a file outside its output directory");
      const size = statSync(result.file).size;
      const limit = result.kind === "gif" ? config.VIDEO_MAX_GIF_BYTES : config.VIDEO_MAX_MP4_BYTES;
      if (size > limit) return await fail_(job.id, "too_large", `The ${result.kind === "gif" ? "GIF" : "MP4"} is ${Math.round(size / 1024 / 1024)} MB; the limit is ${Math.round(limit / 1024 / 1024)} MB. Shorten the storyboard.`, timings);
      timings.renderMs = result.renderMs;
      const mime = result.kind === "gif" ? "image/gif" : "video/mp4";
      const up = await storeFileFromPath({ path: result.file, ext: result.kind === "gif" ? "gif" : "mp4", mime });
      storedKeys.push(up.key);
      stored.push({ jobId: job.id, kind: result.kind === "gif" ? "gif" : "mp4", key: up.key, url: up.url, mime, size: up.size, width: result.kind === "gif" ? 800 : 1920, height: result.kind === "gif" ? 450 : 1080, seconds: result.seconds });
    }
  } catch (error) {
    await Promise.all(storedKeys.map((k) => deleteStoredFile(k).catch(() => undefined)));
    console.error(`Video natijasini saqlashda xatolik (${job.id}):`, error instanceof Error ? error.message : error);
    return await fail_(job.id, "storage_failed", undefined, timings);
  }
  const updated = await db.transaction(async (tx) => {
    const [cur] = await tx.select({ status: motionJobs.status }).from(motionJobs).where(eq(motionJobs.id, job.id)).limit(1);
    if (!cur || cur.status !== "running") return false; // deleted or settled meanwhile
    await tx.insert(motionAssets).values(stored);
    await tx.update(motionJobs).set({ status: "ready", progress: 100, phase: "done", message: "ready", finishedAt: new Date(), timings, workerPid: null }).where(eq(motionJobs.id, job.id));
    return true;
  });
  if (!updated) {
    await Promise.all(storedKeys.map((k) => deleteStoredFile(k).catch(() => undefined)));
    return;
  }
  if (job.postId && job.kind !== "preview") await pruneRendersForPost(job.postId).catch(() => undefined);
}

// --------------------------------------------------------------------------- cancel / delete

export async function cancelJob(actor: Actor, id: string): Promise<ServiceResult<MotionJobDetail>> {
  const found = await getJob(id);
  if (!found) return fail("not_found", "Video ishi topilmadi", { code: "job_not_found" });
  const { row } = found;
  if (row.status === "queued") {
    await db.update(motionJobs).set({ status: "cancelled", finishedAt: new Date(), cancelRequested: true }).where(and(eq(motionJobs.id, id), eq(motionJobs.status, "queued")));
  } else if (row.status === "running") {
    await db.update(motionJobs).set({ cancelRequested: true }).where(eq(motionJobs.id, id));
    const ac = controllers.get(id);
    if (ac) ac.abort();
    else await db.update(motionJobs).set({ status: "cancelled", finishedAt: new Date() }).where(and(eq(motionJobs.id, id), eq(motionJobs.status, "running"))); // not ours (stale row)
  } else {
    return fail("conflict", "Bu ish allaqachon tugagan", { code: "job_finished", status: row.status, hint: "Only queued or running jobs can be cancelled; use delete_video_job to remove a finished one." });
  }
  await recordAuditSafe(actor, { action: "video.cancel", entityType: "video", entityId: id, summary: "Video ishi bekor qilindi", meta: { kind: row.kind, wasStatus: row.status } });
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
  // 4) yetim ish papkalari (hech qaysi ish ishlamayotgan paytdagi qoldiqlar)
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
  const orphans = await db.select({ id: motionJobs.id, pid: motionJobs.workerPid }).from(motionJobs).where(eq(motionJobs.status, "running"));
  let killedStale = 0;
  for (const o of orphans) if (o.pid && (await killStaleWorker(o.pid))) killedStale++;
  if (orphans.length > 0) {
    await db
      .update(motionJobs)
      .set({ status: "failed", errorCode: "interrupted", errorMessage: MESSAGES.interrupted, finishedAt: new Date(), workerPid: null, phase: null })
      .where(eq(motionJobs.status, "running"));
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
  return { busy: q.running + q.queued > 0, ...q };
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
  return { renders: await createdSince(["render", "gif"], since), previews: await createdSince(["preview"], since) };
};


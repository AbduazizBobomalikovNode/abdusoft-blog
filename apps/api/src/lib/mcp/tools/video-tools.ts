import { z } from "zod";
import { config } from "../../../config.js";
import { readStoredFile } from "../../media/store.js";
import { loadMotion, type MotionApi, type MotionTimeline, type StoryboardIssue } from "../../video/motion.js";
import {
  PREVIEW_MAX_SECONDS,
  PREVIEW_MAX_STILLS,
  awaitJob,
  cancelJob,
  createJob,
  deleteJob,
  estimateSeconds,
  findScene,
  getJob,
  gifWindowSeconds,
  listJobs,
  previewQueueState,
  previewWaitMs,
  toJobDetail,
  toJobDto,
  validateInput,
  checkQuotas,
  type JobOptions,
} from "../../video/jobs.js";
import { videoStatus } from "../../video/status.js";
import { withIdempotency } from "../idempotency.js";
import { ToolError, defineTool, unwrap as unwrapService, type McpToolDef, type ToolImage } from "./types.js";
import { fail, type ServiceResult } from "../../posts/types.js";
import { idempotencyKeyField, uuidField } from "./write-support.js";
import { UNTRUSTED_DESCRIPTION_PREFIX as U, untrusted } from "./untrusted.js";

/** Xizmat xatosidagi `code` (masalan `post_busy`) xato `code`ini bosib ketmasligi uchun `reason` deb nomlanadi. */
function unwrap<T>(result: ServiceResult<T>, hints: { notFound?: string } = {}): T {
  if (!result.ok && typeof result.error.extra?.code === "string") {
    const { code, ...rest } = result.error.extra;
    return unwrapService(fail(result.error.kind, result.error.message, { ...rest, reason: code }), hints);
  }
  return unwrapService(result, hints);
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const ADDITIVE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const STATE_CHANGE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

export const VIDEO_SCOPE = "video:render";

/**
 * Connector results are capped (`ctx.limits.resultMaxChars`, ~150 000 characters) for text AND inline images together.
 * Images get what is left after the text, minus a safety margin; paging continues through `image_offset`.
 */
export const IMAGE_MARGIN_CHARS = 6_000;
/** The echoed storyboard (include_storyboard) is capped so it can never starve the images or the limit. */
export const STORYBOARD_ECHO_MAX_CHARS = 24_000;

/** Characters left for base64 images once the text part (`data`, with room for the frame notes) is accounted for. */
export function imageBudgetChars(resultMaxChars: number, data: Record<string, unknown>, frameCount: number): number {
  const text = JSON.stringify(data).length + frameCount * 320 + 800;
  return Math.max(0, resultMaxChars - text - IMAGE_MARGIN_CHARS);
}

const storyboardField = z
  .record(z.string(), z.unknown())
  .describe("The storyboard: ONE JSON object (version 1) written by you - pure data, no code. Call get_storyboard_guide first for the schema, limits and an example.");

const issuesOf = (issues: StoryboardIssue[]) => issues.map((i) => ({ path: i.path, code: i.code, message: i.message, ...(i.suggestion ? { fix: i.suggestion } : {}), ...(i.limit !== undefined ? { limit: i.limit } : {}), ...(i.actual !== undefined ? { actual: i.actual } : {}) }));

function timelineSummary(timeline: MotionTimeline) {
  return {
    totalSeconds: Math.round(timeline.totalSeconds * 10) / 10,
    totalFrames: timeline.totalFrames,
    fps: timeline.fps,
    size: `${timeline.width}x${timeline.height}`,
    scenes: timeline.scenes.map((s) => ({
      position: s.index + 1,
      ...(s.id ? { id: s.id } : {}),
      type: s.type,
      startSeconds: Math.round((s.startFrame / timeline.fps) * 100) / 100,
      endSeconds: Math.round((s.endFrame / timeline.fps) * 100) / 100,
      durationSeconds: Math.round((s.durationFrames / timeline.fps) * 100) / 100,
      explicitDuration: s.explicit,
    })),
  };
}

// --------------------------------------------------------------------------- guide

const SCENE_NOTES: Record<string, string> = {
  intro: "Animated opener (variant: aurora | blueprint | constellation | boot | signal | slam). Use as the first scene.",
  closing: "Animated closer with call to action and URL text (same six variants). Use as the last scene; its final hold loops (good for a GIF).",
  title: "Plain title card (layout left | centered | split).",
  bullets: "Heading with 1-6 short bullets revealed one by one.",
  code: "Code block (max 14 lines of 72 chars) with highlight steps; set `typing` for a typewriter effect.",
  codeDiff: "Unified-style diff (lines start with +, - or a space).",
  terminal: "Terminal window: typed commands and printed output.",
  diagram: "Boxes and arrows (2-8 nodes, up to 12 edges), optionally revealed step by step.",
  compare: "Two columns (before/after, A/B) with a verdict line.",
  stat: "1-3 animated numbers with labels.",
  steps: "2-6 numbered steps.",
  quote: "A quotation with author and role.",
  outro: "Simple end card (cta + url); prefer `closing` for a livelier look.",
};

const EXAMPLE = {
  version: 1,
  title: "Zod bilan API chegarasi",
  theme: "dark",
  preset: "default",
  scenes: [
    { type: "intro", id: "intro", variant: "aurora", kicker: "TypeScript", title: "Zod bilan API chegarasini himoyalang", subtitle: "Kiruvchi maʼlumotga ishonmang", tags: ["zod", "API"] },
    { type: "bullets", id: "why", heading: "Nega chegarada tekshiramiz?", items: ["Tashqi maʼlumot gumonli", "Turlar ish vaqtida yoʻq", "Bitta sxema: tekshiruv va tur"] },
    { type: "code", id: "schema", language: "typescript", fileName: "schema.ts", code: 'const Post = z.strictObject({\n  title: z.string().max(80),\n});', steps: [{ lines: { from: 1, to: 3 }, label: "Sxema chegarani tavsiflaydi" }] },
    { type: "closing", id: "bye", variant: "aurora", cta: "Toʻliq maqolani oʻqing", url: "blog.abdusoft.uz" },
  ],
};

export const WORKFLOW = [
  "1. get_storyboard_guide (this) - learn the schema and limits.",
  "2. Write the storyboard (pure JSON data; Uzbek text is fine; no narration - videos are silent).",
  "3. validate_storyboard - instant; returns the exact fixes or the computed timeline. Repeat until valid.",
  "4. preview_storyboard - a few small still frames come back as images; look at them, fix text that does not fit or looks wrong, validate again. It waits at most ~40 s: if the answer is 'still rendering', call get_video_job with the job_id a little later and the frames arrive as images.",
  "5. start_video_render with post_id - returns a job id at once; poll get_video_job every 10-20 s until status is 'ready' (the video is rendered on a GitHub-hosted runner: allow about a minute for it to start, then roughly 2-4 s per video second).",
  "6. Use the MP4/GIF url from get_video_job (attach it, or hand it to distribution). Nothing is published by these tools.",
];

function sceneSchemas(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const items = ((schema.properties as Record<string, { items?: { oneOf?: Array<Record<string, unknown>> } }>).scenes?.items?.oneOf ?? []) as Array<{ properties: { type: { const: string } } } & Record<string, unknown>>;
  return Object.fromEntries(items.map((s) => [s.properties.type.const, s]));
}

async function guide(section: "overview" | "schema" | "scene", sceneType: string | undefined): Promise<Record<string, unknown>> {
  const motion = await loadMotion();
  const schema = motion.storyboardJsonSchema();
  if (section === "schema") return { section, jsonSchema: schema, note: "Full JSON Schema (draft 2020-12) of the storyboard. Unknown keys are rejected." };
  if (section === "scene") {
    const all = sceneSchemas(schema);
    const one = sceneType ? all[sceneType] : undefined;
    if (!one) throw new ToolError("invalid_input", `Unknown scene_type "${sceneType ?? ""}".`, `Use one of: ${motion.SCENE_TYPES.join(", ")}.`);
    return { section, sceneType, jsonSchema: one };
  }
  const all = sceneSchemas(schema);
  return {
    section: "overview",
    workflow: WORKFLOW,
    limits: {
      maxTotalSeconds: motion.LIMITS.maxTotalSeconds,
      maxScenes: motion.LIMITS.maxScenes,
      sceneSeconds: { min: motion.LIMITS.minSceneSeconds, max: motion.LIMITS.maxSceneSeconds },
      maxStoryboardBytes: motion.INPUT_LIMITS.maxStoryboardBytes,
      video: "silent H.264 MP4, 1920x1080 @ 30 fps (landscape only); no narration or audio",
      gif: { maxSeconds: motion.GIF_LIMITS.maxSeconds, maxWidth: motion.GIF_LIMITS.maxWidth, fps: motion.GIF_LIMITS.fps, note: "GIF is for one short scene or window only; use MP4 for the whole video" },
      previewStillsPerCall: PREVIEW_MAX_STILLS,
      text: "Every text field has a character limit (see the scene schemas); code is at most 14 lines of 72 characters; use spaces, not tabs.",
      serverQuotas: { rendersPerDay: config.VIDEO_MAX_RENDERS_PER_DAY, previewsPerDay: config.VIDEO_MAX_PREVIEWS_PER_DAY, maxQueue: config.VIDEO_MAX_QUEUE, onePerPost: "one active render per post" },
    },
    topLevelFields: { version: "must be 1", title: "metadata, max 100 chars", theme: "light | dark", accent: "optional #RRGGBB", preset: `${motion.PRESETS.join(" | ")} (style of every scene)`, siteName: "wordmark, default 'abdusoft'", format: "landscape (only)", defaultTransition: motion.TRANSITIONS.join(" | "), scenes: "1-16 scenes" },
    sceneTypes: motion.SCENE_TYPES.map((type) => ({
      type,
      use: SCENE_NOTES[type] ?? "",
      fields: Object.keys((all[type]?.properties as Record<string, unknown> | undefined) ?? {}).filter((k) => k !== "type"),
      required: (all[type]?.required as string[] | undefined)?.filter((k) => k !== "type") ?? [],
    })),
    introAndClosingVariants: motion.SHOWPIECE_VARIANTS,
    stylePresets: motion.PRESETS,
    transitions: motion.TRANSITIONS,
    codeLanguages: motion.CODE_LANGUAGES,
    example: EXAMPLE,
    tips: [
      "Start with an `intro` and end with a `closing` for the polished look; keep 4-8 scenes and 20-45 seconds.",
      "Omit durationSeconds: scenes get an automatic length from their content. Only set it to hold a scene longer.",
      "Scene `id`s must be unique; use them with preview_storyboard `scene` and with GIFs.",
      "For more detail on one scene type call get_storyboard_guide with section='scene' and scene_type.",
    ],
  };
}

export const getStoryboardGuideTool = defineTool({
  name: "get_storyboard_guide",
  title: "Video storyboard guide",
  description:
    "Everything needed to write a video storyboard for a post: the workflow, limits (60 s, 16 scenes, GIF limits), the list of scene types with their fields, the six intro/closing variants, style presets, transitions, code languages and a compact valid example. " +
    "section='overview' (default, compact), 'scene' (full JSON Schema of one scene_type) or 'schema' (the complete JSON Schema, ~45 KB). The server has no AI: YOU write the storyboard; the server only validates and renders it. No narration or audio. Read-only.",
  scope: "blog:read",
  inputSchema: {
    section: z.enum(["overview", "schema", "scene"]).optional().describe("overview (default) | scene (needs scene_type) | schema (complete JSON Schema)."),
    scene_type: z.string().max(20).optional().describe("With section='scene': one of the scene types from the overview."),
  },
  annotations: READ_ONLY,
  kind: "read",
  async handler(args) {
    return { data: await guide(args.section ?? "overview", args.scene_type) };
  },
});

// --------------------------------------------------------------------------- validate

export const validateStoryboardTool = defineTool({
  name: "validate_storyboard",
  title: "Validate a video storyboard",
  description:
    "Check a storyboard WITHOUT rendering anything (instant, free, nothing is stored). Returns valid:true with the computed timeline (per-scene start/end seconds, total length) and an estimate of the render time, " +
    "or valid:false with precise issues: path, what is wrong, the limit and actual value, and a concrete fix. Fix the issues and call again. Read-only.",
  scope: "blog:read",
  inputSchema: { storyboard: storyboardField },
  annotations: READ_ONLY,
  kind: "read",
  async handler(args) {
    const checked = await validateInput(args.storyboard);
    if (!checked.ok) return { data: { valid: false, issueCount: checked.issues.length, issues: issuesOf(checked.issues), hint: "Fix the listed problems (each has a 'fix') and validate again." }, listKey: "issues" };
    const { timeline } = checked.value;
    const [mp4, prev] = await Promise.all([estimateSeconds("render", timeline.totalSeconds), estimateSeconds("preview", 0, Math.min(timeline.scenes.length, PREVIEW_MAX_STILLS))]);
    return { data: { valid: true, title: checked.value.title, timeline: timelineSummary(timeline), estimate: { renderSeconds: mp4.seconds, previewSeconds: prev.seconds, basis: mp4.basis }, ...untrusted(["title"]) } };
  },
});

// --------------------------------------------------------------------------- images

async function inlineImages(assets: Array<{ key: string; mime: string; url: string; seconds: number | null; sceneIndex: number | null; sceneType: string | null }>, offset: number, budgetChars: number): Promise<{ images: ToolImage[]; frames: Array<Record<string, unknown>>; next: number | null }> {
  const images: ToolImage[] = [];
  const frames: Array<Record<string, unknown>> = [];
  let budget = budgetChars;
  let i = offset;
  for (; i < assets.length; i++) {
    const a = assets[i]!;
    const bytes = await readStoredFile(a.key);
    const b64 = bytes ? bytes.toString("base64") : null;
    const frame = { imageNumber: i + 1, scene: a.sceneIndex !== null ? a.sceneIndex + 1 : null, sceneType: a.sceneType, atSeconds: a.seconds !== null ? Math.round(a.seconds * 100) / 100 : null, url: a.url };
    if (!b64 || b64.length > budget) {
      if (b64 && images.length === 0) {
        // a single frame larger than the whole budget: skip it rather than blow the result limit
        frames.push({ ...frame, inlined: false });
        continue;
      }
      if (!b64) {
        frames.push({ ...frame, inlined: false });
        continue;
      }
      break;
    }
    budget -= b64.length;
    images.push({ data: b64, mimeType: "image/jpeg" });
    frames.push({ ...frame, inlined: true });
  }
  return { images, frames, next: i < assets.length ? i : null };
}

// --------------------------------------------------------------------------- preview

const sceneRef = z.string().min(1).max(40).describe("A scene id or its 1-based position (as a string).");

export const previewStoryboardTool = defineTool({
  name: "preview_storyboard",
  title: "Preview storyboard frames",
  description:
    "Render a handful of small still frames of a storyboard and get them back as IMAGES (plus a short text summary) so you can look at the result and fix it before a full render. " +
    "Choose `at` (seconds, up to 4) or `scene` (4 frames of one scene: start, early, middle, end); with neither you get one representative frame per scene (the first few are inlined; the rest via get_video_job image_offset). " +
    `The preview is rendered on a GitHub-hosted runner, which needs about a minute to start, so this call waits at most ${config.VIDEO_PREVIEW_WAIT_SECONDS} s: when the frames are not ready yet it answers 'still rendering' with the job_id - then call get_video_job with that job_id every 10-20 s and the frames arrive as images (a typical preview is ready after ~1-2 minutes; hard limit ${PREVIEW_MAX_SECONDS} s of rendering). ` +
    "Needs the storyboard to be valid (validate_storyboard first). Counts toward a daily preview quota. Publishes nothing.",
  scope: VIDEO_SCOPE,
  inputSchema: {
    storyboard: storyboardField,
    at: z.array(z.number().min(0).max(60)).min(1).max(4).optional().describe("Seconds into the video to capture (max 4)."),
    scene: sceneRef.optional(),
    width: z.number().int().min(320).max(640).optional().describe("Frame width in px (default 480). Larger frames use more of the result size budget."),
    post_id: uuidField("post id from list_posts").optional().describe("Optional: link the preview to a post (shows in the panel)."),
  },
  annotations: ADDITIVE,
  kind: "write",
  async handler(args, ctx) {
    // Only the optional `local` backend (one machine) answers "busy"; hosted runners are separate machines and previews just queue.
    const state = await previewQueueState();
    if (state.busy) {
      throw new ToolError("rate_limited", "The render machine is busy right now (the server renders one job at a time).", "Try the preview again in about a minute; meanwhile use validate_storyboard. Long renders can take several minutes.", {
        busy: true,
        queue: { running: state.running, queued: state.queued },
        queuePosition: state.queued + state.running + 1,
        retryAfterSeconds: 60,
      });
    }
    const options: JobOptions = { ...(args.at ? { at: args.at } : {}), ...(args.scene !== undefined ? { scene: args.scene } : {}), ...(args.width !== undefined ? { width: args.width } : {}) };
    const created = unwrap(await createJob(ctx.actor, { kind: "preview", storyboard: args.storyboard, postId: args.post_id ?? null, options }), { notFound: "Check the post id with list_posts." });
    const done = await awaitJob(created.id, previewWaitMs());
    if (!done) throw new ToolError("not_found", "The preview job disappeared.");
    const { row, assets } = done;
    if (row.status === "failed" || row.status === "cancelled") {
      throw new ToolError(row.status === "cancelled" ? "conflict" : "unprocessable", `The preview ${row.status}: ${row.errorMessage ?? "no details"}`, row.errorCode === "browser_missing" ? "The owner must install the browser once (scripts/setup-motion-browser.sh)." : "Fix the storyboard or try again.", { jobId: row.id, errorCode: row.errorCode }, ["error.message"]);
    }
    if (row.status !== "ready") {
      return {
        data: {
          ok: true,
          stillRendering: true,
          jobId: row.id,
          status: row.status,
          stage: row.phase,
          progress: row.progress,
          summary: `The preview is still being rendered on the ${config.VIDEO_RUNNER === "github" ? "GitHub-hosted runner (starting one takes about a minute)" : "server"}. Nothing is wrong - this call only waits ${config.VIDEO_PREVIEW_WAIT_SECONDS} s; call get_video_job with this job_id to get the frames when it is ready.`,
          next: `Call get_video_job with job_id "${row.id}" in 10-20 seconds (repeat until status is 'ready'); the preview frames are then attached as images.`,
          ...untrusted([]),
        },
      };
    }
    const stills = assets.filter((a) => a.kind === "still");
    const head = { ok: true, jobId: row.id, renderedMs: (row.timings as { wallMs?: number }).wallMs ?? null };
    const { images, frames, next } = await inlineImages(stills, 0, imageBudgetChars(ctx.limits.resultMaxChars, head, stills.length));
    return {
      images,
      data: {
        ok: true,
        jobId: row.id,
        summary: `${images.length} of ${stills.length} preview frame(s) are attached as images (${options.width ?? 480}px wide). Total storyboard length ${row.durationSeconds.toFixed(1)} s.${next !== null ? ` ${stills.length - next} more frame(s): call get_video_job with job_id and image_offset=${next}.` : ""}`,
        frames,
        moreImagesFrom: next,
        renderedMs: head.renderedMs,
        next: "Look at the images. Fix anything that is cut off, too dense or wrong, validate_storyboard again, then start_video_render when it looks right.",
      },
    };
  },
});

// --------------------------------------------------------------------------- start render

const estimateOf = async (kind: "render" | "gif", seconds: number) => estimateSeconds(kind, seconds);

export const startVideoRenderTool = defineTool({
  name: "start_video_render",
  title: "Start a video render for a post",
  description:
    "Queue a render of a (validated) storyboard for a post and return a job id IMMEDIATELY (it is rendered on a GitHub-hosted runner, which takes about a minute to start; get_video_job shows progress and finally the file URL). " +
    "format 'mp4' (default) renders the whole video (silent H.264, 1920x1080, <= 60 s). format 'gif' renders ONE short clip: give `scene` (id or position; add loop=true on a closing scene for its seamless hold) or from/to seconds - at most 15 s, 800 px wide. " +
    "dry_run=true validates, checks quotas and server resources and returns the duration and an estimated render time without queueing anything. One active render per post; daily render quota and a queue limit apply. " +
    "It never publishes anything and does not attach the video to the post: use the finished URL yourself. Pass idempotency_key so a retry does not queue twice.",
  scope: VIDEO_SCOPE,
  inputSchema: {
    post_id: uuidField("post id from list_posts"),
    storyboard: storyboardField,
    format: z.enum(["mp4", "gif"]).optional().describe("mp4 (default) or gif (one short clip)."),
    scene: sceneRef.optional().describe("gif: the scene to render as a GIF."),
    from_seconds: z.number().min(0).max(60).optional().describe("gif: clip start."),
    to_seconds: z.number().min(0).max(60).optional().describe("gif: clip end (clip is at most 15 s)."),
    loop: z.boolean().optional().describe("gif of a closing scene: only its final seamless hold."),
    dry_run: z.boolean().optional().describe("When true nothing is queued: you get validation, quota status, the duration and an estimated render time."),
    idempotency_key: idempotencyKeyField,
  },
  annotations: ADDITIVE,
  kind: "write",
  async handler(args, ctx) {
    const kind = args.format === "gif" ? "gif" : "render";
    const options: JobOptions = { ...(args.scene !== undefined ? { scene: args.scene } : {}), ...(args.from_seconds !== undefined ? { from: args.from_seconds } : {}), ...(args.to_seconds !== undefined ? { to: args.to_seconds } : {}), ...(args.loop ? { loop: true } : {}) };
    if (kind === "render" && (args.from_seconds !== undefined || args.to_seconds !== undefined || args.loop)) {
      throw new ToolError("invalid_input", "from_seconds, to_seconds and loop apply to format 'gif' only.", "Use format 'gif', or remove them to render the whole video.");
    }
    const checked = await validateInput(args.storyboard);
    if (!checked.ok) {
      throw new ToolError("unprocessable", `The storyboard is not valid (${checked.issues.length} problem(s)); nothing was queued.`, "Fix the issues (each has a fix) and try again; validate_storyboard shows them without side effects.", { issues: issuesOf(checked.issues) });
    }
    const { timeline } = checked.value;
    let clipSeconds = timeline.totalSeconds;
    if (kind === "gif") {
      const w = await gifWindowSeconds(timeline, options);
      if (!w.ok) throw new ToolError("unprocessable", w.message, "A GIF is for one short scene (max 15 s). Render an MP4 for the whole video.");
      clipSeconds = w.seconds;
    } else if (options.scene !== undefined && !findScene(timeline, options.scene)) {
      throw new ToolError("invalid_input", `No scene "${options.scene}" in this storyboard.`, "Use a scene id or its 1-based position.");
    }

    if (args.dry_run) {
      const quota = await checkQuotas(kind, args.post_id);
      const est = await estimateOf(kind, clipSeconds);
      const status = await videoStatus();
      return {
        data: {
          ok: true,
          dryRun: true,
          wouldQueue: quota.ok,
          ...(quota.ok ? {} : { refusal: { code: quota.error.extra?.code ?? null, message: quota.error.message, hint: quota.error.extra?.hint ?? null } }),
          format: kind === "gif" ? "gif" : "mp4",
          videoSeconds: Math.round(clipSeconds * 10) / 10,
          timeline: timelineSummary(timeline),
          estimate: {
            renderSeconds: est.seconds,
            basis: est.basis,
            note:
              status.runner === "github"
                ? "Rendered on a GitHub-hosted runner: starting one adds roughly a minute (not included in renderSeconds); a cold bundle cache adds another 10-25 s."
                : "Starts when it reaches the front of the queue; the first render after a deploy also builds the bundle (+10-25 s).",
          },
          runner: status.runner,
          ...(status.github ? { githubConfigured: status.github.tokenConfigured && status.github.secretConfigured && status.github.repoConfigured } : {}),
          queue: status.queue,
          quotas: status.quotas,
          ...(status.browser ? { browserInstalled: status.browser.installed, ...(status.browser.installed ? {} : { browserHint: status.browser.hint }) } : {}),
          ...(status.local ? { localPreflightOk: status.local.preflightOk } : {}),
        },
      };
    }

    return withIdempotency(ctx, "start_video_render", args.idempotency_key, { ...args, storyboard: JSON.stringify(args.storyboard) }, async () => {
      const created = unwrap(await createJob(ctx.actor, { kind, storyboard: args.storyboard, postId: args.post_id, options, validated: checked.value }), { notFound: "Use list_posts to find a valid post id." });
      const est = await estimateOf(kind, clipSeconds);
      return {
        data: {
          ok: true,
          summary: `Queued (${kind === "gif" ? "GIF" : "MP4"}, ${clipSeconds.toFixed(1)} s of video). Poll get_video_job with this jobId every 10-20 s; allow about a minute for the runner to start, then it is usually ready in about ${Math.max(1, Math.round(est.seconds / 60))}-${Math.max(2, Math.round((est.seconds * 2) / 60))} min.`,
          jobId: created.id,
          status: created.status,
          queuePosition: created.queuePosition,
          estimateSeconds: est.seconds,
          ...untrusted(["job.title"]),
          job: { id: created.id, kind: created.kind, status: created.status, postId: created.postId, title: created.title },
        },
      };
    });
  },
});

// --------------------------------------------------------------------------- read job

const jobId = uuidField("job id from start_video_render, preview_storyboard or list_post_videos");

export const getVideoJobTool = defineTool({
  name: "get_video_job",
  title: "Get a video job",
  description:
    U +
    "Status, progress (0-100), phase and, when finished, the result file URLs of one video job (MP4/GIF: use the url; preview frames: the images). Failed jobs carry a safe errorCode and message. " +
    "For a finished PREVIEW job the frames are attached as images again (paged: image_offset). include_storyboard=true adds the stored storyboard JSON. Read-only; poll every ~10-20 s while status is queued or running.",
  scope: "blog:read",
  inputSchema: {
    job_id: jobId,
    image_offset: z.number().int().min(0).max(50).optional().describe("Preview jobs: index of the first frame to attach (default 0)."),
    include_images: z.boolean().optional().describe("Preview jobs: attach the frames as images (default true)."),
    include_storyboard: z.boolean().optional().describe("Add the stored storyboard JSON (can be long; default false)."),
  },
  annotations: READ_ONLY,
  kind: "read",
  async handler(args, ctx) {
    const found = await getJob(args.job_id);
    if (!found) throw new ToolError("not_found", "No video job with this id.", "Use list_post_videos to find job ids.");
    const detail = toJobDetail(found.row, found.assets, null);
    const dto = toJobDto(found.row, found.assets, null);
    const { storyboard, options: _o, ...job } = detail;
    void _o;
    const storyboardText = args.include_storyboard ? JSON.stringify(storyboard) : "";
    const echoed = args.include_storyboard && storyboardText.length <= STORYBOARD_ECHO_MAX_CHARS;
    const base: Record<string, unknown> = {
      job: { ...job, assets: job.assets.map((a) => ({ id: a.id, kind: a.kind, url: a.url, mime: a.mime, sizeBytes: a.size, seconds: a.seconds, scene: a.sceneIndex !== null ? a.sceneIndex + 1 : null, sceneType: a.sceneType })) },
      ...(echoed ? { storyboard } : {}),
      ...(args.include_storyboard && !echoed ? { storyboardOmitted: { sizeChars: storyboardText.length, limitChars: STORYBOARD_ECHO_MAX_CHARS, hint: "The stored storyboard is too long to echo; read it from the admin panel." } } : {}),
      ...untrusted(["job.title", "job.message", "job.errorMessage", ...(echoed ? ["storyboard"] : [])]),
    };
    if (dto.status === "queued") {
      const state = await previewQueueState();
      (base.job as Record<string, unknown>).queueNote = `${state.running} running, ${state.queued} queued`;
    }
    let images: ToolImage[] | undefined;
    if (dto.kind === "preview" && dto.status === "ready" && args.include_images !== false) {
      const stills = found.assets.filter((a) => a.kind === "still");
      const inline = await inlineImages(stills, args.image_offset ?? 0, imageBudgetChars(ctx.limits.resultMaxChars, base, stills.length - (args.image_offset ?? 0)));
      images = inline.images;
      base.frames = inline.frames;
      base.moreImagesFrom = inline.next;
    }
    base.next =
      dto.status === "ready" ? (dto.kind === "preview" ? "Frames are attached." : "Done: use the asset url (it is public like blog images; nothing was published or attached to the post).") : dto.status === "failed" || dto.status === "cancelled" ? "The job did not finish; see errorCode/errorMessage." : "Not finished yet - poll again in 10-20 seconds.";
    return { data: base, ...(images ? { images } : {}), shrink: [{ key: "storyboard", mode: "drop", note: "storyboard dropped to fit; read it from the admin panel" }] };
  },
});

export const listPostVideosTool = defineTool({
  name: "list_post_videos",
  title: "List a post's videos",
  description: U + "The video jobs (previews, MP4 and GIF renders) of one post, newest first, with status, progress and result URLs. Without post_id: the latest jobs overall. Read-only.",
  scope: "blog:read",
  inputSchema: {
    post_id: uuidField("post id from list_posts").optional(),
    kind: z.enum(["preview", "render", "gif"]).optional(),
    limit: z.number().int().min(1).max(30).optional().describe("Default 10."),
  },
  annotations: READ_ONLY,
  kind: "read",
  async handler(args) {
    const jobs = await listJobs({ ...(args.post_id ? { postId: args.post_id } : {}), ...(args.kind ? { kind: args.kind } : {}), limit: args.limit ?? 10 });
    return {
      data: {
        count: jobs.length,
        jobs: jobs.map((j) => ({
          id: j.id,
          kind: j.kind,
          status: j.status,
          progress: j.progress,
          title: j.title,
          postId: j.postId,
          videoSeconds: Math.round(j.durationSeconds * 10) / 10,
          createdAt: j.createdAt,
          finishedAt: j.finishedAt,
          errorCode: j.errorCode,
          urls: j.assets.filter((a) => a.kind !== "still").map((a) => ({ kind: a.kind, url: a.url, sizeBytes: a.size })),
          frames: j.assets.filter((a) => a.kind === "still").length,
        })),
        ...untrusted(["jobs[].title"]),
      },
      listKey: "jobs",
    };
  },
});

export const getVideoStatusTool = defineTool({
  name: "get_video_status",
  title: "Video service status",
  description: "Is the video service ready: which backend renders (GitHub-hosted runner by default), whether the GitHub token, runner secret and repository are configured (never their values), the time of the last successful run, queue length, how many renders and previews were used today versus the daily caps, and free disk against the minimum. Use it when a render is refused or stuck. Read-only.",
  scope: "blog:read",
  inputSchema: {},
  annotations: READ_ONLY,
  kind: "read",
  async handler() {
    return { data: { ...(await videoStatus()) } };
  },
});

// --------------------------------------------------------------------------- cancel / delete

export const cancelVideoJobTool = defineTool({
  name: "cancel_video_job",
  title: "Cancel a video job",
  description: "Cancel a queued or running video job (a running one is stopped within seconds and its temporary files are removed). Finished jobs cannot be cancelled - use delete_video_job. Nothing else changes.",
  scope: VIDEO_SCOPE,
  inputSchema: { job_id: jobId },
  annotations: STATE_CHANGE,
  kind: "write",
  async handler(args, ctx) {
    const job = unwrap(await cancelJob(ctx.actor, args.job_id), { notFound: "Use list_post_videos to find job ids." });
    return { data: { ok: true, summary: job.status === "cancelled" ? "The job was cancelled." : "Cancellation was requested; the worker is being stopped.", job: { id: job.id, kind: job.kind, status: job.status, cancelRequested: job.cancelRequested } } };
  },
});

export const deleteVideoJobTool = defineTool({
  name: "delete_video_job",
  title: "Delete a video job and its files",
  description:
    "Delete a finished (or queued) video job and its stored files (MP4, GIF, preview frames). Refused while the job is running (cancel it first) and refused while any post still links to one of its files (the error lists the posts) - remove the link from the post first. The files cannot be recovered afterwards.",
  scope: VIDEO_SCOPE,
  inputSchema: { job_id: jobId },
  annotations: DESTRUCTIVE,
  kind: "write",
  async handler(args, ctx) {
    unwrap(await deleteJob(ctx.actor, args.job_id), { notFound: "Use list_post_videos to find job ids." });
    return { data: { ok: true, summary: "The video job and its files were deleted." } };
  },
});

/** Read-only video tools: available whenever `VIDEO_ENABLED=true` (they change nothing). */
export const VIDEO_READ_TOOLS: McpToolDef[] = [getStoryboardGuideTool, validateStoryboardTool, getVideoJobTool, listPostVideosTool, getVideoStatusTool] as unknown as McpToolDef[];

/** Render tools (need the `video:render` permission): only with `VIDEO_ENABLED=true` AND `MCP_WRITE_TOOLS_ENABLED=true`. */
export const VIDEO_WRITE_TOOLS: McpToolDef[] = [previewStoryboardTool, startVideoRenderTool, cancelVideoJobTool, deleteVideoJobTool] as unknown as McpToolDef[];

export type { MotionApi };

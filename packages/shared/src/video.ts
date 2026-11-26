import { z } from "zod";

/** Video render xizmati (admin panel + Claude konnektori) uchun umumiy turlar. */
export const MotionJobKindSchema = z.enum(["preview", "render", "gif"]);
export type MotionJobKind = z.infer<typeof MotionJobKindSchema>;

export const MotionJobStatusSchema = z.enum(["queued", "running", "ready", "failed", "cancelled"]);
export type MotionJobStatus = z.infer<typeof MotionJobStatusSchema>;

export const MotionAssetSchema = z.object({
  id: z.string(),
  kind: z.enum(["mp4", "gif", "still"]),
  url: z.string(),
  mime: z.string(),
  size: z.number(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  seconds: z.number().nullable(),
  sceneIndex: z.number().nullable(),
  sceneType: z.string().nullable(),
});
export type MotionAsset = z.infer<typeof MotionAssetSchema>;

export const MotionJobSchema = z.object({
  id: z.string(),
  kind: MotionJobKindSchema,
  status: MotionJobStatusSchema,
  postId: z.string().nullable(),
  /** Storyboard sarlavhasi (metadata; videoda ko'rinmaydi). */
  title: z.string().nullable(),
  durationSeconds: z.number(),
  progress: z.number(),
  phase: z.string().nullable(),
  message: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  cancelRequested: z.boolean(),
  via: z.string(),
  clientName: z.string().nullable(),
  /** Navbatdagi o'rni (1 — keyingi): faqat `queued` uchun. */
  queuePosition: z.number().nullable(),
  timings: z.record(z.string(), z.number()),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  assets: z.array(MotionAssetSchema),
});
export type MotionJob = z.infer<typeof MotionJobSchema>;

export const MotionJobListSchema = z.object({ items: z.array(MotionJobSchema) });
export type MotionJobList = z.infer<typeof MotionJobListSchema>;

export const MotionJobDetailSchema = MotionJobSchema.extend({
  /** To'liq storyboard JSON (faqat ko'rish uchun). */
  storyboard: z.unknown(),
  options: z.record(z.string(), z.unknown()),
});
export type MotionJobDetail = z.infer<typeof MotionJobDetailSchema>;

export const MotionRunnerKindSchema = z.enum(["github", "local"]);
export type MotionRunnerKind = z.infer<typeof MotionRunnerKindSchema>;

export const MotionStatusSchema = z.object({
  enabled: z.literal(true),
  /** Render qayerda bajariladi (`VIDEO_RUNNER`). */
  runner: MotionRunnerKindSchema,
  /** `github` backend: nima sozlangan (qiymatlar HECH QACHON qaytmaydi) va oxirgi muvaffaqiyatli run vaqti. */
  github: z
    .object({
      tokenConfigured: z.boolean(),
      secretConfigured: z.boolean(),
      repoConfigured: z.boolean(),
      repo: z.string().nullable(),
      /** Dispatch nishoni: workflow fayl nomi va shox. */
      workflow: z.string(),
      ref: z.string(),
      /** Dispatch'ni to'xtatayotgan sozlama xatosi (o'zbekcha, qiymatsiz), masalan blogning o'z repozitoriysi; yo'q bo'lsa `null`. */
      problem: z.string().nullable(),
      lastSuccessAt: z.string().nullable(),
    })
    .nullable(),
  /** `local` backend: `scripts/setup-motion-browser.sh` preflight'i o'tganmi. */
  local: z.object({ preflightOk: z.boolean(), hint: z.string().nullable() }).nullable(),
  /** Faqat `local` backendda: server brauzeri. `github` backendda serverda brauzer tekshirilmaydi (`null`). */
  browser: z.object({ installed: z.boolean(), hint: z.string().nullable() }).nullable(),
  queue: z.object({ queued: z.number(), running: z.number(), maxQueue: z.number(), maxRunning: z.number() }),
  quotas: z.object({
    rendersToday: z.number(),
    maxRendersPerDay: z.number(),
    previewsToday: z.number(),
    maxPreviewsPerDay: z.number(),
  }),
  resources: z.object({ freeDiskMb: z.number().nullable(), freeMemoryMb: z.number().nullable(), minFreeDiskMb: z.number(), minFreeMemoryMb: z.number() }),
});
export type MotionStatus = z.infer<typeof MotionStatusSchema>;

/** Admin panel: GitHub sozlamalari (token faqat maska bilan). */
export const MotionGithubSettingsSchema = z.object({
  token: z.object({ isSet: z.boolean(), masked: z.string(), source: z.enum(["env", "db", "none"]), envVar: z.string(), unreadable: z.boolean() }),
  repo: z.object({ value: z.string(), source: z.enum(["env", "db", "none"]), envVar: z.string() }),
  workflow: z.object({ value: z.string(), source: z.enum(["env", "db", "none"]), envVar: z.string(), default: z.string() }),
  ref: z.object({ value: z.string(), source: z.enum(["env", "db", "none"]), envVar: z.string(), default: z.string() }),
  problem: z.string().nullable(),
});
export type MotionGithubSettings = z.infer<typeof MotionGithubSettingsSchema>;

export const MotionGithubSettingsPatchSchema = z.strictObject({
  githubToken: z.string().max(300).optional(),
  githubRepo: z.string().max(210).optional(),
  githubWorkflow: z.string().max(120).optional(),
  githubRef: z.string().max(120).optional(),
});
export type MotionGithubSettingsPatch = z.infer<typeof MotionGithubSettingsPatchSchema>;

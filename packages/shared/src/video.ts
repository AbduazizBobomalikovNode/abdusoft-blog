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

export const MotionStatusSchema = z.object({
  enabled: z.literal(true),
  browser: z.object({ installed: z.boolean(), hint: z.string().nullable() }),
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

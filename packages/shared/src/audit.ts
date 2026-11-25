import { z } from "zod";

/** Amal qaysi kanaldan bajarilgani (`audit_log.via`, `posts.updated_via`). */
export const ActorViaSchema = z.union([
  z.literal("web"),
  z.literal("mcp"),
  z.literal("telegram"),
  z.literal("scheduler"),
  z.literal("system"),
]);
export type ActorViaValue = z.infer<typeof ActorViaSchema>;

export const AuditActorSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
});
export type AuditActor = z.infer<typeof AuditActorSchema>;

export const AuditLogItemSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  /** Foydalanuvchi yo'q (scheduler/tizim yoki o'chirilgan hisob) bo'lsa `null`. */
  actor: AuditActorSchema.nullable(),
  actorRole: z.string(),
  via: z.string(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  summary: z.string(),
  /** Kichik tavsif (o'zgargan maydonlar, holat from -> to) — kontent yoki sir EMAS. */
  meta: z.record(z.string(), z.unknown()),
});
export type AuditLogItem = z.infer<typeof AuditLogItemSchema>;

/** `YYYY-MM-DD` yoki to'liq ISO sana-vaqt. */
const AuditDateSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: "Noto'g'ri sana" });

export const AuditListQuerySchema = z.object({
  entityType: z.string().trim().min(1).optional(),
  entityId: z.string().trim().min(1).optional(),
  /** Amalni bajargan foydalanuvchi id'si. */
  actor: z.string().trim().min(1).optional(),
  via: ActorViaSchema.optional(),
  action: z.string().trim().min(1).optional(),
  from: AuditDateSchema.optional(),
  to: AuditDateSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(30),
});
export type AuditListQuery = z.infer<typeof AuditListQuerySchema>;

export const AuditListResponseSchema = z.object({
  items: z.array(AuditLogItemSchema),
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  hasMore: z.boolean(),
});
export type AuditListResponse = z.infer<typeof AuditListResponseSchema>;

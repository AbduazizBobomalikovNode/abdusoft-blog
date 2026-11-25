import { z } from "zod";
import { AdminPostStatusSchema, ExpectedUpdatedAtSchema, PostAuthorRefSchema } from "./dto.js";
import { PostSettingsSchema } from "./post-settings.js";

/** Revision ro'yxatidagi qator — kontentsiz (yengil). */
export const PostRevisionListItemSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  /** Suratga sabab bo'lgan yozuvni bajargan foydalanuvchi; scheduler/tizim bo'lsa `null`. */
  createdBy: PostAuthorRefSchema.nullable(),
  via: z.string(),
  /** `update` | `publish` | `unpublish` | `archive` | `schedule` | `trash` | `restore-revision`. */
  reason: z.string(),
  title: z.string(),
  slug: z.string(),
  status: AdminPostStatusSchema,
});
export type PostRevisionListItem = z.infer<typeof PostRevisionListItemSchema>;

export const PostRevisionListResponseSchema = z.object({
  items: z.array(PostRevisionListItemSchema),
});
export type PostRevisionListResponse = z.infer<typeof PostRevisionListResponseSchema>;

/** `POST .../revisions/:rid/restore` tanasi (hammasi ixtiyoriy). */
export const RestoreRevisionBodySchema = z.object({
  expectedUpdatedAt: ExpectedUpdatedAtSchema.optional(),
  /** Chop etilgan/rejalashtirilgan postda ham eski slug'ni qaytarish (standart: joriy slug saqlanadi, URL o'zgarmaydi). */
  restoreSlug: z.boolean().optional(),
});
export type RestoreRevisionBody = z.infer<typeof RestoreRevisionBodySchema>;

export const RestoreRevisionResponseSchema = z.object({
  updatedAt: z.string(),
  /** Tiklashdan keyingi slug. */
  slug: z.string(),
  /** `true` — revision'dagi slug qo'llandi; `false` — joriy slug saqlandi (chop etilgan/rejalashtirilgan post). */
  slugRestored: z.boolean(),
});
export type RestoreRevisionResponse = z.infer<typeof RestoreRevisionResponseSchema>;

/** Bitta revision — kontent bilan. */
export const PostRevisionSchema = PostRevisionListItemSchema.extend({
  excerpt: z.string().nullable(),
  contentJson: z.unknown(),
  coverUrl: z.string().nullable(),
  tagSlugs: z.array(z.string()),
  settings: PostSettingsSchema.partial(),
});
export type PostRevision = z.infer<typeof PostRevisionSchema>;

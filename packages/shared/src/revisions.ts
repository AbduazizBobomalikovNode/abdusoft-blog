import { z } from "zod";
import { AdminPostStatusSchema, PostAuthorRefSchema } from "./dto.js";
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

/** Bitta revision — kontent bilan. */
export const PostRevisionSchema = PostRevisionListItemSchema.extend({
  excerpt: z.string().nullable(),
  contentJson: z.unknown(),
  coverUrl: z.string().nullable(),
  tagSlugs: z.array(z.string()),
  settings: PostSettingsSchema.partial(),
});
export type PostRevision = z.infer<typeof PostRevisionSchema>;

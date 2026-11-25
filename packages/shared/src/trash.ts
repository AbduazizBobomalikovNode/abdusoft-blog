import { z } from "zod";
import { AdminPostListItemSchema, PostAuthorRefSchema } from "./dto.js";

/** Chiqindi qutisidagi post — admin ro'yxati qatori + qachon va kim o'chirgani. */
export const TrashPostListItemSchema = AdminPostListItemSchema.extend({
  deletedAt: z.string(),
  deletedBy: PostAuthorRefSchema.nullable(),
});
export type TrashPostListItem = z.infer<typeof TrashPostListItemSchema>;

export const TrashListResponseSchema = z.object({
  items: z.array(TrashPostListItemSchema),
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  hasMore: z.boolean(),
});
export type TrashListResponse = z.infer<typeof TrashListResponseSchema>;

export const TrashListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});
export type TrashListQuery = z.infer<typeof TrashListQuerySchema>;

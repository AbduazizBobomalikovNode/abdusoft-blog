import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.js";
import { media } from "../../db/schema.js";
import type { Role } from "@blog/shared";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export const MediaListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).default(DEFAULT_LIMIT),
});
export type MediaListQuery = z.infer<typeof MediaListQuerySchema>;

export function toMediaDto(row: typeof media.$inferSelect) {
  return {
    id: row.id,
    key: row.key,
    url: row.url,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    alt: row.alt,
    createdAt: row.createdAt.toISOString(),
  };
}

/** `GET /admin/media` va MCP `list_media`. Xodim (staff) faqat o'zi yuklagan fayllarni ko'radi. */
export async function listMedia(viewer: { id: string; role: Role }, query: MediaListQuery) {
  const { page, limit } = query;
  const offset = (page - 1) * limit;
  const whereClause = viewer.role === "staff" ? eq(media.createdBy, viewer.id) : undefined;

  const [rows, countRows] = await Promise.all([
    db.select().from(media).where(whereClause).orderBy(desc(media.createdAt)).limit(limit).offset(offset),
    db.select({ count: sql<number>`count(*)::int` }).from(media).where(whereClause),
  ]);

  const total = countRows[0]?.count ?? 0;

  return {
    items: rows.map(toMediaDto),
    page,
    limit,
    total,
    hasMore: page * limit < total,
  };
}

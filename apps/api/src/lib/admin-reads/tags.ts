import { asc, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { postTags, posts, tags } from "../../db/schema.js";

/** Teglar + chop etilgan (chiqindi qutisida bo'lmagan) postlar soni. `GET /admin/tags` va MCP `list_tags`. */
export function tagsQuery(idFilter?: string) {
  const base = db
    .select({
      id: tags.id,
      slug: tags.slug,
      name: tags.name,
      description: tags.description,
      color: tags.color,
      postsCount: sql<number>`count(${posts.id}) filter (where ${posts.status} = 'published' and ${posts.deletedAt} is null)::int`,
    })
    .from(tags)
    .leftJoin(postTags, eq(postTags.tagId, tags.id))
    .leftJoin(posts, eq(posts.id, postTags.postId));

  const filtered = idFilter ? base.where(eq(tags.id, idFilter)) : base;
  return filtered.groupBy(tags.id).orderBy(asc(tags.name));
}

import { Hono } from "hono";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { postTags, posts, tags } from "../db/schema.js";

export const tagsRoute = new Hono().get("/", async (c) => {
  const rows = await db
    .select({
      id: tags.id,
      slug: tags.slug,
      name: tags.name,
      description: tags.description,
      color: tags.color,
      postsCount: sql<number>`count(${posts.id}) filter (where ${posts.status} = 'published')::int`,
    })
    .from(tags)
    .leftJoin(postTags, eq(postTags.tagId, tags.id))
    .leftJoin(posts, eq(posts.id, postTags.postId))
    .groupBy(tags.id)
    .orderBy(asc(tags.name));

  return c.json(rows);
});

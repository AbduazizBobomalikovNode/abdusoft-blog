import { Hono, type Context } from "hono";
import { asc, eq, sql } from "drizzle-orm";
import { CreateTagBodySchema, UpdateTagBodySchema, slugify } from "@blog/shared";
import { db } from "../db/index.js";
import { postTags, posts, tags } from "../db/schema.js";
import { requireRole } from "../lib/require-admin.js";

/** Bio `admin-posts.ts`dagi izohga qarang — Hono zanjiri turini saqlab qolish uchun middleware o'rniga handler ichidagi tekshiruv. */
function forbidUnlessAdmin(c: Context): Response | null {
  const adminUser = c.get("adminUser");
  if (adminUser.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  return null;
}

function tagsQuery(idFilter?: string) {
  const base = db
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
    .leftJoin(posts, eq(posts.id, postTags.postId));

  const filtered = idFilter ? base.where(eq(tags.id, idFilter)) : base;
  return filtered.groupBy(tags.id).orderBy(asc(tags.name));
}

export const adminTagsRoute = new Hono()
  .use("*", requireRole("admin", "staff"))
  .get("/", async (c) => {
    const rows = await tagsQuery();
    return c.json(rows);
  })
  .post("/", async (c) => {
    const forbidden = forbidUnlessAdmin(c);
    if (forbidden) return forbidden;
    const body = await c.req.json().catch(() => null);
    const parsed = CreateTagBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);

    const slug = slugify(parsed.data.slug ?? parsed.data.name);
    if (!slug) return c.json({ error: "Slug bo'sh bo'lishi mumkin emas" }, 400);

    const [existing] = await db.select({ id: tags.id }).from(tags).where(eq(tags.slug, slug)).limit(1);
    if (existing) return c.json({ error: `"${slug}" slug allaqachon band` }, 409);

    const [created] = await db
      .insert(tags)
      .values({
        slug,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        color: parsed.data.color ?? null,
      })
      .returning();

    if (!created) return c.json({ error: "Yaratib bo'lmadi" }, 500);
    return c.json({ ...created, postsCount: 0 }, 201);
  })
  .patch("/:id", async (c) => {
    const forbidden = forbidUnlessAdmin(c);
    if (forbidden) return forbidden;
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const parsed = UpdateTagBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);

    const [existingTag] = await db.select().from(tags).where(eq(tags.id, id)).limit(1);
    if (!existingTag) return c.json({ error: "Topilmadi" }, 404);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle partial update payload
    const update: Record<string, any> = {};
    if (parsed.data.name !== undefined) update.name = parsed.data.name;
    if (parsed.data.description !== undefined) update.description = parsed.data.description;
    if (parsed.data.color !== undefined) update.color = parsed.data.color;

    if (parsed.data.slug !== undefined) {
      const clean = slugify(parsed.data.slug);
      if (!clean) return c.json({ error: "Slug bo'sh bo'lishi mumkin emas" }, 400);
      const [conflict] = await db.select({ id: tags.id }).from(tags).where(eq(tags.slug, clean)).limit(1);
      if (conflict && conflict.id !== id) return c.json({ error: `"${clean}" slug allaqachon band` }, 409);
      update.slug = clean;
    }

    if (Object.keys(update).length > 0) {
      await db.update(tags).set(update).where(eq(tags.id, id));
    }

    const [row] = await tagsQuery(id);
    return c.json(row);
  })
  .delete("/:id", async (c) => {
    const forbidden = forbidUnlessAdmin(c);
    if (forbidden) return forbidden;
    const id = c.req.param("id");
    const force = c.req.query("force") === "1";

    const [existingTag] = await db.select().from(tags).where(eq(tags.id, id)).limit(1);
    if (!existingTag) return c.json({ error: "Topilmadi" }, 404);

    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(postTags)
      .where(eq(postTags.tagId, id));
    const postsCount = countRow?.count ?? 0;

    if (postsCount > 0 && !force) {
      return c.json(
        { error: "Teg postlarda ishlatilmoqda — o'chirish uchun ?force=1 qo'shing", postsCount },
        409,
      );
    }

    await db.delete(postTags).where(eq(postTags.tagId, id));
    await db.delete(tags).where(eq(tags.id, id));

    return c.json({ ok: true });
  });

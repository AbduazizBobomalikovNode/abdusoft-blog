import { Hono } from "hono";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { media } from "../db/schema.js";
import { requireRole } from "../lib/require-admin.js";
import { deleteStoredFile, processImage, storeProcessedFile } from "../lib/media/store.js";

const MAX_SIZE = 10 * 1024 * 1024;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

const ListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

const UpdateMediaBodySchema = z.object({
  alt: z.string().nullable(),
});

function toMediaDto(row: typeof media.$inferSelect) {
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

export const adminMediaRoute = new Hono()
  .use("*", requireRole("admin", "staff"))
  .get("/", async (c) => {
    const adminUser = c.get("adminUser");
    const parsed = ListQuerySchema.safeParse({
      page: c.req.query("page"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov parametrlari" }, 400);

    const { page, limit } = parsed.data;
    const offset = (page - 1) * limit;
    // Xodim (staff) faqat o'zi yuklagan media fayllarni ko'radi/tanlaydi.
    const whereClause = adminUser.role === "staff" ? eq(media.createdBy, adminUser.id) : undefined;

    const [rows, countRows] = await Promise.all([
      db.select().from(media).where(whereClause).orderBy(desc(media.createdAt)).limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(media).where(whereClause),
    ]);

    const total = countRows[0]?.count ?? 0;

    return c.json({
      items: rows.map(toMediaDto),
      page,
      limit,
      total,
      hasMore: page * limit < total,
    });
  })
  .post("/", async (c) => {
    const adminUser = c.get("adminUser");
    let body: Record<string, string | File>;
    try {
      body = await c.req.parseBody();
    } catch {
      return c.json({ error: "So'rov tanasini o'qib bo'lmadi" }, 400);
    }

    const file = body.file;
    if (!(file instanceof File)) {
      return c.json({ error: "Fayl talab qilinadi" }, 400);
    }
    if (!file.type.startsWith("image/")) {
      return c.json({ error: "Faqat rasm fayllari qabul qilinadi" }, 400);
    }
    if (file.size > MAX_SIZE) {
      return c.json({ error: "Fayl hajmi 10 MB dan oshmasligi kerak" }, 400);
    }

    const alt = typeof body.alt === "string" && body.alt.length > 0 ? body.alt : null;

    let buffer: Buffer;
    let processed: Awaited<ReturnType<typeof processImage>>;
    try {
      buffer = Buffer.from(await file.arrayBuffer());
      processed = await processImage(buffer, file.type);
    } catch (error) {
      console.error("Rasmni qayta ishlashda xatolik:", error);
      return c.json({ error: "Rasmni qayta ishlab bo'lmadi" }, 400);
    }

    const stored = await storeProcessedFile(processed);

    const [created] = await db
      .insert(media)
      .values({
        key: stored.key,
        url: stored.url,
        mime: processed.mime,
        size: processed.buffer.byteLength,
        width: processed.width,
        height: processed.height,
        alt,
        createdBy: adminUser.id,
      })
      .returning();

    if (!created) return c.json({ error: "Yuklab bo'lmadi" }, 500);

    return c.json(toMediaDto(created), 201);
  })
  .patch("/:id", async (c) => {
    const adminUser = c.get("adminUser");
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const parsed = UpdateMediaBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);

    const [existing] = await db.select({ createdBy: media.createdBy }).from(media).where(eq(media.id, id)).limit(1);
    if (!existing) return c.json({ error: "Topilmadi" }, 404);
    if (adminUser.role === "staff" && existing.createdBy !== adminUser.id) {
      return c.json({ error: "Faqat o'zingiz yuklagan fayllarni o'zgartira olasiz" }, 403);
    }

    const [updated] = await db
      .update(media)
      .set({ alt: parsed.data.alt })
      .where(eq(media.id, id))
      .returning();

    if (!updated) return c.json({ error: "Topilmadi" }, 404);
    return c.json(toMediaDto(updated));
  })
  .delete("/:id", async (c) => {
    const adminUser = c.get("adminUser");
    const id = c.req.param("id");
    const [row] = await db.select().from(media).where(eq(media.id, id)).limit(1);
    if (!row) return c.json({ error: "Topilmadi" }, 404);
    if (adminUser.role === "staff" && row.createdBy !== adminUser.id) {
      return c.json({ error: "Faqat o'zingiz yuklagan fayllarni o'chira olasiz" }, 403);
    }

    await deleteStoredFile(row.key);
    await db.delete(media).where(eq(media.id, id));

    return c.json({ ok: true });
  });

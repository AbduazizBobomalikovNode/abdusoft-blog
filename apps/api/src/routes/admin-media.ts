import { Hono } from "hono";
import { z } from "zod";
import { MediaListQuerySchema, listMedia } from "../lib/admin-reads/media.js";
import { requireRole } from "../lib/require-admin.js";
import { actorFromAdminUser } from "../lib/posts/types.js";
import { createMediaFromBuffer, deleteMedia, updateMediaAlt } from "../lib/media/service.js";
import { errorResponse } from "./service-response.js";

const MAX_SIZE = 10 * 1024 * 1024;

const UpdateMediaBodySchema = z.object({
  alt: z.string().nullable(),
});

export const adminMediaRoute = new Hono()
  .use("*", requireRole("admin", "staff"))
  .get("/", async (c) => {
    const adminUser = c.get("adminUser");
    const parsed = MediaListQuerySchema.safeParse({
      page: c.req.query("page"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov parametrlari" }, 400);

    return c.json(await listMedia(adminUser, parsed.data));
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
    try {
      buffer = Buffer.from(await file.arrayBuffer());
    } catch (error) {
      console.error("Rasmni qayta ishlashda xatolik:", error);
      return c.json({ error: "Rasmni qayta ishlab bo'lmadi" }, 400);
    }

    const result = await createMediaFromBuffer(actorFromAdminUser(adminUser), { buffer, mime: file.type, alt });
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(result.data, 201);
  })
  .patch("/:id", async (c) => {
    const adminUser = c.get("adminUser");
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const parsed = UpdateMediaBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);

    const result = await updateMediaAlt(actorFromAdminUser(adminUser), id, parsed.data.alt);
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(result.data);
  })
  .delete("/:id", async (c) => {
    const adminUser = c.get("adminUser");
    const result = await deleteMedia(actorFromAdminUser(adminUser), c.req.param("id"));
    if (!result.ok) return errorResponse(c, result.error);
    return c.json({ ok: true });
  });

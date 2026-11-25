import { Hono, type Context } from "hono";
import { CreateTagBodySchema, UpdateTagBodySchema } from "@blog/shared";
import { tagsQuery } from "../lib/admin-reads/tags.js";
import { requireRole } from "../lib/require-admin.js";
import { actorFromAdminUser } from "../lib/posts/types.js";
import { createTag, deleteTag, updateTag } from "../lib/tags-admin.js";
import { errorResponse } from "./service-response.js";

/** Bio `admin-posts.ts`dagi izohga qarang — Hono zanjiri turini saqlab qolish uchun middleware o'rniga handler ichidagi tekshiruv. */
function forbidUnlessAdmin(c: Context): Response | null {
  const adminUser = c.get("adminUser");
  if (adminUser.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  return null;
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

    const result = await createTag(actorFromAdminUser(c.get("adminUser")), parsed.data);
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(result.data, 201);
  })
  .patch("/:id", async (c) => {
    const forbidden = forbidUnlessAdmin(c);
    if (forbidden) return forbidden;
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const parsed = UpdateTagBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);

    const result = await updateTag(actorFromAdminUser(c.get("adminUser")), id, parsed.data);
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(result.data);
  })
  .delete("/:id", async (c) => {
    const forbidden = forbidUnlessAdmin(c);
    if (forbidden) return forbidden;
    const result = await deleteTag(actorFromAdminUser(c.get("adminUser")), c.req.param("id"), c.req.query("force") === "1");
    if (!result.ok) return errorResponse(c, result.error);
    return c.json({ ok: true });
  });

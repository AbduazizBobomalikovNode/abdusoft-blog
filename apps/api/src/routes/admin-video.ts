import { Hono } from "hono";
import { z } from "zod";
import { requireRole } from "../lib/require-admin.js";
import { actorFromAdminUser } from "../lib/posts/types.js";
import { cancelJob, deleteJob, getJobDetail, listJobs } from "../lib/video/jobs.js";
import { videoStatus } from "../lib/video/status.js";
import { errorResponse } from "./service-response.js";

const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

const ListQuerySchema = z.object({
  postId: UUID.optional(),
  kind: z.enum(["preview", "render", "gif"]).optional(),
  limit: z.coerce.number().int().positive().max(100).default(30),
});

/**
 * Video render xizmati admin marshrutlari (faqat `VIDEO_ENABLED=true` bo'lganda ulanadi). Faqat admin: video yaratish storyboard'ni
 * yozuvchi yordamchi (Claude konnektori) ishi; panel esa ishlarni ko'rish, yuklab olish, bekor qilish va o'chirish uchun.
 * Har bir marshrut konnektor vositasiga mos: status -> get_video_status, jobs -> list_post_videos, jobs/:id -> get_video_job,
 * cancel -> cancel_video_job, delete -> delete_video_job.
 */
export const adminVideoRoute = new Hono()
  .use("*", requireRole("admin"))
  .get("/status", async (c) => c.json(await videoStatus()))
  .get("/jobs", async (c) => {
    const parsed = ListQuerySchema.safeParse({ postId: c.req.query("postId"), kind: c.req.query("kind"), limit: c.req.query("limit") });
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov parametrlari" }, 400);
    return c.json({ items: await listJobs(parsed.data) });
  })
  .get("/jobs/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID.safeParse(id).success) return c.json({ error: "Video ishi topilmadi" }, 404);
    const job = await getJobDetail(id);
    if (!job) return c.json({ error: "Video ishi topilmadi" }, 404);
    return c.json(job);
  })
  .post("/jobs/:id/cancel", async (c) => {
    const id = c.req.param("id");
    if (!UUID.safeParse(id).success) return c.json({ error: "Video ishi topilmadi" }, 404);
    const result = await cancelJob(actorFromAdminUser(c.get("adminUser")), id);
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(result.data);
  })
  .delete("/jobs/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID.safeParse(id).success) return c.json({ error: "Video ishi topilmadi" }, 404);
    const result = await deleteJob(actorFromAdminUser(c.get("adminUser")), id);
    if (!result.ok) return errorResponse(c, result.error);
    return c.json({ ok: true });
  });

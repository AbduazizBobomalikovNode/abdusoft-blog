import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { requireRole } from "../lib/require-admin.js";
import { actorFromAdminUser } from "../lib/posts/types.js";
import { cancelJob, deleteJob, getJobDetail, listJobs } from "../lib/video/jobs.js";
import { videoStatus } from "../lib/video/status.js";
import { GithubSettingsError, getGithubSettingsView, saveGithubSettings } from "../lib/video/github.js";
import { recordAuditSafe } from "../lib/audit.js";
import { MotionGithubSettingsPatchSchema } from "@blog/shared";
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
  .get("/settings", async (c) => c.json(await getGithubSettingsView()))
  .put("/settings", bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: "So'rov hajmi juda katta" }, 413) }), async (c) => {
    const parsed = MotionGithubSettingsPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov" }, 400);
    try {
      await saveGithubSettings(parsed.data);
    } catch (error) {
      if (error instanceof GithubSettingsError) return c.json({ error: error.message, fields: error.fields }, 422);
      throw error;
    }
    await recordAuditSafe(actorFromAdminUser(c.get("adminUser")), { action: "video.settings_update", entityType: "settings", entityId: "video", summary: "Video (GitHub runner) sozlamalari yangilandi", meta: { fields: Object.keys(parsed.data) } });
    return c.json(await getGithubSettingsView());
  })
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

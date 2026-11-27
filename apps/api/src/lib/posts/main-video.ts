import { asc, eq } from "drizzle-orm";
import { PostMainVideoSchema, type PostMainVideo } from "@blog/shared";
import { db } from "../../db/index.js";
import { motionAssets, motionJobs } from "../../db/schema.js";
import { ownMediaMatcher } from "../media/own-url.js";
import { fail, ok, type ServiceResult } from "./types.js";

/**
 * Postning asosiy videosi: `posts.main_video`ga yoziladigan SURAT. Faqat shu postning tayyor (`ready`) render ishidan,
 * blogning o'z media manzilidagi MP4 olinadi. Video xizmati (`VIDEO_ENABLED`) o'chiq bo'lsa ham ishlaydi — faqat bazani o'qiydi.
 */
export async function resolveMainVideo(jobId: string, postId: string): Promise<ServiceResult<PostMainVideo>> {
  const [job] = await db.select().from(motionJobs).where(eq(motionJobs.id, jobId)).limit(1);
  if (!job) return fail("not_found", "Video ishi topilmadi", { code: "job_not_found" });
  if (job.kind !== "render") return fail("bad_request", "Asosiy video faqat to'liq render (MP4) ishidan tanlanadi", { code: "job_not_render" });
  if (job.postId !== postId) return fail("bad_request", "Bu video ish boshqa postniki", { code: "job_other_post" });
  if (job.status !== "ready") return fail("conflict", "Video ish hali tayyor emas", { code: "job_not_ready" });

  const assets = await db.select().from(motionAssets).where(eq(motionAssets.jobId, jobId)).orderBy(asc(motionAssets.createdAt));
  const mp4 = assets.find((a) => a.kind === "mp4");
  if (!mp4 || !mp4.width || !mp4.height) return fail("bad_request", "Ishda o'lchami ma'lum MP4 fayl yo'q", { code: "job_no_mp4" });
  const isOwn = await ownMediaMatcher();
  if (!isOwn(mp4.url)) return fail("bad_request", "Video fayli blogning o'z media saqlashida emas", { code: "job_url_not_own" });
  const still = assets.find((a) => a.kind === "still" && isOwn(a.url));

  return ok({
    jobId,
    url: mp4.url,
    posterUrl: still?.url ?? null,
    width: mp4.width,
    height: mp4.height,
    seconds: mp4.seconds ?? job.durationSeconds,
    mime: "video/mp4",
  });
}

/** Saqlangan qiymatni tekshiradi: buzuq/begona shakl `null` (sahifa videosiz chiqadi, hech narsa yiqilmaydi). */
export function parseStoredMainVideo(value: unknown): PostMainVideo | null {
  if (value === null || value === undefined) return null;
  const parsed = PostMainVideoSchema.safeParse(value);
  if (!parsed.success || !/^https?:\/\//i.test(parsed.data.url)) return null;
  return parsed.data;
}

/** Ommaviy javob: `jobId` ichki — tashqariga chiqmaydi. */
export function publicMainVideo(value: unknown): PostMainVideo | null {
  const video = parseStoredMainVideo(value);
  if (!video) return null;
  const copy = { ...video };
  delete copy.jobId;
  return copy;
}

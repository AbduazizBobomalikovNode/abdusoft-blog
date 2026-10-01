import { Cron } from "croner";
import { ChannelPlanSchema } from "@blog/shared";
import { and, eq, lt, lte } from "drizzle-orm";
import { db } from "../db/index.js";
import { posts, postViewDedupe } from "../db/schema.js";
import { recoverInterruptedChannelSends, runDueChannelSends } from "../telegram/channel-plan.js";
import { sendDigestNow } from "../telegram/digest.js";
import { events } from "./events.js";
import { pathsForPost, revalidateWeb } from "./revalidate.js";
import { getSettings } from "./settings.js";
import { loadSiteSettings } from "./site-settings.js";

const DEDUPE_RETENTION_DAYS = 7;

/**
 * Har daqiqada `status = 'scheduled' and scheduled_at <= now()` bo'lgan
 * postlarni chop etadi, har kuni `post_view_dedupe`dagi 7 kundan eski
 * yozuvlarni tozalaydi va (yoqilgan bo'lsa) soat 09:00 (Asia/Tashkent)da
 * kunlik Telegram hisobotini yuboradi. `index.ts` dan ilova ishga tushganda
 * chaqiriladi.
 */
export function startScheduler(): Cron[] {
  void recoverInterruptedChannelSends()
    .then((count) => {
      if (count > 0) console.log(`Uzilib qolgan kanal rejalari qayta navbatga qo'yildi: ${count}`);
    })
    .catch((error: unknown) => console.error("Kanal rejalarini tiklashda xatolik:", error));

  const publishJob = new Cron("* * * * *", async () => {
    try {
      await publishDuePosts();
    } catch (error: unknown) {
      console.error("Scheduler xatosi:", error);
    }
    // Kanal rejasi alohida try/catch'da — chop etishdagi xato yuborishni to'smasin (va aksincha).
    try {
      await runDueChannelSends();
    } catch (error: unknown) {
      console.error("Kanalga rejalashtirilgan yuborish xatosi:", error);
    }
  });

  const cleanupJob = new Cron("0 3 * * *", async () => {
    try {
      await cleanupOldViewDedupe();
    } catch (error: unknown) {
      console.error("View dedupe tozalash xatosi:", error);
    }
  });

  // Telegram bot admin panelda (restart'siz) yoqilishi mumkin bo'lgani uchun bu
  // job HAR DOIM ro'yxatga olinadi — ichida joriy holat (`getSettings()`) tekshiriladi.
  const digestJob = new Cron("0 9 * * *", { timezone: "Asia/Tashkent" }, async () => {
    try {
      const integrationSettings = await getSettings();
      if (!integrationSettings.telegram.enabled) return;
      const settings = await loadSiteSettings();
      if (settings.telegram.digestEnabled) {
        await sendDigestNow();
      }
    } catch (error: unknown) {
      console.error("Telegram digest xatosi:", error);
    }
  });

  return [publishJob, cleanupJob, digestJob];
}

export async function publishDuePosts(): Promise<void> {
  const now = new Date();

  const due = await db
    .select({ id: posts.id, slug: posts.slug, channelPlan: posts.channelPlan })
    .from(posts)
    .where(and(eq(posts.status, "scheduled"), lte(posts.scheduledAt, now)));

  for (const post of due) {
    const plan = ChannelPlanSchema.safeParse(post.channelPlan);
    await db
      .update(posts)
      .set({
        status: "published",
        publishedAt: now,
        scheduledAt: null,
        updatedAt: now,
        // Kanal rejasi bor bo'lsa — chop etilgan vaqt + kechikish.
        ...(plan.success
          ? {
              channelPlan: { ...plan.data, attempts: 0 },
              channelSendAt: new Date(now.getTime() + plan.data.delayMinutes * 60_000),
            }
          : { channelPlan: null, channelSendAt: null }),
      })
      .where(eq(posts.id, post.id));

    events.emit("post.published", { id: post.id, slug: post.slug });
    revalidateWeb(pathsForPost(post.slug));
    console.log(`Rejalashtirilgan post chop etildi: ${post.slug}`);
  }
}

/** `post_view_dedupe` — faqat kunlik dedupe uchun kerak, shu sabab 7 kundan eski yozuvlar tozalanadi. */
async function cleanupOldViewDedupe(): Promise<void> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - DEDUPE_RETENTION_DAYS);
  const cutoffDay = cutoff.toISOString().slice(0, 10);

  const deleted = await db.delete(postViewDedupe).where(lt(postViewDedupe.day, cutoffDay)).returning();

  if (deleted.length > 0) {
    console.log(`View dedupe tozalandi: ${deleted.length} ta yozuv (${cutoffDay}dan eski).`);
  }
}

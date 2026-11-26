import { Cron } from "croner";
import { lt } from "drizzle-orm";
import { db } from "../db/index.js";
import { postViewDedupe } from "../db/schema.js";
import { publishDuePosts } from "./posts/index.js";
import { recoverInterruptedChannelSends, runDueChannelSends } from "../telegram/channel-plan.js";
import { sendDigestNow } from "../telegram/digest.js";
import { config } from "../config.js";
import { cleanupMcpData } from "./mcp/connections.js";
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

  const jobs = [publishJob, cleanupJob, digestJob];

  // Claude konnektori (MCP): rozilik olmagan ro'yxatdan o'tgan klientlar va eski refresh token'larni tozalash.
  // Faqat MCP_ENABLED=true bo'lganda ro'yxatga olinadi — o'chiq bo'lsa jadval umuman o'zgarmaydi.
  if (config.MCP_ENABLED) {
    jobs.push(
      new Cron("17 * * * *", async () => {
        try {
          const removed = await cleanupMcpData(config.MCP_UNUSED_CLIENT_TTL_HOURS);
          if (removed.clients > 0 || removed.refreshTokens > 0) {
            console.log(`MCP tozalash: ${removed.clients} ta ishlatilmagan klient, ${removed.refreshTokens} ta eski refresh token.`);
          }
        } catch (error: unknown) {
          console.error("MCP tozalash xatosi:", error);
        }
      }),
    );
  }

  // Ijtimoiy tarqatish: faqat DISTRIBUTION_ENABLED=true. O'chiq bo'lsa hech qanday job, import yoki so'rov yo'q.
  if (config.DISTRIBUTION_ENABLED) {
    void import("./distribution/service/tick.js")
      .then((m) => m.recoverDistributionsOnStart())
      .catch((error: unknown) => console.error("Tarqatishlarni tiklashda xatolik:", error instanceof Error ? error.message : error));
    jobs.push(
      new Cron("* * * * *", async () => {
        try {
          const m = await import("./distribution/service/tick.js");
          await m.runDistributionTick();
        } catch (error: unknown) {
          console.error("Tarqatish scheduler xatosi:", error instanceof Error ? error.message : error);
        }
      }),
    );
  }

  return jobs;
}

/** Rejalashtirilgan postlarni chop etish — `lib/posts` xizmatidagi YAGONA chop etish yo'li orqali (scheduler tizim aktyori). */
export { publishDuePosts };

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

import { Cron } from "croner";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { motionJobs } from "../../db/schema.js";
import { abortAllRunning, kickQueue, recoverVideoJobs, runRetention, tickQueue } from "./jobs.js";
import { killAllWorkersSync } from "./runner.js";

let shutdownInstalled = false;

/**
 * API to'xtaganda render ishchilarining butun jarayon guruhi o'ldiriladi (Chrome ham qolmaydi). `exit` ishlovchisi sinxron:
 * kutilmagan chiqishda ham ishlaydi. SIGKILL'da ishchining o'zi (`--parent-pid`) va keyingi ishga tushishdagi tiklash qoldiqni tozalaydi.
 */
export function installVideoShutdown(exitProcess = true): void {
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  process.on("exit", () => {
    killAllWorkersSync();
  });
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      abortAllRunning();
      killAllWorkersSync();
      void db
        .update(motionJobs)
        .set({ status: "failed", errorCode: "interrupted", errorMessage: "The API server was stopped while this job was running. Start it again.", finishedAt: new Date() })
        .where(eq(motionJobs.status, "running"))
        .catch(() => undefined)
        .finally(() => {
          if (exitProcess) process.exit(sig === "SIGTERM" ? 143 : 130);
        });
      // Bazaga yozish osilib qolsa ham chiqamiz.
      if (exitProcess) setTimeout(() => process.exit(sig === "SIGTERM" ? 143 : 130), 3000).unref();
    });
  }
}

/** `VIDEO_ENABLED=true` bo'lganda scheduler chaqiradi: tiklash, navbatni kuzatish (har 5 soniya), tozalash (har soat). */
export async function startVideo(): Promise<Cron[]> {
  installVideoShutdown();
  try {
    const r = await recoverVideoJobs();
    if (r.failedRunning > 0 || r.killedStale > 0 || r.sweptDirs > 0) {
      console.log(`Video tiklash: ${r.failedRunning} ta uzilgan ish 'failed' qilindi, ${r.killedStale} ta qolib ketgan ishchi o'ldirildi, ${r.sweptDirs} ta papka tozalandi.`);
    }
  } catch (error: unknown) {
    console.error("Video ishlarini tiklashda xatolik:", error);
  }
  const tick = new Cron("*/5 * * * * *", { protect: true }, async () => {
    try {
      await tickQueue();
    } catch (error: unknown) {
      console.error("Video navbati xatosi:", error);
    }
  });
  const retention = new Cron("23 * * * *", { protect: true }, async () => {
    try {
      const r = await runRetention();
      if (r.previews + r.renders + r.failed + r.orphanDirs > 0) console.log(`Video tozalash: ${r.previews} ko'rik, ${r.renders} eski render, ${r.failed} muvaffaqiyatsiz ish, ${r.orphanDirs} yetim papka.`);
    } catch (error: unknown) {
      console.error("Video tozalash xatosi:", error);
    }
  });
  kickQueue();
  return [tick, retention];
}

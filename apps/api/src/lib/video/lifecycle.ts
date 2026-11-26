import { Cron } from "croner";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import { db } from "../../db/index.js";
import { motionJobs } from "../../db/schema.js";
import { abortAllRunning, kickQueue, recoverVideoJobs, runRetention, tickQueue } from "./jobs.js";
import { config } from "../../config.js";
import { killAllWorkersSync, liveWorkerCount } from "./runner.js";

let shutdownInstalled = false;
const SHUTDOWN_GRACE_MS = 3000;

/** Ishchilar tugaguncha (yoki `ms` o'tguncha) kutadi. */
async function waitForWorkers(ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (liveWorkerCount() > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
}

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
      // SIGTERM to every worker AND its browser descendants first, a short wait, then SIGKILL: no orphan browser is left behind.
      abortAllRunning();
      killAllWorkersSync("SIGTERM");
      const code = sig === "SIGTERM" ? 143 : 130;
      void waitForWorkers(SHUTDOWN_GRACE_MS)
        .then(() => killAllWorkersSync("SIGKILL"))
        .then(async () => {
          await db
            .update(motionJobs)
            .set({ status: "failed", errorCode: "interrupted", errorMessage: "The API server was stopped while this job was running. Start it again.", finishedAt: new Date() })
            // Only workers that lived in THIS process: GitHub-backed jobs survive an API restart (their state is in the database).
            .where(and(eq(motionJobs.status, "running"), or(isNull(motionJobs.runner), ne(motionJobs.runner, "github"))));
        })
        .catch(() => undefined)
        .finally(() => {
          if (exitProcess) process.exit(code);
        });
      // Bazaga yozish osilib qolsa ham chiqamiz.
      if (exitProcess) setTimeout(() => process.exit(code), SHUTDOWN_GRACE_MS + 3000).unref();
    });
  }
}

/** `VIDEO_ENABLED=true` bo'lganda scheduler chaqiradi: tiklash, navbatni kuzatish (har 5 soniya), tozalash (har soat). */
export async function startVideo(): Promise<Cron[]> {
  // Local workers live inside this process tree and must die with it; GitHub runs are independent of this process.
  if (config.VIDEO_RUNNER === "local") installVideoShutdown();
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

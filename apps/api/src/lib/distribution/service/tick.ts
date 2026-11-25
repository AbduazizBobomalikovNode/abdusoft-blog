import { lt } from "drizzle-orm";
import { db } from "../../../db/index.js";
import { distributionOauthStates } from "../../../db/schema.js";
import { runTokenReminders, runTokenRefreshes } from "./accounts.js";
import { distNow } from "./env.js";
import { recoverInterruptedDistributions, runDueDistributions } from "./runner.js";

/** Ishga tushganda: oldingi jarayondan qolgan `sending` yozuvlari "tekshirish kerak" bo'ladi (qayta urinilmaydi). */
export async function recoverDistributionsOnStart(): Promise<void> {
  const n = await recoverInterruptedDistributions(distNow(), true);
  if (n > 0) console.log(`Uzilib qolgan tarqatishlar «tekshirish kerak»ga o'tkazildi: ${n}`);
}

export interface TickResult {
  recovered: number;
  refreshed: number;
  reminders: number;
  ran: number;
}

/** Har daqiqa: tiklash, token yangilash, eslatmalar, vaqti kelgan yuborishlar. Har biri alohida try/catch. */
export async function runDistributionTick(now: Date = distNow()): Promise<TickResult> {
  const out: TickResult = { recovered: 0, refreshed: 0, reminders: 0, ran: 0 };
  const guard = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error: unknown) {
      console.error(`Tarqatish tick xatosi (${label}):`, error instanceof Error ? error.message : "noma'lum");
    }
  };
  await guard("recover", async () => void (out.recovered = await recoverInterruptedDistributions(now)));
  await guard("states", async () => void (await db.delete(distributionOauthStates).where(lt(distributionOauthStates.expiresAt, now))));
  await guard("refresh", async () => void (out.refreshed = await runTokenRefreshes(now)));
  await guard("reminders", async () => void (out.reminders = await runTokenReminders(now)));
  await guard("send", async () => void (out.ran = await runDueDistributions(now)));
  return out;
}

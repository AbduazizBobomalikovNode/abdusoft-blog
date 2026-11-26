import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { bannedDevices } from "../db/schema.js";
import { recordAuditSafe } from "./audit.js";
import { fail, ok, type Actor, type ServiceResult } from "./posts/types.js";

/** Bloklar ro'yxati (`GET /admin/bans` va MCP `list_comment_bans` uchun YAGONA yo'l). Xeshlar bu qatlamda to'liq qaytadi; MCP ularni ko'rsatmaydi. */
export async function listBans() {
  const rows = await db.select().from(bannedDevices).orderBy(desc(bannedDevices.createdAt));
  return rows.map((row) => ({
    id: row.id,
    deviceHash: row.deviceHash,
    ipHash: row.ipHash,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * Blokni olib tashlaydi + jurnal. Panelning avvalgi xatti-harakati saqlanadi: mavjud bo'lmagan id xato emas (`DELETE` idempotent).
 * `existed` — qator haqiqatan bor edimi (MCP "topilmadi" deb aytishi uchun).
 */
export async function liftBan(actor: Actor, banId: string): Promise<ServiceResult<{ existed: boolean }>> {
  const [row] = await db.select({ id: bannedDevices.id }).from(bannedDevices).where(eq(bannedDevices.id, banId)).limit(1);
  if (!row && actor.via === "mcp") return fail("not_found", "Blok topilmadi");
  await db.delete(bannedDevices).where(eq(bannedDevices.id, banId));
  await recordAuditSafe(actor, { action: "ban.remove", entityType: "ban", entityId: banId, summary: "Blok olib tashlandi" });
  return ok({ existed: Boolean(row) });
}

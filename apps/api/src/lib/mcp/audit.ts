import { db } from "../../db/index.js";
import { recordAuditCoalesced, recordAuditSafe } from "../audit.js";
import type { McpToolContext } from "./tools/types.js";

/**
 * O'qish chaqiruvlari jurnalga HAR BIRI uchun alohida yozilmaydi — jurnal "o'qish shovqini"ga to'lib ketmasin:
 * AYNI klient uchun 15 daqiqa ichidagi chaqiruvlar bitta `mcp.read` yozuviga yig'iladi (`meta.fields` — vosita
 * nomlari, `meta.count` — chaqiruvlar soni, `meta.lastAt`). Shu bilan "Claude nimani o'qigan va qachon" ko'rinadi,
 * lekin kontent, argument yoki token jurnalga tushmaydi. Yozuvlar (keyingi PR) xizmat funksiyalarining o'zi orqali,
 * HAR bir amal uchun alohida yoziladi (`via: "mcp"`).
 */
export const MCP_READ_AUDIT_WINDOW_MS = 15 * 60 * 1000;

export async function auditMcpRead(ctx: McpToolContext, toolName: string): Promise<void> {
  try {
    await recordAuditCoalesced(
      db,
      ctx.actor,
      {
        action: "mcp.read",
        entityType: "mcp",
        entityId: ctx.client.id,
        summary: `Ulangan ilova ma'lumot o'qidi: ${ctx.client.name ?? ctx.client.id} (${toolName})`,
        fields: [toolName],
        meta: { clientName: ctx.client.name },
      },
      MCP_READ_AUDIT_WINDOW_MS,
    );
  } catch (error: unknown) {
    console.error("MCP o'qish jurnaliga yozib bo'lmadi:", error instanceof Error ? error.message : error);
  }
}

export async function auditMcpDenied(ctx: McpToolContext, toolName: string, requiredScope: string): Promise<void> {
  await recordAuditSafe(ctx.actor, {
    action: "mcp.denied",
    entityType: "mcp",
    entityId: ctx.client.id,
    summary: `Ruxsat yetishmadi: ${toolName} (${requiredScope})`,
    meta: { tool: toolName, requiredScope, clientName: ctx.client.name },
  });
}

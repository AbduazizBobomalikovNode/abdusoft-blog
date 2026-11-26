import { config } from "../../../config.js";
import { READ_TOOLS } from "./read-tools.js";
import type { McpToolDef } from "./types.js";
import { WRITE_TOOLS, UPLOAD_TOOL_NAME as UPLOAD_NAME } from "./write-tools.js";

/**
 * Ijtimoiy tarqatish vositalari FAQAT `DISTRIBUTION_ENABLED=true` bo'lganda yuklanadi (modul, servis va rasm kodi bilan birga):
 * o'chiq bo'lsa ular umuman import qilinmaydi (`routes/admin.ts`dagi kabi).
 */
const distributionTools = config.DISTRIBUTION_ENABLED ? await import("./distribution-tools.js") : null;

/** O'qish vositalari (PR #11): `MCP_WRITE_TOOLS_ENABLED` o'chiq bo'lganda ro'yxatga olinadigan YAGONA to'plam. */
export const TOOLS: McpToolDef[] = [...READ_TOOLS];

export const UPLOAD_TOOL_NAME = UPLOAD_NAME;

/**
 * Hozir ro'yxatga olinadigan vositalar (HAR SO'ROVDA `config` bo'yicha): yozuv kaliti o'chiq bo'lsa faqat o'qish vositalari;
 * yoqilgan bo'lsa yozuv vositalari ham; butunlay o'chirish vositasi esa YANA alohida `MCP_PURGE_ENABLED` kalitini talab qiladi.
 * Ruxsat, xato, o'lcham va jurnal mantig'i `run.ts`da markazlashgan.
 */
export function getTools(): McpToolDef[] {
  // Ijtimoiy tarqatish vositalari FAQAT DISTRIBUTION_ENABLED=true bo'lganda (o'chiq bo'lsa ro'yxat avvalgidek).
  const dist = config.DISTRIBUTION_ENABLED ? distributionTools : null;
  if (!config.MCP_WRITE_TOOLS_ENABLED) return dist ? [...TOOLS, ...dist.DISTRIBUTION_READ_TOOLS] : TOOLS;
  return [...TOOLS, ...(dist ? dist.DISTRIBUTION_READ_TOOLS : []), ...WRITE_TOOLS.filter((tool) => !tool.requiresPurgeSwitch || config.MCP_PURGE_ENABLED), ...(dist ? dist.DISTRIBUTION_WRITE_TOOLS : [])];
}

export const TOOL_NAME_MAX = 64;

import { config } from "../../../config.js";
import { READ_TOOLS } from "./read-tools.js";
import type { McpToolDef } from "./types.js";
import { WRITE_TOOLS, UPLOAD_TOOL_NAME as UPLOAD_NAME } from "./write-tools.js";

/** O'qish vositalari (PR #11): `MCP_WRITE_TOOLS_ENABLED` o'chiq bo'lganda ro'yxatga olinadigan YAGONA to'plam. */
export const TOOLS: McpToolDef[] = [...READ_TOOLS];

export const UPLOAD_TOOL_NAME = UPLOAD_NAME;

/** Video vositalari moduli: faqat `VIDEO_ENABLED=true` bo'lganda yuklanadi (o'chiq bo'lsa render xizmati kodi ham import qilinmaydi). */
const videoToolsLoaded = config.VIDEO_ENABLED ? await import("./video-tools.js") : null;

/**
 * Hozir ro'yxatga olinadigan vositalar (HAR SO'ROVDA `config` bo'yicha): yozuv kaliti o'chiq bo'lsa faqat o'qish vositalari;
 * yoqilgan bo'lsa yozuv vositalari ham; butunlay o'chirish vositasi esa YANA alohida `MCP_PURGE_ENABLED` kalitini talab qiladi.
 * Ruxsat, xato, o'lcham va jurnal mantig'i `run.ts`da markazlashgan.
 */
export function getTools(): McpToolDef[] {
  const base = config.MCP_WRITE_TOOLS_ENABLED ? [...TOOLS, ...WRITE_TOOLS.filter((tool) => !tool.requiresPurgeSwitch || config.MCP_PURGE_ENABLED)] : TOOLS;
  if (!config.VIDEO_ENABLED) return base;
  // Video vositalari (VIDEO_ENABLED=true): o'qish vositalari doim; render vositalari faqat yozuv kaliti ham yoqilganda.
  const video = videoToolsLoaded;
  if (!video) return base;
  return [...base, ...video.VIDEO_READ_TOOLS, ...(config.MCP_WRITE_TOOLS_ENABLED ? video.VIDEO_WRITE_TOOLS : [])];
}

export const TOOL_NAME_MAX = 64;

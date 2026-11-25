import { READ_TOOLS } from "./read-tools.js";
import type { McpToolDef } from "./types.js";

/**
 * YAGONA vosita reyestri. Keyingi PR'dagi yozuv vositalari (`WRITE_TOOLS`) shu massivga qo'shiladi — ruxsat,
 * xato, o'lcham va jurnal mantig'i `run.ts`da markazlashgan, qayta yozish shart emas.
 */
export const TOOLS: McpToolDef[] = [...READ_TOOLS];

export const TOOL_NAME_MAX = 64;

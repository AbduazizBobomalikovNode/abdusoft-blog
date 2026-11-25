import { CHANNEL_WRITE_TOOLS } from "./channel-write-tools.js";
import { MISC_WRITE_TOOLS, UPLOAD_TOOL_NAME } from "./misc-write-tools.js";
import { POST_WRITE_TOOLS } from "./post-write-tools.js";
import type { McpToolDef } from "./types.js";

export { UPLOAD_TOOL_NAME };

/**
 * Yozuv vositalari. Faqat `MCP_WRITE_TOOLS_ENABLED=true` bo'lganda ro'yxatga olinadi (`index.ts` -> `getTools`);
 * `purge_post` esa yana alohida `MCP_PURGE_ENABLED`ni talab qiladi.
 */
export const WRITE_TOOLS: McpToolDef[] = [...POST_WRITE_TOOLS, ...MISC_WRITE_TOOLS, ...CHANNEL_WRITE_TOOLS];

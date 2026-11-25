import { config } from "../../config.js";

const trimSlash = (value: string) => value.replace(/\/+$/, "");

/** Ommaviy API origin'i (`API_ORIGIN`), oxiridagi `/`siz. */
export const apiOrigin = trimSlash(config.API_ORIGIN);

/** MCP endpoint yo'li. Foydalanuvchi Claude'ga aynan shu URL'ni kiritadi. */
export const MCP_PATH = "/mcp";

/** Himoyalangan resurs identifikatori (RFC 8707/9728) — token `aud`i va PRM `resource`i aynan shu bo'lishi shart. */
export const MCP_RESOURCE_URL = `${apiOrigin}${MCP_PATH}`;

/** Better Auth yo'li (`baseURL` + `/api/auth`) — token `iss`i va RFC 8414 metadata'ning `issuer`i. */
export const MCP_ISSUER = `${apiOrigin}/api/auth`;

/** RFC 9728 protected-resource metadata URL'i (`WWW-Authenticate` sarlavhasida e'lon qilinadi). */
export const MCP_RESOURCE_METADATA_URL = `${apiOrigin}/.well-known/oauth-protected-resource${MCP_PATH}`;

export const MCP_LOGIN_PAGE = `${trimSlash(config.WEB_ORIGIN)}/login`;
export const MCP_CONSENT_PAGE = `${trimSlash(config.WEB_ORIGIN)}/consent`;

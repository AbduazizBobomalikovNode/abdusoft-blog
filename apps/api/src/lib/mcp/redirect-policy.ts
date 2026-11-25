import { config } from "../../config.js";

/** Claude (web, desktop va mobil) uchun hujjatlashtirilgan yagona callback. */
export const CLAUDE_CALLBACK_URIS = ["https://claude.ai/api/mcp/auth_callback"] as const;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** `MCP_ALLOWED_REDIRECT_URIS` — vergul bilan ajratilgan, faqat aniq `https://` manzillar (qo'shimcha ruxsat). */
export function parseExtraRedirectUris(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => {
      if (!item) return false;
      try {
        const url = new URL(item);
        return url.protocol === "https:" && !url.username && !url.password && !url.hash;
      } catch {
        return false;
      }
    });
}

const extraUris = new Set(parseExtraRedirectUris(config.MCP_ALLOWED_REDIRECT_URIS));

/**
 * Ruxsat etilgan redirect URI'mi: Claude'ning hujjatlashtirilgan callback'i, Claude Code uchun loopback
 * (`http://localhost|127.0.0.1:<port>/callback`, port e'tiborsiz) yoki env ro'yxatidagi aniq manzillar.
 * Boshqa hamma narsa rad etiladi — shu tariqa autentifikatsiyasiz ro'yxatdan o'tgan begona klient
 * authorization code'ni o'z serveriga yo'naltira olmaydi.
 */
export function isAllowedRedirectUri(uri: string, extra: ReadonlySet<string> = extraUris): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;

  if (url.protocol === "https:") {
    if (url.search) return false;
    const normalized = `${url.origin}${url.pathname}`;
    return (CLAUDE_CALLBACK_URIS as readonly string[]).includes(normalized) || extra.has(normalized);
  }

  if (url.protocol === "http:") {
    return LOOPBACK_HOSTS.has(url.hostname) && url.pathname === "/callback" && !url.search;
  }

  return false;
}

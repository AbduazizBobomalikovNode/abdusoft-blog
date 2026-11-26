import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { config } from "../../config.js";
import type { McpPrincipal } from "./principal.js";
import { runTool } from "./tools/run.js";
import { UPLOAD_TOOL_NAME, getTools } from "./tools/index.js";
import type { McpToolContext } from "./tools/types.js";

export const MCP_SERVER_INFO = { name: "abdusoft-blog", version: "1.0.0" } as const;

export function buildContext(principal: McpPrincipal): McpToolContext {
  return {
    actor: { userId: principal.userId, role: "admin", via: "mcp" },
    user: { id: principal.userId, email: principal.email, name: principal.name },
    client: { id: principal.clientId, name: principal.clientName },
    scopes: principal.scopes,
    limits: { resultMaxChars: config.MCP_RESULT_MAX_CHARS },
  };
}

/** Har bir so'rov uchun yangi server (stateless): vositalar reyestrdan ro'yxatga olinadi, ijro `runTool` orqali. */
export function buildMcpServer(ctx: McpToolContext): McpServer {
  const server = new McpServer(MCP_SERVER_INFO);
  for (const def of getTools()) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: config.MCP_WRITE_TOOLS_ENABLED ? def.description.replace(/ ?Read-only;? [^.]*not available yet\./, " Read-only.") : def.description,
        // Qat'iy: noma'lum argumentlar rad etiladi (JSON sxemada additionalProperties:false).
        inputSchema: z.object(def.inputSchema).strict(),
        annotations: { title: def.title, ...def.annotations },
      },
      async (args: unknown) => {
        const { images, ...result } = await runTool(def, args, ctx);
        return images ? { ...result, content: [...result.content, ...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }))] } : result;
      },
    );
  }
  return server;
}

/** Streamable HTTP, holatsiz, JSON javoblar (SSE yo'q). */
const STANDARD_BODY_LIMIT = 1024 * 1024;

/** 1 MB dan katta tana FAQAT bitta `tools/call upload_image` chaqiruviga ruxsat etiladi (base64 rasm). */
function isUploadCall(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { method?: unknown; params?: { name?: unknown } };
    return parsed.method === "tools/call" && parsed.params?.name === UPLOAD_TOOL_NAME;
  } catch {
    return false;
  }
}

/** MCP spec (2026-07-28) `UnsupportedProtocolVersionError`. */
export const UNSUPPORTED_PROTOCOL_VERSION_CODE = -32022;

/**
 * `MCP-Protocol-Version` sarlavhasi bu server (SDK) biladigan versiyalar ro'yxatida bo'lmasa — 400 + `UnsupportedProtocolVersionError`
 * (`-32022`, `data.supported`/`data.requested`). SDK'ning o'z javobi (`-32000`, `supported`siz) zamonaviy mijoz uchun "tanilgan xato"
 * emas: mijoz tarkibini tushunmay, ro'yxatdan mos versiyani tanlay olmaydi. `initialize` istisno (versiya kelishuvi `initialize`
 * javobida bo'ladi; SDK ham sarlavhani unda tekshirmaydi).
 */
export function unsupportedVersionResponse(headerValue: string | null, bodyText: string): Response | null {
  if (headerValue === null || (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(headerValue)) return null;
  let id: string | number | null = null;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (first && typeof first === "object") {
      const m = first as { method?: unknown; id?: unknown };
      if (m.method === "initialize") return null;
      if (typeof m.id === "string" || typeof m.id === "number") id = m.id;
    }
  } catch {
    // tahlil qilinmasa — SDK o'zining "Parse error" javobini beradi
    return null;
  }
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: UNSUPPORTED_PROTOCOL_VERSION_CODE, message: "Unsupported protocol version", data: { supported: [...SUPPORTED_PROTOCOL_VERSIONS], requested: headerValue.slice(0, 40) } },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

export async function handleMcpRequest(original: Request, principal: McpPrincipal): Promise<Response> {
  let req = original;
  {
    const version = original.headers.get("mcp-protocol-version");
    if (version !== null && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
      const text = await original.clone().text();
      const refused = unsupportedVersionResponse(version, text);
      if (refused) return refused;
    }
  }
  const declared = Number(original.headers.get("content-length") ?? "0");
  if (declared > STANDARD_BODY_LIMIT || !original.headers.has("content-length")) {
    const text = await original.text();
    if (text.length > STANDARD_BODY_LIMIT && !isUploadCall(text)) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: "Request too large" }, id: null }), {
        status: 413,
        headers: { "content-type": "application/json" },
      });
    }
    req = new Request(original, { body: text });
  }
  const ctx = buildContext(principal);
  const server = buildMcpServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);

  // Ba'zi klientlar `Accept: application/json` yuboradi; SDK ikkala turni talab qiladi — kamsitmaslik uchun to'ldiramiz.
  const accept = req.headers.get("accept") ?? "";
  let request = req;
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
    const headers = new Headers(req.headers);
    headers.set("accept", "application/json, text/event-stream");
    request = new Request(req, { headers });
  }

  try {
    return await transport.handleRequest(request, {
      authInfo: { token: "redacted", clientId: principal.clientId, scopes: [...principal.scopes] },
    });
  } finally {
    // Stateless: server va transport so'rovdan keyin yopiladi.
    void server.close().catch(() => undefined);
  }
}

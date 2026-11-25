import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { config } from "../../config.js";
import type { McpPrincipal } from "./principal.js";
import { runTool } from "./tools/run.js";
import { TOOLS } from "./tools/index.js";
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
  for (const def of TOOLS) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: { title: def.title, ...def.annotations },
      },
      async (args: unknown) => runTool(def, args, ctx),
    );
  }
  return server;
}

/** Streamable HTTP, holatsiz, JSON javoblar (SSE yo'q). */
export async function handleMcpRequest(req: Request, principal: McpPrincipal): Promise<Response> {
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

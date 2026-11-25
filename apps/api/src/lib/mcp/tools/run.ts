import { z, type ZodError } from "zod";
import { config } from "../../../config.js";
import { auditMcpDenied, auditMcpRead } from "../audit.js";
import { errorResult, fitResult, okResult, type McpToolResult } from "./result.js";
import { ToolError, type McpToolContext, type McpToolDef } from "./types.js";

function logCall(fields: Record<string, unknown>): void {
  if (config.NODE_ENV === "test") return;
  // Faqat meta-ma'lumot: vosita nomi, klient, davomiylik, o'lcham, natija. Kontent, argument va tokenlar HECH QACHON yozilmaydi.
  console.info(JSON.stringify({ event: "mcp.tool", ...fields }));
}

function describeZodError(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(input)"}: ${issue.message}`).join("; ");
}

/**
 * Bitta vosita chaqiruvining markaziy yo'li: ruxsat tekshiruvi (`insufficient_scope`, kerakli scope nomi bilan) ->
 * kirishni tekshirish -> ishlov -> jurnal -> natijani o'lchamga moslash -> tuzilmaviy log.
 * Handler'lar faqat xizmat funksiyalarini chaqiradi; ruxsat/xato/o'lcham mantig'i shu yerda — takrorlanmaydi.
 */
export async function runTool<Shape extends z.ZodRawShape>(
  def: McpToolDef<Shape>,
  rawArgs: unknown,
  ctx: McpToolContext,
): Promise<McpToolResult> {
  const started = Date.now();
  const base = { tool: def.name, client: ctx.client.id, user: ctx.user.id };

  try {
    if (def.scope !== null && !ctx.scopes.has(def.scope)) {
      await auditMcpDenied(ctx, def.name, def.scope);
      throw new ToolError(
        "insufficient_scope",
        `This tool requires the '${def.scope}' permission, which was not granted to this connection.`,
        "Ask the owner to reconnect the connector and approve this permission (Claude: Customize > Connectors > this connector > Reconnect).",
        { requiredScope: def.scope, grantedScopes: [...ctx.scopes].sort() },
      );
    }

    const parsed = z.object(def.inputSchema).strict().safeParse(rawArgs ?? {});
    if (!parsed.success) {
      throw new ToolError("invalid_input", `Invalid arguments: ${describeZodError(parsed.error)}`, "Fix the arguments and call the tool again.");
    }

    const output = await def.handler(parsed.data as z.infer<z.ZodObject<Shape>>, ctx);
    if (def.kind === "read") await auditMcpRead(ctx, def.name);

    const fitted = fitResult(output, ctx.limits.resultMaxChars);
    logCall({ ...base, ok: true, ms: Date.now() - started, bytes: fitted.text.length, truncated: fitted.truncated });
    return okResult(fitted.text);
  } catch (error: unknown) {
    if (error instanceof ToolError) {
      logCall({ ...base, ok: false, code: error.code, ms: Date.now() - started });
      return errorResult(error);
    }
    // Kutilmagan xato: tafsilot (stack, SQL, qiymatlar) mijozga CHIQMAYDI, faqat server logiga (xabar bilan).
    console.error(`MCP vositasi xatosi (${def.name}):`, error instanceof Error ? error.message : error);
    logCall({ ...base, ok: false, code: "internal_error", ms: Date.now() - started });
    return errorResult(
      new ToolError("internal_error", "The tool failed unexpectedly.", "Try again; if it keeps failing, check the API server logs."),
    );
  }
}

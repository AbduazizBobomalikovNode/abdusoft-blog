import { createHash } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { db } from "../../db/index.js";
import { mcpIdempotency } from "../../db/schema.js";
import { ToolError, type McpToolContext, type ToolOutput } from "./tools/types.js";

const KEEP_DAYS = 7;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Yaratuvchi vositalar uchun idempotentlik: bir xil (klient, `idempotency_key`) bilan takroriy chaqiruv ikkinchi nusxa
 * yaratmaydi — birinchi natijani `idempotentReplay: true` bilan qaytaradi. Kalit BOSHQA argumentlar bilan ishlatilsa xato.
 * Birinchi chaqiruv xato bilan tugasa kalit bo'shatiladi (qayta urinish mumkin). Kalit berilmasa — oddiy chaqiruv.
 */
export async function withIdempotency(
  ctx: McpToolContext,
  tool: string,
  key: string | undefined,
  args: Record<string, unknown>,
  run: () => Promise<ToolOutput>,
  /** Saqlanadigan javobni tozalaydi (masalan maxfiy havola bazaga yozilmasin); takroriy chaqiruv shu tozalangan nusxani qaytaradi. */
  redactForStorage?: (data: Record<string, unknown>) => Record<string, unknown>,
): Promise<ToolOutput> {
  if (!key) return run();
  const { idempotency_key: _ignored, ...rest } = args;
  void _ignored;
  const argsHash = createHash("sha256").update(`${tool}:${stable(rest)}`).digest("hex");

  await db.delete(mcpIdempotency).where(lt(mcpIdempotency.createdAt, new Date(Date.now() - KEEP_DAYS * 86_400_000))).catch(() => undefined);

  const claimed = await db
    .insert(mcpIdempotency)
    .values({ clientId: ctx.client.id, key, tool, argsHash })
    .onConflictDoNothing()
    .returning();

  if (claimed.length === 0) {
    const [existing] = await db
      .select()
      .from(mcpIdempotency)
      .where(and(eq(mcpIdempotency.clientId, ctx.client.id), eq(mcpIdempotency.key, key)))
      .limit(1);
    if (!existing || existing.argsHash !== argsHash) {
      throw new ToolError(
        "invalid_input",
        "This idempotency_key was already used with different arguments (or by another tool).",
        "Use a fresh unique idempotency_key for a new request; reuse a key only to retry the exact same call.",
      );
    }
    if (existing.response === null) {
      throw new ToolError("conflict", "A call with this idempotency_key is still being processed.", "Wait a few seconds and retry the same call.");
    }
    const stored = existing.response as Record<string, unknown>;
    return { data: { ...stored, idempotentReplay: true, replayNote: "This is the result of the earlier identical call; nothing was created again. Re-read the item for its current state." } };
  }

  try {
    const output = await run();
    await db
      .update(mcpIdempotency)
      .set({ response: redactForStorage ? redactForStorage(output.data) : output.data })
      .where(and(eq(mcpIdempotency.clientId, ctx.client.id), eq(mcpIdempotency.key, key)));
    return output;
  } catch (error) {
    await db
      .delete(mcpIdempotency)
      .where(and(eq(mcpIdempotency.clientId, ctx.client.id), eq(mcpIdempotency.key, key)))
      .catch(() => undefined);
    throw error;
  }
}

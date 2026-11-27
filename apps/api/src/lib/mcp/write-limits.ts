import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import { auditLog } from "../../db/schema.js";
import { ToolError, type McpToolContext, type WriteLimitCategory } from "./tools/types.js";

interface LimitSpec {
  /** Bu toifaga hisoblanadigan jurnal amallari. */
  actions: string[];
  max: () => number;
  windowSeconds: number;
  label: string;
  envName: string;
}

const HOUR = 3600;
const DAY = 86_400;

/**
 * Yozuv chegaralari HAR BIR ULANISH (klient) uchun. Hisob jurnaldan olinadi (`via = mcp`, `meta.client`) — shu sabab server
 * qayta ishga tushganda yo'qolmaydi va aynan "nima qilingani" bilan mos keladi. `dry_run` va idempotent takrorlar jurnalga
 * yozilmaydi, ya'ni hisobga kirmaydi.
 */
export const WRITE_LIMITS: Record<WriteLimitCategory, LimitSpec> = {
  create: { actions: ["post.create", "tag.create", "comment.reply"], max: () => config.MCP_WRITE_LIMIT_CREATES_PER_HOUR, windowSeconds: HOUR, label: "creations (new drafts, tags, comment replies) per hour", envName: "MCP_WRITE_LIMIT_CREATES_PER_HOUR" },
  edit: {
    actions: ["post.update", "post.restore_revision", "post.restore_trash", "post.submit", "post.request_changes", "post.unpublish", "post.archive", "tag.update", "media.update", "distribution.save_text", "distribution.cancel", "distribution.plan_clear"],
    max: () => config.MCP_WRITE_LIMIT_EDITS_PER_HOUR,
    windowSeconds: HOUR,
    label: "edits and state changes per hour",
    envName: "MCP_WRITE_LIMIT_EDITS_PER_HOUR",
  },
  upload: { actions: ["media.upload"], max: () => config.MCP_WRITE_LIMIT_UPLOADS_PER_HOUR, windowSeconds: HOUR, label: "image uploads per hour", envName: "MCP_WRITE_LIMIT_UPLOADS_PER_HOUR" },
  publish: { actions: ["post.publish", "post.approve", "post.schedule"], max: () => config.MCP_WRITE_LIMIT_PUBLISHES_PER_DAY, windowSeconds: DAY, label: "publish/schedule actions per day", envName: "MCP_WRITE_LIMIT_PUBLISHES_PER_DAY" },
  channel: { actions: ["post.channel_send", "post.channel_replace"], max: () => config.MCP_WRITE_LIMIT_CHANNEL_SENDS_PER_DAY, windowSeconds: DAY, label: "Telegram channel sends per day", envName: "MCP_WRITE_LIMIT_CHANNEL_SENDS_PER_DAY" },
  // Ijtimoiy tarmoqqa chiqarish: Telegram kanalidan ALOHIDA hisob (ommaviy akkauntlar, shu sabab konservativ standart).
  social: { actions: ["distribution.send", "distribution.schedule", "distribution.retry", "distribution.plan_set"], max: () => config.MCP_WRITE_LIMIT_SOCIAL_SENDS_PER_DAY, windowSeconds: DAY, label: "social network posts (send, schedule, plan, retry) per day", envName: "MCP_WRITE_LIMIT_SOCIAL_SENDS_PER_DAY" },
  moderate: { actions: ["comment.status"], max: () => config.MCP_WRITE_LIMIT_MODERATION_PER_HOUR, windowSeconds: HOUR, label: "comment moderation actions per hour", envName: "MCP_WRITE_LIMIT_MODERATION_PER_HOUR" },
  destructive: {
    actions: ["post.trash", "post.purge", "tag.delete", "media.delete", "comment.delete", "comment.ban", "distribution.remove"],
    max: () => config.MCP_WRITE_LIMIT_DESTRUCTIVE_PER_DAY,
    windowSeconds: DAY,
    label: "deleting actions (trash, delete, ban) per day",
    envName: "MCP_WRITE_LIMIT_DESTRUCTIVE_PER_DAY",
  },
};

/** Chegaradan oshgan bo'lsa `rate_limited` xatosini tashlaydi (qaysi chegara, nechta, qachon yangilanishi bilan). */
export async function enforceWriteLimit(ctx: McpToolContext, category: WriteLimitCategory, now: Date = new Date()): Promise<void> {
  const spec = WRITE_LIMITS[category];
  const max = spec.max();
  if (max <= 0) return;
  const since = new Date(now.getTime() - spec.windowSeconds * 1000);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int`, oldest: sql<Date | null>`min(${auditLog.createdAt})` })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.via, "mcp"),
        sql`${auditLog.meta}->>'client' = ${ctx.client.id}`,
        inArray(auditLog.action, spec.actions),
        gte(auditLog.createdAt, since),
      ),
    );
  const count = row?.count ?? 0;
  if (count < max) return;

  const oldest = row?.oldest ? new Date(row.oldest) : now;
  const resetsAt = new Date(oldest.getTime() + spec.windowSeconds * 1000);
  const retryAfterSeconds = Math.max(1, Math.ceil((resetsAt.getTime() - now.getTime()) / 1000));
  throw new ToolError(
    "rate_limited",
    `Rate limit reached for this connection: ${max} ${spec.label}.`,
    `Wait until ${resetsAt.toISOString()} (about ${Math.ceil(retryAfterSeconds / 60)} min) or ask the owner to raise ${spec.envName}. Dry runs and read tools are not limited this way.`,
    { limit: { category, max, window: spec.windowSeconds === HOUR ? "1 hour" : "24 hours", used: count }, resetsAt: resetsAt.toISOString(), retryAfterSeconds },
  );
}

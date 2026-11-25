import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { AuditListQuery, AuditListResponse } from "@blog/shared";
import { db } from "../../db/index.js";
import { user } from "../../db/auth-schema.js";
import { auditLog } from "../../db/schema.js";

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` — kun boshi/oxiri (UTC); to'liq ISO — aynan o'sha payt. */
function boundary(value: string, edge: "start" | "end"): Date {
  if (DATE_ONLY_RE.test(value)) {
    return new Date(`${value}T${edge === "start" ? "00:00:00.000" : "23:59:59.999"}Z`);
  }
  return new Date(value);
}

/**
 * Admin amallari jurnali (faqat o'qish). `GET /admin/audit` va MCP `list_audit_log` bir xil funksiyadan
 * foydalanadi. Sahifalash boshqa admin ro'yxatlari bilan bir xil: `page`/`limit`/`total`/`hasMore`.
 */
export async function listAuditEntries(query: AuditListQuery): Promise<AuditListResponse> {
  const { entityType, entityId, actor, via, action, from, to, page, limit } = query;
  const offset = (page - 1) * limit;

  const conditions = [];
  if (entityType) conditions.push(eq(auditLog.entityType, entityType));
  if (entityId) conditions.push(eq(auditLog.entityId, entityId));
  if (actor) conditions.push(eq(auditLog.actorUserId, actor));
  if (via) conditions.push(eq(auditLog.via, via));
  if (action) conditions.push(eq(auditLog.action, action));
  if (from) conditions.push(gte(auditLog.createdAt, boundary(from, "start")));
  if (to) conditions.push(lte(auditLog.createdAt, boundary(to, "end")));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, countRows] = await Promise.all([
    db
      .select()
      .from(auditLog)
      .where(whereClause)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`count(*)::int` }).from(auditLog).where(whereClause),
  ]);

  const actorIds = [...new Set(rows.map((row) => row.actorUserId).filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string | null>();
  if (actorIds.length > 0) {
    const users = await db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(inArray(user.id, actorIds));
    for (const row of users) names.set(row.id, row.name || row.email);
  }

  const total = countRows[0]?.count ?? 0;
  return {
    items: rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      actor: row.actorUserId ? { id: row.actorUserId, name: names.get(row.actorUserId) ?? null } : null,
      actorRole: row.actorRole,
      via: row.via,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      summary: row.summary,
      meta: (row.meta ?? {}) as Record<string, unknown>,
    })),
    page,
    limit,
    total,
    hasMore: page * limit < total,
  };
}

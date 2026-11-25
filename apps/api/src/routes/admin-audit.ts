import { Hono } from "hono";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { AuditListQuerySchema, type AuditListResponse } from "@blog/shared";
import { db } from "../db/index.js";
import { user } from "../db/auth-schema.js";
import { auditLog } from "../db/schema.js";
import { requireAdmin } from "../lib/require-admin.js";

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` — kun boshi/oxiri (UTC); to'liq ISO — aynan o'sha payt. */
function boundary(value: string, edge: "start" | "end"): Date {
  if (DATE_ONLY_RE.test(value)) {
    return new Date(`${value}T${edge === "start" ? "00:00:00.000" : "23:59:59.999"}Z`);
  }
  return new Date(value);
}

/** Admin amallari jurnali (faqat admin, faqat o'qish). Sahifalash boshqa admin ro'yxatlari bilan bir xil: `page`/`limit`/`total`/`hasMore`. */
export const adminAuditRoute = new Hono().use("*", requireAdmin).get("/", async (c) => {
  const parsed = AuditListQuerySchema.safeParse({
    entityType: c.req.query("entityType"),
    entityId: c.req.query("entityId"),
    actor: c.req.query("actor"),
    via: c.req.query("via"),
    action: c.req.query("action"),
    from: c.req.query("from"),
    to: c.req.query("to"),
    page: c.req.query("page"),
    limit: c.req.query("limit"),
  });
  if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov parametrlari" }, 400);

  const { entityType, entityId, actor, via, action, from, to, page, limit } = parsed.data;
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
  const body: AuditListResponse = {
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
  return c.json(body);
});

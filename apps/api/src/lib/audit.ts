import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "../db/index.js";
import { auditLog } from "../db/schema.js";
import type { Executor } from "./executor.js";
import type { Actor } from "./posts/types.js";

export interface AuditEntry {
  /** Masalan `post.publish`, `comment.delete`, `tag.create`. */
  action: string;
  entityType: string;
  entityId?: string | null;
  /** Qisqa, odam o'qiydigan tavsif (o'zbekcha). */
  summary: string;
  /** Kichik jsonb — o'zgargan maydon nomlari, holat from -> to. To'liq kontent va sirlar EMAS. */
  meta?: Record<string, unknown>;
}

const SECRET_KEY_RE = /token|secret|password|passwd|cookie|authorization|api[-_]?key|access[-_]?key|private/i;
const MAX_STRING = 200;
const MAX_ARRAY = 50;
const MAX_DEPTH = 3;
const MAX_SUMMARY = 300;

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(key)) continue;
      const clean = sanitizeValue(inner, depth + 1);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  }
  return undefined;
}

/**
 * Jurnalga yoziladigan `meta`ni tozalaydi: sirga o'xshash kalitlar (token/secret/password/cookie/...) tashlab
 * yuboriladi, uzun matnlar qirqiladi, chuqurlik va massiv uzunligi cheklanadi.
 */
export function sanitizeAuditMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!meta) return {};
  return (sanitizeValue(meta, 0) as Record<string, unknown>) ?? {};
}

function clipSummary(summary: string): string {
  return summary.length > MAX_SUMMARY ? `${summary.slice(0, MAX_SUMMARY)}…` : summary;
}

function toRow(actor: Actor, entry: AuditEntry) {
  return {
    createdAt: new Date(),
    actorUserId: actor.userId,
    actorRole: actor.role,
    via: actor.via,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    summary: clipSummary(entry.summary),
    meta: sanitizeAuditMeta(actor.mcp ? { ...(entry.meta ?? {}), client: actor.mcp.clientId, clientName: actor.mcp.clientName, tool: actor.mcp.tool } : entry.meta),
  };
}

/**
 * Jurnalga yozadi. Post xizmati buni O'ZGARISH BILAN BIR TRANZAKSIYADA chaqiradi — yozuv muvaffaqiyatsiz
 * bo'lsa o'zgarish ham bekor qilinadi (xato yuqoriga uzatiladi).
 */
export async function recordAudit(executor: Executor, actor: Actor, entry: AuditEntry): Promise<void> {
  await executor.insert(auditLog).values(toRow(actor, entry));
}

/**
 * Post tahrirlari uchun: avtosaqlash har ~1.5 soniyada PATCH yuboradi — jurnalni to'ldirib yubormaslik uchun
 * AYNI aktyor + AYNI kanal + AYNI post uchun `windowMs` ichidagi oxirgi `action` yozuvi yangilanadi
 * (maydonlar birlashtiriladi, `count` oshadi), aks holda yangi qator yoziladi.
 */
export async function recordAuditCoalesced(
  executor: Executor,
  actor: Actor,
  entry: AuditEntry & { entityId: string; fields: string[] },
  windowMs: number,
): Promise<void> {
  const since = new Date(Date.now() - windowMs);
  const [previous] = await executor
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, entry.action),
        eq(auditLog.entityType, entry.entityType),
        eq(auditLog.entityId, entry.entityId),
        eq(auditLog.via, actor.via),
        actor.userId ? eq(auditLog.actorUserId, actor.userId) : undefined,
        gte(auditLog.createdAt, since),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1);

  const { fields, ...base } = entry;
  const previousMeta = (previous?.meta ?? {}) as { fields?: unknown; count?: unknown };
  const previousFields = Array.isArray(previousMeta.fields) ? (previousMeta.fields as string[]) : [];

  if (previous && (actor.userId !== null || previous.actorUserId === null)) {
    const merged = [...new Set([...previousFields, ...fields])];
    const count = (typeof previousMeta.count === "number" ? previousMeta.count : 1) + 1;
    await executor
      .update(auditLog)
      .set({
        summary: clipSummary(base.summary),
        meta: sanitizeAuditMeta({ ...(base.meta ?? {}), fields: merged, count, lastAt: new Date().toISOString() }),
      })
      .where(eq(auditLog.id, previous.id));
    return;
  }

  await recordAudit(executor, actor, {
    ...base,
    meta: { ...(base.meta ?? {}), fields, count: 1 },
  });
}

/**
 * Tranzaksiyadan TASHQARIDA (teg, media, izoh, sozlamalar kabi) mavjud chaqiruv joylari uchun: amal allaqachon
 * bajarilgan, shu sabab jurnal yozuvi xato bersa admin amali 500 bilan buzilmasin — xato faqat log qilinadi.
 */
export async function recordAuditSafe(actor: Actor, entry: AuditEntry): Promise<void> {
  try {
    await recordAudit(db, actor, entry);
  } catch (error: unknown) {
    console.error("Audit jurnaliga yozib bo'lmadi:", error instanceof Error ? error.message : error);
  }
}

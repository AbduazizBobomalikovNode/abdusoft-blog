import type { AuditLogItem } from "@blog/shared";
import { auditActionLabel, entityLabel } from "@/lib/admin-labels";

/**
 * Jurnal qatorining "obyekt" ustuni: tur + (post uchun) hozirgi sarlavha. Post hali mavjud bo'lsa — havola; o'chirilgan
 * bo'lsa (yoki savatda) — havolasiz va "endi yo'q" belgisi bilan.
 */
export interface AuditTarget {
  kind: string;
  label: string;
  title: string | null;
  href: string | null;
  gone: boolean;
}

export function auditTarget(item: Pick<AuditLogItem, "entityType" | "entityId">, posts: ReadonlyMap<string, string>): AuditTarget {
  const kind = entityLabel(item.entityType);
  if (item.entityType === "post" && item.entityId) {
    const title = posts.get(item.entityId);
    if (title !== undefined) {
      return { kind, label: kind, title, href: `/admin/postlar/${item.entityId}`, gone: false };
    }
    return { kind, label: kind, title: null, href: null, gone: true };
  }
  return { kind, label: kind, title: null, href: null, gone: false };
}

/** Jurnal yozuvi `meta`sidagi `fields` ro'yxati (tahrirlangan maydonlar) — qisqa matn; yo'q bo'lsa `null`. */
export function auditFieldsText(meta: Record<string, unknown>): string | null {
  const fields = meta.fields;
  if (!Array.isArray(fields) || fields.length === 0) return null;
  const names = fields.filter((f): f is string => typeof f === "string");
  return names.length > 0 ? names.join(", ") : null;
}

export { auditActionLabel };

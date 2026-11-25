import type { AuditLogItem } from "@blog/shared";
import { entityLabel } from "@/lib/admin-labels";

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


export interface AuditQueryState {
  via?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  from?: string;
  to?: string;
}

const BASE = "/admin/jurnal";

export function auditHref(state: AuditQueryState, overrides: Partial<Record<keyof AuditQueryState, string | undefined>> = {}): string {
  const merged = { ...state, ...overrides };
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value) search.set(key, value);
  }
  const qs = search.toString();
  return qs ? `${BASE}?${qs}` : BASE;
}


const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Jurnal so'rovidagi `entityId` faqat UUID bo'lsa havola/filtr uchun ishlatiladi. */
export function validEntityId(value: string | undefined | null): string | undefined {
  const v = value?.trim();
  return v && UUID_RE.test(v) ? v : undefined;
}

/**
 * Jurnal qatorining qisqacha matni: API `summary`si ko'pincha amal nomi bilan boshlanadi ("Post tahrirlandi: ...") —
 * u alohida ko'rsatilgani uchun takrorlamaymiz. Qolgani bo'sh bo'lsa `null`.
 */
export function summaryWithoutAction(summary: string, actionLabel: string): string | null {
  const s = summary.trim();
  if (s.toLowerCase().startsWith(actionLabel.toLowerCase())) {
    const rest = s.slice(actionLabel.length).replace(/^[\s:—-]+/, "");
    return rest.length > 0 ? rest : null;
  }
  return s.length > 0 ? s : null;
}

/** Bo'sh qismlarsiz ajratgich bilan birlashtiradi (oxirida osilib qolgan "·" bo'lmasin). */
export function joinMeta(parts: (string | null | undefined | false)[]): string[] {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0);
}

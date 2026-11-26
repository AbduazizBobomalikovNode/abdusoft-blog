import type { Role } from "@blog/shared";

/** Amal qaysi kanaldan kelgani — audit logda va (keyingi bosqichda) MCP/Telegram izlashda ishlatiladi. */
export type ActorVia = "web" | "mcp" | "telegram" | "scheduler" | "system";

export type ActorRole = Role | "system";

/**
 * Post xizmatini chaqiruvchi. HTTP `Context`ga bog'liq emas — shu sabab kelajakdagi
 * HTTP bo'lmagan chaqiruvchilar (MCP, Telegram, scheduler) ham bir xil qoidalar ostida ishlaydi.
 * `userId` — scheduler/tizim amallari uchun `null` (o'ylab topilgan id yo'q).
 */
export interface Actor {
  userId: string | null;
  role: ActorRole;
  via: ActorVia;
  /**
   * Faqat `via: "mcp"` uchun: qaysi ulangan ilova va qaysi vosita. Jurnal yozuvlariga (`meta.client`, `meta.tool`) avtomatik
   * qo'shiladi — shu sabab har bir yozuv "kim, qaysi ilova, qaysi vosita" bilan izlanadi (kontent va sirlarsiz).
   */
  mcp?: { clientId: string; clientName: string | null; tool: string; channelsSend: boolean };
}

/** Rejalashtirilgan postlarni chop etuvchi tizim aktyori (foydalanuvchi yo'q). */
export const SCHEDULER_ACTOR: Actor = { userId: null, role: "system", via: "scheduler" };

export function actorFromAdminUser(adminUser: { id: string; role: Role }, via: ActorVia = "web"): Actor {
  return { userId: adminUser.id, role: adminUser.role, via };
}

/** Admin yoki tizim aktyori — admin-only amallarga ruxsat. */
export function isAdminActor(actor: Actor): boolean {
  return actor.role === "admin" || actor.role === "system";
}

/**
 * Xizmat xatolari. `kind` HTTP status bilan bir-ma-bir mos (route qatlami shu jadval orqali aylantiradi),
 * lekin xizmat o'zi Hono'ga bog'liq emas.
 */
export type ServiceErrorKind = "bad_request" | "forbidden" | "not_found" | "conflict" | "unprocessable" | "rate_limited";

export const SERVICE_ERROR_STATUS = {
  bad_request: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unprocessable: 422,
  rate_limited: 429,
} as const satisfies Record<ServiceErrorKind, number>;

export interface ServiceError {
  kind: ServiceErrorKind;
  /** Foydalanuvchiga ko'rsatiladigan (o'zbekcha) xabar — HTTP javobida `error` maydoni. */
  message: string;
  /** HTTP javob tanasiga `error` yoniga qo'shiladigan qo'shimcha maydonlar (masalan `issues`, `preflight`). */
  extra?: Record<string, unknown>;
}

export type ServiceFailure = { ok: false; error: ServiceError };

export type ServiceResult<T> = { ok: true; data: T } | ServiceFailure;

export function ok<T>(data: T): ServiceResult<T> {
  return { ok: true, data };
}

export function fail(kind: ServiceErrorKind, message: string, extra?: Record<string, unknown>): ServiceFailure {
  return { ok: false, error: { kind, message, ...(extra ? { extra } : {}) } };
}

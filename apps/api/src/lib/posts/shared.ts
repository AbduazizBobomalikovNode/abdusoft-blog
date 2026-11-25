import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  ChannelPlanSchema,
  DEFAULT_POST_SETTINGS,
  PostSettingsSchema,
  type ChannelPlan,
  type PostAuthorRef,
  type PostSettings,
} from "@blog/shared";
import { db } from "../../db/index.js";
import { user } from "../../db/auth-schema.js";
import { posts } from "../../db/schema.js";
import type { Executor } from "../executor.js";
import { fail, isAdminActor, type Actor, type ServiceFailure } from "./types.js";

export type { Executor };

/** Jurnal xulosalarida post nomi (qisqartirilgan). */
export function postLabel(post: { title: string }): string {
  const title = post.title.trim() || "Nomsiz";
  return `"${title.length > 80 ? `${title.slice(0, 80)}…` : title}"`;
}


export type PostRow = typeof posts.$inferSelect;

/** Jonli (chiqindi qutisida EMAS) postni yuklaydi — chiqindi qutisidagi post "topilmadi". */
export async function loadPost(executor: Executor, id: string): Promise<PostRow | null> {
  const [row] = await executor.select().from(posts).where(and(eq(posts.id, id), isNull(posts.deletedAt))).limit(1);
  return row ?? null;
}

/** Faqat chiqindi qutisidagi postni yuklaydi. */
export async function loadTrashedPost(executor: Executor, id: string): Promise<PostRow | null> {
  const [row] = await executor.select().from(posts).where(and(eq(posts.id, id), isNotNull(posts.deletedAt))).limit(1);
  return row ?? null;
}

/** DB'dagi `channel_plan` jsonb'ni tekshiradi (buzilgan qiymat -> `null`). */
export function parseStoredPlan(value: unknown): ChannelPlan | null {
  if (value == null) return null;
  const parsed = ChannelPlanSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Saqlangan `settings` jsonb'ni standart qiymatlar bilan birlashtirib tekshiradi. */
export function resolveSettings(stored: unknown, override?: Partial<PostSettings>): PostSettings {
  return PostSettingsSchema.parse({
    ...DEFAULT_POST_SETTINGS,
    ...((stored as Record<string, unknown>) ?? {}),
    ...(override ?? {}),
  });
}

/** Bitta so'rovda barcha (berilgan) foydalanuvchi nomlarini oldindan yuklaydi. */
export async function authorNamesForIds(ids: (string | null)[]): Promise<Map<string, string | null>> {
  const uniqueIds = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (uniqueIds.length === 0) return new Map();
  const rows = await db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(inArray(user.id, uniqueIds));
  return new Map(rows.map((row) => [row.id, row.name || row.email]));
}

export function toAuthorRef(id: string | null, authorMap: Map<string, string | null>): PostAuthorRef | null {
  if (!id) return null;
  return { id, name: authorMap.get(id) ?? null };
}

export function toLifecycleSummary(post: PostRow) {
  return {
    id: post.id,
    slug: post.slug,
    status: post.status,
    publishedAt: post.publishedAt?.toISOString() ?? null,
    scheduledAt: post.scheduledAt?.toISOString() ?? null,
    pinned: post.pinned,
    updatedAt: post.updatedAt.toISOString(),
  };
}

export type LifecycleSummary = ReturnType<typeof toLifecycleSummary>;

/** Faqat admin (yoki tizim) bajaradigan amallar — xodimga `403 Forbidden`. */
export function requireAdminActor(actor: Actor): ServiceFailure | null {
  if (isAdminActor(actor)) return null;
  return fail("forbidden", "Forbidden");
}

/** Xodim FAQAT o'z postlarini ko'radi (GET/preview). */
export function checkCanView(actor: Actor, post: PostRow): ServiceFailure | null {
  if (actor.role === "staff" && post.createdBy !== actor.userId) {
    return fail("forbidden", "Faqat o'z postlaringizni ko'rishingiz mumkin");
  }
  return null;
}

/** Xodim FAQAT o'z postini, FAQAT `draft`/`changes_requested` holatida tahrirlaydi. */
export function checkCanEdit(actor: Actor, post: PostRow): ServiceFailure | null {
  if (actor.role !== "staff") return null;
  if (post.createdBy !== actor.userId) {
    return fail("forbidden", "Faqat o'z postlaringizni tahrirlashingiz mumkin");
  }
  if (post.status !== "draft" && post.status !== "changes_requested") {
    return fail("conflict", "Post ko'rib chiqishda yoki chop etilgan — hozir tahrirlab bo'lmaydi");
  }
  return null;
}

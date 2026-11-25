import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { analyzeDocMarkdown, type ContentNode } from "@blog/shared";
import { config } from "../../../config.js";
import { db } from "../../../db/index.js";
import { postRevisions, posts } from "../../../db/schema.js";
import { tagsForPostIds } from "../../../routes/posts.js";
import { authorNamesForIds, type PostRow } from "../../posts/shared.js";
import type { ServiceFailure, ServiceResult } from "../../posts/types.js";
import { ToolError, type ToolErrorCode } from "./types.js";
import type { ServiceErrorKind } from "../../posts/types.js";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const uuidField = (what: string) => z.string().regex(UUID_RE, `must be a UUID (${what})`);

/** Barcha o'zgartiruvchi post vositalarida MAJBURIY: oxirgi o'qishda olingan `updatedAt` (optimistik parallellik tokeni). */
export const expectedUpdatedAtField = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: "must be an ISO timestamp exactly as returned in post.updatedAt" })
  .describe("REQUIRED concurrency token: the post.updatedAt value you got from your latest read or write result, passed back unchanged. If the post changed meanwhile the call fails with a conflict instead of overwriting.");

export const idempotencyKeyField = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,80}$/, "8-80 characters: letters, digits and . _ : -")
  .optional()
  .describe("Optional but recommended: a unique string you invent per intended creation (8-80 chars). If the call is retried with the same key and arguments nothing is created twice - you get the first result back.");

export const dryRunField = z.boolean().optional().describe("When true nothing is changed: you only get a report of exactly what would happen and which checks pass or fail.");

export function adminUrlFor(postId: string): string {
  return `${config.WEB_ORIGIN.replace(/\/+$/, "")}/admin/postlar/${postId}`;
}

export function publicUrlFor(slug: string): string {
  return `${config.WEB_ORIGIN.replace(/\/+$/, "")}/${slug}`;
}

/** Barqaror, ixcham natija bloki — yangi `updatedAt` (keyingi chaqiruv tokeni), holat va havolalar. Kontent HECH QACHON qaytarilmaydi. */
export function postBlock(post: Pick<PostRow, "id" | "slug" | "title" | "status" | "updatedAt" | "scheduledAt" | "deletedAt">): Record<string, unknown> {
  const trashed = post.deletedAt !== null && post.deletedAt !== undefined;
  return {
    id: post.id,
    slug: post.slug,
    title: post.title,
    status: trashed ? "trashed" : post.status,
    updatedAt: post.updatedAt.toISOString(),
    ...(post.scheduledAt ? { scheduledAt: post.scheduledAt.toISOString() } : {}),
    adminUrl: adminUrlFor(post.id),
    publicUrl: !trashed && post.status === "published" ? publicUrlFor(post.slug) : null,
  };
}

/** Jonli YOKI chiqindi qutisidagi postni yuklaydi (holatni aniqlash uchun). */
export async function loadPostAnyState(id: string): Promise<PostRow | null> {
  const [row] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
  return row ?? null;
}

const STABLE = (value: unknown) => JSON.stringify(value);

/**
 * Konflikt tushuntirishi: post oxirgi saqlangan versiyadan (revision) qaysi maydonlarda farq qiladi. Revision har bir
 * konnektor o'zgarishidan OLDIN olinadi, shuning uchun bu odatda "so'nggi o'zgarish aynan nima edi"ga javob beradi
 * (veb-panelning avtosaqlashlari birlashtirilishi mumkin — u holda ro'yxat kengroq bo'lishi mumkin).
 */
export async function describeRecentChange(post: PostRow): Promise<{ changedFields: string[]; comparedWith: string | null }> {
  const [latest] = await db.select().from(postRevisions).where(eq(postRevisions.postId, post.id)).orderBy(desc(postRevisions.seq)).limit(1);
  if (!latest) return { changedFields: [], comparedWith: null };
  const currentTags = ((await tagsForPostIds([post.id])).get(post.id) ?? []).map((tag) => tag.slug).sort();
  const changed: string[] = [];
  if (latest.title !== post.title) changed.push("title");
  if (latest.slug !== post.slug) changed.push("slug");
  if ((latest.excerpt ?? null) !== (post.excerpt ?? null)) changed.push("excerpt");
  if (STABLE(latest.contentJson) !== STABLE(post.contentJson)) changed.push("content");
  if ((latest.coverUrl ?? null) !== (post.coverUrl ?? null)) changed.push("cover");
  if (STABLE([...(latest.tagSlugs ?? [])].sort()) !== STABLE(currentTags)) changed.push("tags");
  if (STABLE(latest.settings ?? {}) !== STABLE(post.settings ?? {})) changed.push("settings");
  if (latest.status !== post.status) changed.push(`status (${latest.status} -> ${post.status})`);
  return { changedFields: changed, comparedWith: latest.createdAt.toISOString() };
}

export async function conflictError(post: PostRow, extra: { updatedBy?: { id: string; name: string | null } | null; via?: string | null }): Promise<ToolError> {
  const names = await authorNamesForIds([post.updatedBy]);
  const who = post.updatedBy ? { id: post.updatedBy, name: names.get(post.updatedBy) ?? null } : (extra.updatedBy ?? null);
  const { changedFields, comparedWith } = await describeRecentChange(post);
  return new ToolError(
    "conflict",
    "The post was changed after you read it, so nothing was written.",
    "Re-read the post with get_post (it returns the fresh updatedAt), look at what changed, merge your intent into the current content, then retry with the fresh updatedAt. There is no way to force an overwrite.",
    {
      currentUpdatedAt: post.updatedAt.toISOString(),
      lastChangedBy: who,
      lastChangedVia: post.updatedVia ?? extra.via ?? null,
      changedSinceLastRevision: changedFields,
      comparedWithRevisionAt: comparedWith,
      comparisonNote: "changedSinceLastRevision compares the post with its newest saved revision (taken just before the latest change); edits made in the web editor within 10 minutes may be merged into one revision, so the list can be broader than the single latest change.",
    },
  );
}

const KIND_TO_CODE: Record<ServiceErrorKind, ToolErrorCode> = {
  bad_request: "invalid_input",
  forbidden: "forbidden",
  not_found: "not_found",
  conflict: "conflict",
  unprocessable: "unprocessable",
};

/**
 * Xizmat natijasini ochadi. Parallellik (`updatedAt`) konflikti boyitilgan `conflict` xatosiga aylanadi (kim, qaysi kanal,
 * yangi token, farq qilgan maydonlar); boshqa xatolar inglizcha tushuntirish + xizmatning asl (o'zbekcha) xabari bilan.
 */
export async function unwrapPost<T>(result: ServiceResult<T>, postId: string, hints: { notFound?: string } = {}): Promise<T> {
  if (result.ok) return result.data;
  const failure: ServiceFailure = result;
  const { kind, message, extra } = failure.error;
  if (kind === "conflict" && extra && typeof extra.updatedAt === "string") {
    const post = await loadPostAnyState(postId);
    if (post) throw await conflictError(post, { updatedBy: (extra.updatedBy as { id: string; name: string | null } | null) ?? null, via: (extra.via as string | null) ?? null });
  }
  const english: Record<ServiceErrorKind, string> = {
    bad_request: "The request was rejected",
    forbidden: "This action is not allowed",
    not_found: "Not found",
    conflict: "The action conflicts with the post's current state",
    unprocessable: "The request could not be processed",
  };
  throw new ToolError(
    KIND_TO_CODE[kind],
    `${english[kind]}: ${message}`,
    kind === "not_found"
      ? (hints.notFound ?? "Check the id with list_posts. Trashed posts can only be restored (restore_post_from_trash) or purged.")
      : kind === "conflict"
        ? "Read the post (get_post) to see its current status, then choose an action that fits it."
        : undefined,
    extra,
  );
}

/** Token tekshiruvi (xizmat chaqirmasdan — quruq yurish va "allaqachon shu holatda" yo'llari uchun). */
export async function assertFreshToken(post: PostRow, expected: string): Promise<void> {
  if (post.updatedAt.getTime() !== Date.parse(expected)) throw await conflictError(post, {});
}

/** Hujjat (Markdown yoki tuzilmaviy) uchun umumiy o'lcham chegaralari. */
export const CONTENT_MAX_CHARS = 80_000;

export const contentDocumentSchema = z
  .object({ type: z.literal("doc"), content: z.array(z.record(z.string(), z.unknown())).max(5000) })
  .passthrough()
  .describe("A Tiptap/ProseMirror document: {type:'doc', content:[blocks...]}. Prefer content_markdown unless you need exact structure (for example to keep blocks Markdown cannot express).");

/** Markdown matni -> hujjat (birinchi `# ` sarlavha qabul qilinmaydi: sarlavha `title` maydonida). */
export function lossyReport(doc: unknown) {
  return analyzeDocMarkdown((doc ?? null) as ContentNode | null);
}

export async function tagSlugsOf(postId: string): Promise<string[]> {
  return ((await tagsForPostIds([postId])).get(postId) ?? []).map((tag) => tag.slug);
}

/** Nomaʼlum teg slug'lari bo'lsa xato (xizmat ularni jimgina tashlab yuborardi). */
export async function assertTagsExist(slugs: string[]): Promise<void> {
  if (slugs.length === 0) return;
  const { tags } = await import("../../../db/schema.js");
  const rows = await db.select({ slug: tags.slug }).from(tags).where(inArray(tags.slug, slugs));
  const known = new Set(rows.map((row) => row.slug));
  const unknown = [...new Set(slugs)].filter((slug) => !known.has(slug));
  if (unknown.length > 0) {
    throw new ToolError("invalid_input", `Unknown tag slug(s): ${unknown.join(", ")}.`, "Use list_tags to see existing tags, or create_tag to add a new one first.", { unknownTags: unknown });
  }
}

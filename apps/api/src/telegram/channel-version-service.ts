import { and, asc, eq, sql } from "drizzle-orm";
import {
  CHANNEL_MODE_VARIANTS,
  CHANNEL_VARIANT_BUDGETS,
  TELEGRAM_LIMITS,
  isChannelComboValid,
  type ChannelMode,
  type ChannelVersion,
  type ChannelVersionsResponse,
  type CreateChannelVersionBody,
  type UpdateChannelVersionBody,
} from "@blog/shared";
import { db } from "../db/index.js";
import { channelPostVersions, posts } from "../db/schema.js";
import { computeChannelPost } from "./channel-send.js";
import { clearChoiceIfVersion, resolveChannelChoice } from "./channel-choice.js";
import { telegramHtmlToDoc, validateRestrictedDoc } from "./channel-html.js";
import {
  collectPostImages,
  loadVersion,
  renderVersionContent,
  toVersionDto,
  validateImageSubset,
} from "./channel-versions.js";

type PostRow = typeof posts.$inferSelect;
export type VersionServiceResult<T> = { ok: true; data: T } | { ok: false; status: 400 | 404 | 409; error: string };

const fail = (status: 400 | 404 | 409, error: string): { ok: false; status: 400 | 404 | 409; error: string } => ({
  ok: false,
  status,
  error,
});

export async function listChannelVersions(post: PostRow): Promise<ChannelVersionsResponse> {
  const rows = await db
    .select()
    .from(channelPostVersions)
    .where(eq(channelPostVersions.postId, post.id))
    .orderBy(asc(channelPostVersions.createdAt));
  const autoVariants = (["media", "text"] as const).flatMap((mode) =>
    CHANNEL_MODE_VARIANTS[mode].map((variant) => ({
      mode,
      variant,
      limit: CHANNEL_VARIANT_BUDGETS[mode][variant] ?? 0,
    })),
  );
  return {
    versions: rows.map((row) => toVersionDto(row, post)),
    autoVariants,
    postImages: collectPostImages(post),
    choice: await resolveChannelChoice(post),
  };
}

/** "Versiya N" — hali band bo'lmagan eng kichik N (mavjud versiyalar soni + 1 dan boshlab). */
async function nextDefaultName(postId: string): Promise<string> {
  const rows = await db.select({ name: channelPostVersions.name }).from(channelPostVersions).where(eq(channelPostVersions.postId, postId));
  const names = new Set(rows.map((r) => r.name));
  let n = rows.length + 1;
  while (names.has(`Versiya ${n}`)) n += 1;
  return `Versiya ${n}`;
}

/** Rasmli rejim uchun standart tanlov: kover birinchi, so'ng kontent rasmlari (≤ 10). */
function defaultImages(post: Pick<PostRow, "coverUrl" | "contentJson">): string[] {
  return collectPostImages(post)
    .slice(0, TELEGRAM_LIMITS.mediaGroupMaxItems)
    .map((i) => i.url);
}

export async function createChannelVersion(
  post: PostRow,
  body: CreateChannelVersionBody,
  createdBy: string | null,
): Promise<VersionServiceResult<ChannelVersion>> {
  if (body.fromVariant && body.fromVersionId) return fail(400, "fromVariant va fromVersionId birga berilmaydi");
  const mode: ChannelMode = body.mode;

  let contentJson: unknown;
  let imageUrls: string[] = [];
  let baseVariant: (typeof CHANNEL_MODE_VARIANTS)["media"][number] | null = null;

  if (body.fromVersionId) {
    const src = await loadVersion(post.id, body.fromVersionId);
    if (!src) return fail(404, "Versiya topilmadi");
    contentJson = src.contentJson;
    imageUrls = mode === "media" ? [...(src.imageUrls ?? [])] : [];
    baseVariant = src.baseVariant;
  } else {
    const variant = body.fromVariant ?? (mode === "media" ? "l" : "xl");
    if (!isChannelComboValid(mode, variant)) return fail(400, "Bu uzunlik ushbu rejim uchun mos emas");
    const computed = await computeChannelPost(post.id, mode, variant, { allowUnpublished: true, allowEmptyMedia: true });
    if (!computed.ok) return fail(404, "Topilmadi");
    contentJson = telegramHtmlToDoc(computed.data.captionHtml);
    imageUrls = computed.data.media.map((m) => m.url);
    baseVariant = variant;
  }

  if (mode === "media" && imageUrls.length === 0) imageUrls = defaultImages(post);

  const rendered = renderVersionContent(contentJson);
  const name = body.name ?? (await nextDefaultName(post.id));
  const [row] = await db
    .insert(channelPostVersions)
    .values({
      postId: post.id,
      name,
      mode,
      contentJson,
      textHtml: rendered.textHtml,
      visibleLength: rendered.visibleLength,
      imageUrls,
      baseVariant,
      createdBy,
    })
    .returning();
  if (!row) return fail(400, "Versiya yaratilmadi");
  return { ok: true, data: toVersionDto(row, post) };
}

export async function updateChannelVersion(
  post: PostRow,
  versionId: string,
  body: UpdateChannelVersionBody,
): Promise<VersionServiceResult<ChannelVersion>> {
  const existing = await loadVersion(post.id, versionId);
  if (!existing) return fail(404, "Versiya topilmadi");

  const mode = body.mode ?? existing.mode;
  const patch: Partial<typeof channelPostVersions.$inferInsert> = { updatedAt: new Date() };

  if (body.name !== undefined) patch.name = body.name;
  if (body.mode !== undefined) patch.mode = body.mode;

  let contentJson = existing.contentJson;
  if (body.contentJson !== undefined) {
    const problem = validateRestrictedDoc(body.contentJson);
    if (problem) return fail(400, problem);
    contentJson = body.contentJson;
    patch.contentJson = contentJson;
  }
  // Matn ham, rejim ham o'zgarmasa ham qayta hisoblash zarar qilmaydi (chegara rejimga bog'liq emas, lekin HTML bir xil).
  const rendered = renderVersionContent(contentJson);
  patch.textHtml = rendered.textHtml;
  patch.visibleLength = rendered.visibleLength;

  let imageUrls = existing.imageUrls ?? [];
  if (body.imageUrls !== undefined) imageUrls = body.imageUrls;
  if (mode === "text") {
    imageUrls = [];
  } else if (imageUrls.length === 0 && body.imageUrls === undefined && existing.mode === "text") {
    imageUrls = defaultImages(post);
  }
  if (imageUrls.length > TELEGRAM_LIMITS.mediaGroupMaxItems) {
    return fail(400, `Ko'pi bilan ${TELEGRAM_LIMITS.mediaGroupMaxItems} ta rasm tanlash mumkin`);
  }
  const subsetProblem = validateImageSubset(imageUrls, collectPostImages(post));
  if (subsetProblem) return fail(400, subsetProblem);
  patch.imageUrls = imageUrls;

  const [row] = await db
    .update(channelPostVersions)
    .set(patch)
    .where(and(eq(channelPostVersions.id, versionId), eq(channelPostVersions.postId, post.id)))
    .returning();
  if (!row) return fail(404, "Versiya topilmadi");
  return { ok: true, data: toVersionDto(row, post) };
}

/** Versiya kutilayotgan rejada ishlatilayotgan bo'lsa — o'chirib bo'lmaydi. */
export async function isVersionUsedByPendingPlan(postId: string, versionId: string): Promise<boolean> {
  const rows = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.id, postId), sql`${posts.channelPlan}->>'versionId' = ${versionId}`))
    .limit(1);
  return rows.length > 0;
}

/** O'chirilgan versiya belgilangan bo'lsa — belgi ham tozalanadi (`clearedChoice: true`). */
export async function deleteChannelVersion(
  post: PostRow,
  versionId: string,
): Promise<VersionServiceResult<{ ok: true; clearedChoice: boolean }>> {
  const existing = await loadVersion(post.id, versionId);
  if (!existing) return fail(404, "Versiya topilmadi");
  if (await isVersionUsedByPendingPlan(post.id, versionId)) {
    return fail(409, "Bu versiya rejalashtirilgan kanal rejasida ishlatilmoqda — avval rejani o'zgartiring");
  }
  await db.delete(channelPostVersions).where(eq(channelPostVersions.id, versionId));
  const clearedChoice = await clearChoiceIfVersion(post, versionId);
  return { ok: true, data: { ok: true, clearedChoice } };
}

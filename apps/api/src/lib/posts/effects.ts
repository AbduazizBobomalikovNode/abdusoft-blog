import { config } from "../../config.js";
import { events } from "../events.js";
import { pathsForPost, revalidateWeb } from "../revalidate.js";
import { tagsForPostIds } from "../../routes/posts.js";

async function tagSlugsFor(postId: string): Promise<string[]> {
  return (await tagsForPostIds([postId])).get(postId)?.map((t) => t.slug) ?? [];
}

/**
 * Chop etish yon ta'sirlari (post.published hodisasi -> Telegraph/kanal sinxronizatsiyasi, web ISR revalidate).
 * Admin marshruti, tasdiqlash (approve), scheduler VA Telegram buyrug'i — HAMMASI shu funksiyadan o'tadi.
 * Tranzaksiya COMMIT bo'lgandan KEYIN chaqiriladi.
 */
export async function announcePublished(post: { id: string; slug: string }, opts: { skipChannel?: boolean } = {}): Promise<void> {
  events.emit("post.published", { id: post.id, slug: post.slug, ...(opts.skipChannel ? { skipChannel: true } : {}) });
  revalidateWeb(pathsForPost(post.slug, await tagSlugsFor(post.id)));
  await runDistributionPlans(post.id, "publish");
}

/**
 * Ijtimoiy tarqatish "saytga chiqqach" rejalari: chop etilganda rejalashtirishga aylanadi, chop etilmay qolganda (qoralama/arxiv/qayta
 * rejalashtirish) kutish holatiga qaytadi. Bayroq o'chiq bo'lsa modul yuklanmaydi. Xato chop etishni BUZMAYDI (tick supurgisi qayta uriniladi).
 */
async function runDistributionPlans(postId: string, kind: "publish" | "unpublish"): Promise<void> {
  if (!config.DISTRIBUTION_ENABLED) return;
  try {
    const plans = await import("../distribution/service/plans.js");
    if (kind === "publish") await plans.materializePlansForPost(postId);
    else await plans.revertPlansForPost(postId);
  } catch (error: unknown) {
    console.error(`Tarqatish rejalarini yangilab bo'lmadi (${postId}):`, error instanceof Error ? error.message : "noma'lum xato");
  }
}

/** Chop etilgan post sayt/kanaldan olib tashlanganda (qoralama, arxiv, rejalashtirish, chiqindi qutisi). */
export async function announceUnpublished(post: { id: string; slug: string }, opts: { skipChannel?: boolean } = {}): Promise<void> {
  events.emit("post.unpublished", { id: post.id, slug: post.slug, ...(opts.skipChannel ? { skipChannel: true } : {}) });
  revalidateWeb(pathsForPost(post.slug, await tagSlugsFor(post.id)));
  await runDistributionPlans(post.id, "unpublish");
}

/** Chop etilgan postning mazmuni o'zgarganda. `previousSlug` berilsa, eski yo'l ham yangilanadi. */
export async function announceUpdated(
  post: { id: string; slug: string },
  opts: { tagSlugs?: string[] | null; previousSlug?: string | null; skipChannel?: boolean } = {},
): Promise<void> {
  events.emit("post.updated", { id: post.id, slug: post.slug, ...(opts.skipChannel ? { skipChannel: true } : {}) });
  const tagSlugs = opts.tagSlugs ?? (await tagSlugsFor(post.id));
  const paths = pathsForPost(post.slug, tagSlugs);
  if (opts.previousSlug && opts.previousSlug !== post.slug) {
    paths.push(`/${opts.previousSlug}`);
  }
  revalidateWeb(paths);
}

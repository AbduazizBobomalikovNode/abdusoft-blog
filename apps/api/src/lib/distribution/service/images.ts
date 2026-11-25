import { createHash } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import sharp from "sharp";
import type { DistributionImageChoice } from "@blog/shared";
import { config } from "../../../config.js";
import { db } from "../../../db/index.js";
import { distributionImages } from "../../../db/schema.js";
import { getPreparedImage, type PreparedImage } from "../../../telegram/channel-media.js";
import { deleteStoredFile, storeProcessedFile } from "../../media/store.js";
import { getSettings } from "../../settings.js";

/**
 * Ijtimoiy rasm: postning muqovasi, bo'lmasa saytning o'zi yaratgan Open Graph rasmi (FAQAT blogning o'z veb-originidan).
 * Mavjud rasm quvuri (`getPreparedImage`: xavfsiz yuklash + JPEG) ishlatiladi, so'ng platformalarga mos qilinadi:
 * uzun tomon <= 1440 px, nisbat 4:5 .. 1.91:1 (Instagram chegarasi; markazdan kesiladi). Natija post bo'yicha keshlanadi
 * (Instagram/Threads uchun ommaviy JPEG URL — blogning o'z media saqlashida).
 */

/** `apps/web` `app/(site)/[slug]/opengraph-image` marshrutiga Next qo'shadigan hash (web `lib/json-ld.ts` `OG_IMAGE_ROUTE_SUFFIX`, testi bor). */
export const OG_IMAGE_ROUTE_SUFFIX = "19c4ir";

export const SOCIAL_IMAGE_MAX_SIDE = 1440;
export const SOCIAL_ASPECT_MIN = 4 / 5;
export const SOCIAL_ASPECT_MAX = 1.91;
const JPEG_QUALITY = 86;

export interface ImagePostRef {
  id: string;
  slug: string;
  coverUrl: string | null;
}

export type SocialImageResult =
  | { ok: true; source: "cover" | "og"; sourceUrl: string; buffer: Buffer; mime: "image/jpeg"; width: number; height: number; sizeBytes: number; fingerprint: string }
  | { ok: false; error: string };

export function ogImageSourceUrl(slug: string): string {
  return `${config.WEB_ORIGIN.replace(/\/+$/, "")}/${encodeURIComponent(slug)}/opengraph-image-${OG_IMAGE_ROUTE_SUFFIX}`;
}

/** Faqat blogning o'z veb-originidagi URL. */
export function isOwnWebOriginUrl(url: string): boolean {
  try {
    return new URL(url).origin === new URL(config.WEB_ORIGIN).origin;
  } catch {
    return false;
  }
}

export type SourceLoader = (url: string) => Promise<PreparedImage>;
let loader: SourceLoader = getPreparedImage;
/** Faqat testlar uchun. */
export function setSocialImageLoader(next: SourceLoader | null): void {
  loader = next ?? getPreparedImage;
}

async function toSocialJpeg(input: Buffer): Promise<{ buffer: Buffer; width: number; height: number }> {
  const meta = await sharp(input).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  let pipeline = sharp(input);
  if (w > 0 && h > 0) {
    const aspect = w / h;
    if (aspect > SOCIAL_ASPECT_MAX) pipeline = pipeline.extract({ left: Math.floor((w - Math.floor(h * SOCIAL_ASPECT_MAX)) / 2), top: 0, width: Math.floor(h * SOCIAL_ASPECT_MAX), height: h });
    else if (aspect < SOCIAL_ASPECT_MIN) pipeline = pipeline.extract({ left: 0, top: Math.floor((h - Math.floor(w / SOCIAL_ASPECT_MIN)) / 2), width: w, height: Math.floor(w / SOCIAL_ASPECT_MIN) });
  }
  const { data, info } = await pipeline
    .resize({ width: SOCIAL_IMAGE_MAX_SIDE, height: SOCIAL_IMAGE_MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

async function fromSource(kind: "cover" | "og", url: string): Promise<SocialImageResult> {
  if (kind === "og" && !isOwnWebOriginUrl(url)) return { ok: false, error: "OG rasm manzili blogning o'z veb-originida emas" };
  const prepared = await loader(url);
  if (!prepared.ok) return { ok: false, error: kind === "og" ? `Saytning OG rasmini olib bo'lmadi: ${prepared.error}` : `Muqova rasmini olib bo'lmadi: ${prepared.error}` };
  try {
    const out = await toSocialJpeg(prepared.buffer);
    return {
      ok: true,
      source: kind,
      sourceUrl: url,
      buffer: out.buffer,
      mime: "image/jpeg",
      width: out.width,
      height: out.height,
      sizeBytes: out.buffer.byteLength,
      fingerprint: createHash("sha256").update(out.buffer).digest("hex"),
    };
  } catch {
    return { ok: false, error: "Rasmni platforma uchun tayyorlab bo'lmadi" };
  }
}

/** `none` -> `null` (rasm kerak emas). Aks holda natija yoki xato sababi. */
export async function prepareSocialImage(post: ImagePostRef, choice: DistributionImageChoice): Promise<SocialImageResult | null> {
  if (choice === "none") return null;
  const wantCover = choice === "cover" || choice === "auto";
  const wantOg = choice === "og" || choice === "auto";
  let lastError = "Rasm manbasi yo'q";
  if (wantCover) {
    if (post.coverUrl) {
      const res = await fromSource("cover", post.coverUrl);
      if (res.ok) return res;
      lastError = res.error;
    } else if (choice === "cover") {
      return { ok: false, error: "Postda muqova rasmi yo'q" };
    }
  }
  if (wantOg) {
    const res = await fromSource("og", ogImageSourceUrl(post.slug));
    if (res.ok) return res;
    lastError = choice === "auto" && post.coverUrl ? `${lastError}; ${res.error}` : res.error;
  }
  return { ok: false, error: lastError };
}

/** Rasm manbasi (yuklamasdan): ko'rsatish uchun URL. */
export function imageSourcePreview(post: ImagePostRef, choice: DistributionImageChoice): { source: "cover" | "og" | "none"; url: string | null } {
  if (choice === "none") return { source: "none", url: null };
  if (choice === "cover" || (choice === "auto" && post.coverUrl)) return post.coverUrl ? { source: "cover", url: post.coverUrl } : { source: "none", url: null };
  return { source: "og", url: ogImageSourceUrl(post.slug) };
}

/** Blogning o'z media saqlashidagi ommaviy bazasi (R2 yoki `API_ORIGIN/uploads`) — oldindan ko'rishda "keyin saqlanadi" URL uchun. */
export async function publicMediaBase(): Promise<string> {
  const { r2 } = await getSettings();
  return r2.enabled && r2.publicUrl ? r2.publicUrl.replace(/\/+$/, "") : `${config.API_ORIGIN.replace(/\/+$/, "")}/uploads`;
}

/**
 * Instagram/Threads uchun ommaviy JPEG URL: bir xil rasm (xesh bo'yicha) qayta saqlanmaydi; post uchun eskirgan keshlar o'chiriladi.
 * Faqat YUBORISH paytida chaqiriladi (oldindan ko'rishda fayl yozilmaydi).
 */
export async function ensurePublicImageUrl(postId: string, image: Extract<SocialImageResult, { ok: true }>): Promise<string> {
  const [existing] = await db.select().from(distributionImages).where(and(eq(distributionImages.postId, postId), eq(distributionImages.fingerprint, image.fingerprint))).limit(1);
  if (existing) return existing.url;
  const stored = await storeProcessedFile({ buffer: image.buffer, ext: "jpg", mime: "image/jpeg", width: image.width, height: image.height });
  const [row] = await db
    .insert(distributionImages)
    .values({ postId, sourceKind: image.source, sourceUrl: image.sourceUrl, fingerprint: image.fingerprint, storageKey: stored.key, url: stored.url, width: image.width, height: image.height, sizeBytes: image.sizeBytes })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    const [again] = await db.select().from(distributionImages).where(and(eq(distributionImages.postId, postId), eq(distributionImages.fingerprint, image.fingerprint))).limit(1);
    await deleteStoredFile(stored.key).catch(() => undefined);
    if (again) return again.url;
    throw new Error("Rasm keshini yozib bo'lmadi");
  }
  // Eskirgan keshlar (bu post uchun) tozalanadi — eng so'nggisi qoladi.
  const stale = await db.delete(distributionImages).where(and(eq(distributionImages.postId, postId), ne(distributionImages.id, row.id))).returning();
  for (const s of stale) await deleteStoredFile(s.storageKey).catch(() => undefined);
  return stored.url;
}

export async function cachedPublicImageUrl(postId: string, fingerprint: string): Promise<string | null> {
  const [row] = await db.select().from(distributionImages).where(and(eq(distributionImages.postId, postId), eq(distributionImages.fingerprint, fingerprint))).limit(1);
  return row?.url ?? null;
}

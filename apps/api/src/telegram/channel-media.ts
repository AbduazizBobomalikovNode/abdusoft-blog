import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { CHANNEL_MEDIA_POLICY } from "@blog/shared";
import { config } from "../config.js";
import { uploadsDir } from "../lib/media/store.js";

/**
 * Kanalga yuboriladigan rasmlarni yuklash + JPEG'ga aylantirish. Sender
 * (`channel-send.ts`) va preflight (`channel-preflight.ts`) AYNAN shu
 * funksiyadan foydalanadi, natija bir necha daqiqa keshlanadi — preflight
 * va yuborish orasida rasm ikki marta aylantirilmaydi.
 */

const DOWNLOAD_TIMEOUT_MS = 10_000;
const JPEG_QUALITY = 88;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 40;
const CACHE_MAX_BYTES = 120 * 1024 * 1024;

export interface OriginalInfo {
  bytes: number;
  width: number;
  height: number;
  format: string;
  animated: boolean;
}

export interface SentInfo {
  bytes: number;
  width: number;
  height: number;
  format: "jpeg";
}

export type PreparedImage =
  | { ok: true; url: string; original: OriginalInfo; sent: SentInfo; buffer: Buffer }
  | { ok: false; url: string; error: string; kind: "unreachable" | "too_large" | "decode" };

interface CacheEntry {
  validator: string | null;
  expiresAt: number;
  value: PreparedImage;
  size: number;
}

const cache = new Map<string, CacheEntry>();

function cacheBytes(): number {
  let total = 0;
  for (const e of cache.values()) total += e.size;
  return total;
}

function cachePut(url: string, entry: CacheEntry): void {
  cache.delete(url);
  cache.set(url, entry);
  while (cache.size > CACHE_MAX_ENTRIES || cacheBytes() > CACHE_MAX_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Testlar uchun. */
export function clearPreparedImageCache(): void {
  cache.clear();
}

function localKeyFor(url: string): string | null {
  const localPrefix = `${config.API_ORIGIN}/uploads/`;
  return url.startsWith(localPrefix) ? url.slice(localPrefix.length) : null;
}

class FetchError extends Error {
  constructor(
    message: string,
    readonly kind: "unreachable" | "too_large",
  ) {
    super(message);
  }
}

async function fetchBytes(url: string): Promise<{ buffer: Buffer; validator: string | null }> {
  const key = localKeyFor(url);
  const cap = CHANNEL_MEDIA_POLICY.fetchMaxBytes;
  const capMb = Math.round(cap / 1024 / 1024);
  if (key !== null) {
    const filePath = path.join(uploadsDir, key);
    try {
      const st = await stat(filePath);
      if (st.size > cap) throw new FetchError(`Fayl hajmi ${capMb} MB dan katta`, "too_large");
      return { buffer: await readFile(filePath), validator: `${st.mtimeMs}:${st.size}` };
    } catch (error) {
      if (error instanceof FetchError) throw error;
      throw new FetchError("Fayl serverda topilmadi", "unreachable");
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new FetchError(`Rasmga ulanib bo'lmadi (HTTP ${res.status})`, "unreachable");
    const contentLength = res.headers.get("content-length");
    if (contentLength && Number(contentLength) > cap) {
      throw new FetchError(`Fayl hajmi ${capMb} MB dan katta`, "too_large");
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > cap) throw new FetchError(`Fayl hajmi ${capMb} MB dan katta`, "too_large");
    return { buffer, validator: res.headers.get("etag") ?? res.headers.get("last-modified") };
  } catch (error) {
    if (error instanceof FetchError) throw error;
    throw new FetchError(
      controller.signal.aborted ? "Rasm yuklanishi vaqt chegarasidan oshdi" : "Rasmga ulanib bo'lmadi",
      "unreachable",
    );
  } finally {
    clearTimeout(timer);
  }
}

async function convertToJpeg(buffer: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize({
      width: CHANNEL_MEDIA_POLICY.maxSidePx,
      height: CHANNEL_MEDIA_POLICY.maxSidePx,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function prepareUncached(url: string, fetched: { buffer: Buffer }): Promise<PreparedImage> {
  try {
    // EXIF aylantirishi hisobga olinadi: `rotate()` dan keyingi o'lcham "asl" kenglik/balandlik sifatida ko'rsatiladi.
    const meta = await sharp(fetched.buffer).metadata();
    const swap = (meta.orientation ?? 1) >= 5;
    const rawW = meta.width ?? 0;
    const rawH = meta.height ?? 0;
    const converted = await convertToJpeg(fetched.buffer);
    return {
      ok: true,
      url,
      buffer: converted.data,
      original: {
        bytes: fetched.buffer.byteLength,
        width: swap ? rawH : rawW,
        height: swap ? rawW : rawH,
        format: meta.format ?? "unknown",
        animated: (meta.pages ?? 1) > 1,
      },
      sent: { bytes: converted.data.byteLength, width: converted.width, height: converted.height, format: "jpeg" },
    };
  } catch {
    return { ok: false, url, error: "Rasmni o'qib bo'lmadi (fayl buzilgan yoki rasm emas)", kind: "decode" };
  }
}

/**
 * Rasmni yuklaydi va JPEG'ga aylantiradi (kesh bilan). Kesh kaliti — URL +
 * validator (mahalliy fayl uchun mtime+hajm, tashqi URL uchun ETag/Last-Modified,
 * bo'lmasa faqat TTL). Mahalliy fayl o'zgarsa kesh avtomatik yaroqsiz bo'ladi.
 */
export async function getPreparedImage(url: string): Promise<PreparedImage> {
  const cached = cache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    const key = localKeyFor(url);
    if (key === null) return cached.value;
    try {
      const st = await stat(path.join(uploadsDir, key));
      if (`${st.mtimeMs}:${st.size}` === cached.validator) return cached.value;
    } catch {
      // fayl yo'qolgan — qayta urinib ko'ramiz (pastda xato qaytadi).
    }
  }

  let fetched: { buffer: Buffer; validator: string | null };
  try {
    fetched = await fetchBytes(url);
  } catch (error) {
    const fe = error instanceof FetchError ? error : new FetchError("Rasmga ulanib bo'lmadi", "unreachable");
    return { ok: false, url, error: fe.message, kind: fe.kind };
  }
  const value = await prepareUncached(url, fetched);
  if (value.ok) {
    cachePut(url, {
      validator: fetched.validator,
      expiresAt: Date.now() + CACHE_TTL_MS,
      value,
      size: value.buffer.byteLength,
    });
  }
  return value;
}

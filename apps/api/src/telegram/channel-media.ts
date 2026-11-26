import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { CHANNEL_MEDIA_POLICY } from "@blog/shared";
import { config } from "../config.js";
import { uploadsDir } from "../lib/media/store.js";
import { SafeFetchError, safeFetchBytes } from "../lib/net/safe-fetch.js";

/**
 * Kanalga yuboriladigan rasmlarni yuklash + JPEG'ga aylantirish. Sender
 * (`channel-send.ts`) va preflight (`channel-preflight.ts`) AYNAN shu
 * funksiyadan foydalanadi, natija bir necha daqiqa keshlanadi — preflight
 * va yuborish orasida rasm ikki marta aylantirilmaydi.
 */

const DOWNLOAD_TIMEOUT_MS = 10_000;
/** Tashqaridan yuklangan rasm uchun piksel chegarasi (dekodlashdan OLDIN tekshiriladi; `upload_image` bilan bir xil). */
export const EXTERNAL_MAX_PIXELS = 40_000_000;
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

/**
 * `<API_ORIGIN>/uploads/<kalit>` bo'lsa — mahalliy fayl kaliti. URL avval ajratiladi va normallashtiriladi (`..`, `%2e%2e` yo'q
 * qilinadi), kalit esa `uploadsDir` ICHIDA qolishi shart (`resolveUploadPath` qayta tekshiradi).
 */
export function localKeyFor(url: string): string | null {
  let parsed: URL;
  let origin: URL;
  try {
    parsed = new URL(url);
    origin = new URL(config.API_ORIGIN);
  } catch {
    return null;
  }
  if (parsed.origin !== origin.origin || !parsed.pathname.startsWith("/uploads/")) return null;
  try {
    return decodeURIComponent(parsed.pathname.slice("/uploads/".length));
  } catch {
    return null;
  }
}

/** Kalitni `uploadsDir` ichidagi mutlaq yo'lga aylantiradi; tashqariga chiqsa (`..`, mutlaq yo'l, NUL, simvolik havola) — `null`. */
export async function resolveUploadPath(key: string): Promise<string | null> {
  if (key === "" || key.includes("\0") || key.includes("\\")) return null;
  const root = path.resolve(uploadsDir);
  const candidate = path.resolve(root, key);
  if (candidate === root || !candidate.startsWith(root + path.sep)) return null;
  try {
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(candidate)]);
    if (!realFile.startsWith(realRoot + path.sep)) return null;
    return realFile;
  } catch {
    // Fayl yo'q — xavfsiz yo'l qaytariladi, chaqiruvchi "topilmadi" deydi.
    return candidate;
  }
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
    const filePath = await resolveUploadPath(key);
    if (filePath === null) throw new FetchError("Rasm manzili ruxsat etilmagan", "unreachable");
    try {
      const st = await stat(filePath);
      if (st.size > cap) throw new FetchError(`Fayl hajmi ${capMb} MB dan katta`, "too_large");
      return { buffer: await readFile(filePath), validator: `${st.mtimeMs}:${st.size}` };
    } catch (error) {
      if (error instanceof FetchError) throw error;
      throw new FetchError("Fayl serverda topilmadi", "unreachable");
    }
  }

  try {
    return await safeFetchBytes(url, { maxBytes: cap, timeoutMs: DOWNLOAD_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof SafeFetchError) {
      if (error.kind === "too_large") throw new FetchError(`Fayl hajmi ${capMb} MB dan katta`, "too_large");
      throw new FetchError(error.message, "unreachable");
    }
    throw new FetchError("Rasmga ulanib bo'lmadi", "unreachable");
  }
}

async function convertToJpeg(buffer: Buffer, pixelLimit: number | false): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(buffer, { limitInputPixels: pixelLimit })
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
  // Faqat TASHQARIDAN yuklangan rasmga: blogning o'z yuklamalari (allaqachon qayta ishlangan) avvalgidek cheklanmaydi.
  const pixelLimit: number | false = localKeyFor(url) === null ? EXTERNAL_MAX_PIXELS : false;
  try {
    // EXIF aylantirishi hisobga olinadi: `rotate()` dan keyingi o'lcham "asl" kenglik/balandlik sifatida ko'rsatiladi.
    // `limitInputPixels` sarlavhadagi o'lchamni dekodlashdan OLDIN tekshiradi (dekompressiya bombasidan himoya).
    const meta = await sharp(fetched.buffer, { limitInputPixels: pixelLimit }).metadata();
    if (pixelLimit !== false && (meta.width ?? 0) * (meta.height ?? 0) > pixelLimit) {
      return { ok: false, url, error: `Rasm juda katta (${Math.round(pixelLimit / 1_000_000)} megapikseldan oshadi)`, kind: "too_large" };
    }
    const swap = (meta.orientation ?? 1) >= 5;
    const rawW = meta.width ?? 0;
    const rawH = meta.height ?? 0;
    const converted = await convertToJpeg(fetched.buffer, pixelLimit);
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
  } catch (error) {
    if (error instanceof Error && /pixel limit/i.test(error.message)) {
      return { ok: false, url, error: `Rasm juda katta (${Math.round(EXTERNAL_MAX_PIXELS / 1_000_000)} megapikseldan oshadi)`, kind: "too_large" };
    }
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
      const filePath = await resolveUploadPath(key);
      const st = filePath ? await stat(filePath) : null;
      if (st && `${st.mtimeMs}:${st.size}` === cached.validator) return cached.value;
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

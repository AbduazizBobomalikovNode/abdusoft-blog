import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { S3Client } from "@aws-sdk/client-s3";
import { nanoid } from "nanoid";
import sanitizeHtml from "sanitize-html";
import sharp from "sharp";
import { config } from "../../config.js";
import { getSettings, onSettingsChange, type MergedSettings } from "../settings.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
/** Mahalliy fallback saqlash joyi — R2 sozlanmagan bo'lsa shu yerga yoziladi. */
export const uploadsDir = path.resolve(dirname, "../../../.data/uploads");

const MAX_WIDTH = 1600;
const WEBP_QUALITY = 82;

export interface ProcessedFile {
  buffer: Buffer;
  ext: string;
  mime: string;
  width: number | null;
  height: number | null;
}

const PASSTHROUGH_MIME = new Set(["image/gif", "image/svg+xml"]);

/** SVG uchun ruxsat etilgan teglar — `script`, `foreignObject`, `iframe`, `style` va h.k. chiqarib tashlanadi. */
const SVG_ALLOWED_TAGS = [
  "svg",
  "g",
  "path",
  "circle",
  "ellipse",
  "line",
  "polygon",
  "polyline",
  "rect",
  "text",
  "tspan",
  "defs",
  "lineargradient",
  "radialgradient",
  "stop",
  "clippath",
  "mask",
  "symbol",
  "marker",
  "title",
  "desc",
];

/** Barcha SVG teglariga ruxsat etilgan umumiy prezentatsiya atributlari (jonli skript/tashqi havola qoldirmaydi). */
const SVG_ALLOWED_ATTRIBUTES = [
  "id",
  "class",
  "width",
  "height",
  "viewbox",
  "xmlns",
  "preserveaspectratio",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "stroke-dasharray",
  "opacity",
  "transform",
  "d",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "points",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientunits",
  "gradienttransform",
  "font-family",
  "font-size",
  "text-anchor",
  "clip-path",
  "mask",
];

/**
 * SVG faylni tozalaydi — o'zi rasm formatiga o'xshasa ham, ijro etiladigan XML
 * bo'lgani uchun `<script>`, `on*` hodisa atributlari, `<foreignObject>` (ichiga
 * HTML joylashtirish mumkin) va tashqi manbalarga havolalar (`href`/`xlink:href`)
 * saqlangan (stored) XSS vektori bo'lishi mumkin — admin sessiyasi phishing
 * qilingan taqdirda ham xavfsiz bo'lishi uchun bularning barchasi olib tashlanadi.
 */
function sanitizeSvg(input: Buffer): Buffer {
  const clean = sanitizeHtml(input.toString("utf8"), {
    allowedTags: SVG_ALLOWED_TAGS,
    allowedAttributes: { "*": SVG_ALLOWED_ATTRIBUTES },
    allowedSchemes: [],
    allowVulnerableTags: false,
    // href/xlink:href, style va boshqa ro'yxatda yo'q atributlar butunlay olib tashlanadi.
    parser: { xmlMode: true, decodeEntities: true },
  });
  return Buffer.from(clean, "utf8");
}

/**
 * Rasmni qayta ishlaydi: auto-orient, max kenglik 1600px (aspekt saqlangan
 * holda), webp'ga aylantirish (gif/svg bundan mustasno — o'zgarishsiz qoladi,
 * lekin svg avval `sanitizeSvg` orqali tozalanadi).
 */
export async function processImage(input: Buffer, mime: string): Promise<ProcessedFile> {
  if (PASSTHROUGH_MIME.has(mime)) {
    const isSvg = mime === "image/svg+xml";
    const buffer = isSvg ? sanitizeSvg(input) : input;

    let width: number | null = null;
    let height: number | null = null;

    try {
      const metadata = await sharp(buffer).metadata();
      width = metadata.width ?? null;
      height = metadata.height ?? null;
    } catch {
      // SVG'lar uchun sharp har doim ham o'lcham bera olmaydi — jim o'tkazamiz.
    }

    const ext = isSvg ? "svg" : "gif";
    return { buffer, ext, mime, width, height };
  }

  const image = sharp(input).rotate();
  const metadata = await image.metadata();
  const resized = (metadata.width ?? 0) > MAX_WIDTH ? image.resize({ width: MAX_WIDTH }) : image;
  const { data, info } = await resized
    .webp({ quality: WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true });

  return { buffer: data, ext: "webp", mime: "image/webp", width: info.width, height: info.height };
}

function buildKey(ext: string): string {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}/${mm}/${nanoid()}.${ext}`;
}

let cachedClient: { client: S3Client; accountId: string; accessKeyId: string; secretAccessKey: string } | null = null;

// R2 sozlamalari (admin panelda) o'zgarganda eski S3 klient keshini bekor qiladi
// — keyingi chaqiriqda yangi credential'lar bilan qayta yaratiladi.
onSettingsChange((settings) => {
  if (
    cachedClient &&
    (cachedClient.accountId !== settings.r2.accountId ||
      cachedClient.accessKeyId !== settings.r2.accessKeyId ||
      cachedClient.secretAccessKey !== settings.r2.secretAccessKey)
  ) {
    cachedClient = null;
  }
});

async function getS3Client(r2: MergedSettings["r2"]): Promise<S3Client> {
  if (cachedClient && cachedClient.accountId === r2.accountId && cachedClient.accessKeyId === r2.accessKeyId) {
    return cachedClient.client;
  }

  const { S3Client } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey,
    },
  });
  cachedClient = { client, accountId: r2.accountId, accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey };
  return client;
}

/** Qayta ishlangan faylni R2 (agar sozlangan bo'lsa) yoki mahalliy diskka yozadi. */
export async function storeProcessedFile(
  file: ProcessedFile,
): Promise<{ key: string; url: string }> {
  const key = buildKey(file.ext);
  const { r2 } = await getSettings();

  if (r2.enabled) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await getS3Client(r2);
    await client.send(
      new PutObjectCommand({
        Bucket: r2.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mime,
      }),
    );
    return { key, url: `${r2.publicUrl}/${key}` };
  }

  const filePath = path.join(uploadsDir, key);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, file.buffer);
  return { key, url: `${config.API_ORIGIN}/uploads/${key}` };
}

export async function deleteStoredFile(key: string): Promise<void> {
  const { r2 } = await getSettings();

  if (r2.enabled) {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await getS3Client(r2);
    await client.send(new DeleteObjectCommand({ Bucket: r2.bucket, Key: key }));
    return;
  }

  const filePath = path.join(uploadsDir, key);
  await unlink(filePath).catch(() => {
    // Fayl allaqachon yo'q bo'lishi mumkin — e'tiborsiz qoldiramiz.
  });
}

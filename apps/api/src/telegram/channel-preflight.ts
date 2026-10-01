import {
  CHANNEL_MEDIA_POLICY,
  TELEGRAM_LIMITS,
  type ChannelCheck,
  type ChannelMediaReport,
  type ChannelPreflightResponse,
  type ChannelSelection,
} from "@blog/shared";
import { getSettings } from "../lib/settings.js";
import { bot } from "./client.js";
import { getPreparedImage } from "./channel-media.js";
import { telegramVisibleLength, validateTelegramHtml } from "./channel-html.js";
import {
  computeChannelPost,
  computeChannelVersionPost,
  type ChannelComputed,
  type ComputeChannelPostResult,
} from "./channel-send.js";

/**
 * Yuborishdan oldingi "Telegram cheklovlari" tekshiruvi. Chegaralar
 * `@blog/shared` dagi `TELEGRAM_LIMITS` (rasmiy hujjatdan tekshirilgan)dan olinadi.
 * Rasmlar sender bilan AYNAN bir xil yo'l (`getPreparedImage`) orqali tayyorlanadi
 * va keshlanadi — preflight'dan keyin yuborishda qayta aylantirilmaydi.
 */

const MAX_PREPARED_IMAGES = 20;

export interface PreflightOptions {
  /** `true` — post chop etilgan bo'lishi shart (darhol yuborish). Rejalashtirishda `false`. */
  requirePublished: boolean;
  /** `true` — rejalashtirilgan avtomatik reja: rasm umuman yo'q bo'lsa scheduler matnga o'tadi, shuning uchun bu xato emas, ogohlantirish. */
  planFallback?: boolean;
}

function fmtMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 1 : 2).replace(/\.?0+$/, "")} MB`;
}

function fmtSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? fmtMb(bytes) : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function imageName(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : url;
  } catch {
    return url.split("/").pop() || url;
  }
}

export async function computeChannelPreflightFor(
  computed: ChannelComputed,
  opts: PreflightOptions,
): Promise<ChannelPreflightResponse> {
  const checks: ChannelCheck[] = [];
  const add = (c: Omit<ChannelCheck, "value" | "limit" | "imageUrl"> & Partial<Pick<ChannelCheck, "value" | "limit" | "imageUrl">>) =>
    checks.push({ value: null, limit: null, imageUrl: null, ...c });

  // --- Sozlamalar ---
  const settings = await getSettings();
  const botReady = Boolean(settings.telegram.enabled && bot);
  add({
    id: "config.bot",
    group: "config",
    status: botReady ? "ok" : "error",
    title: "Telegram bot",
    message: botReady ? "Bot sozlangan" : "Telegram bot sozlanmagan yoki o'chirilgan",
  });
  const channelReady = Boolean(settings.telegram.channelId);
  add({
    id: "config.channel",
    group: "config",
    status: channelReady ? "ok" : "error",
    title: "Kanal",
    message: channelReady ? "Kanal ID kiritilgan" : "Kanal ID kiritilmagan (Sozlamalar -> Telegram)",
  });
  if (opts.requirePublished) {
    const published = computed.post.status === "published";
    add({
      id: "config.published",
      group: "config",
      status: published ? "ok" : "error",
      title: "Post holati",
      message: published ? "Post chop etilgan" : "Faqat chop etilgan post kanalga yuboriladi",
    });
  }

  // --- Matn ---
  const hardLimit = computed.mode === "media" ? TELEGRAM_LIMITS.captionMaxChars : TELEGRAM_LIMITS.textMaxChars;
  const visibleLength = telegramVisibleLength(computed.captionHtml);
  const kindLabel = computed.mode === "media" ? "Caption" : "Matn";
  if (visibleLength < TELEGRAM_LIMITS.textMinChars) {
    add({ id: "text.empty", group: "text", status: "error", title: kindLabel, message: "Matn bo'sh — kamida 1 belgi kerak", value: "0", limit: String(hardLimit) });
  } else if (visibleLength > hardLimit) {
    add({
      id: "text.length",
      group: "text",
      status: "error",
      title: kindLabel,
      message: `${visibleLength - hardLimit} belgi ortiqcha (${visibleLength} / ${hardLimit})`,
      value: String(visibleLength),
      limit: String(hardLimit),
    });
  } else {
    add({
      id: "text.length",
      group: "text",
      status: "ok",
      title: kindLabel,
      message: `${visibleLength} / ${hardLimit} belgi`,
      value: String(visibleLength),
      limit: String(hardLimit),
    });
  }
  const htmlCheck = validateTelegramHtml(computed.captionHtml);
  add({
    id: "text.html",
    group: "text",
    status: htmlCheck.ok ? "ok" : "error",
    title: "Formatlash",
    message: htmlCheck.ok ? "Teglar to'g'ri va qo'llab-quvvatlanadi" : (htmlCheck.reason ?? "Noto'g'ri HTML"),
  });

  // --- Rasmlar + albom ---
  const media: ChannelMediaReport[] = [];
  let totalUploadBytes = 0;

  if (computed.mode === "media") {
    const items = computed.media.slice(0, MAX_PREPARED_IMAGES);
    const prepared = await Promise.all(items.map((item) => getPreparedImage(item.url)));
    let usable = 0;

    items.forEach((item, idx) => {
      const img = prepared[idx]!;
      const name = imageName(item.url);
      const base = { group: "media" as const, imageUrl: item.url };
      const n = (suffix: string) => `media.${suffix}:${idx}`;

      if (!img.ok) {
        media.push({ url: item.url, name, kind: item.kind, original: null, sent: null, error: img.error });
        add({
          ...base,
          id: n("download"),
          status: "error",
          title: name,
          message: `${img.error}: ${item.url}`,
          value: null,
          limit: img.kind === "too_large" ? fmtMb(CHANNEL_MEDIA_POLICY.fetchMaxBytes) : null,
        });
        return;
      }

      usable += 1;
      totalUploadBytes += img.sent.bytes;
      media.push({
        url: item.url,
        name,
        kind: item.kind,
        original: img.original,
        sent: { bytes: img.sent.bytes, width: img.sent.width, height: img.sent.height, format: "jpeg" },
        error: null,
      });

      add({
        ...base,
        id: n("download"),
        status: "ok",
        title: name,
        message: `JPEG ${fmtSize(img.sent.bytes)} · ${img.sent.width}×${img.sent.height}`,
        value: `${img.original.format.toUpperCase()} ${fmtSize(img.original.bytes)} · ${img.original.width}×${img.original.height}`,
      });

      // Yuboriladigan hajm.
      const sizeOk = img.sent.bytes <= TELEGRAM_LIMITS.photoMaxBytes;
      add({
        ...base,
        id: n("size"),
        status: sizeOk ? "ok" : "error",
        title: `${name} — hajm`,
        message: sizeOk ? `${fmtSize(img.sent.bytes)} (ruxsat ${fmtMb(TELEGRAM_LIMITS.photoMaxBytes)})` : `Hajm ${fmtSize(img.sent.bytes)}, ruxsat ${fmtMb(TELEGRAM_LIMITS.photoMaxBytes)} — kichikroq rasm tanlang`,
        value: fmtSize(img.sent.bytes),
        limit: fmtMb(TELEGRAM_LIMITS.photoMaxBytes),
      });

      // Kenglik + balandlik.
      const sum = img.sent.width + img.sent.height;
      const dimOk = sum <= TELEGRAM_LIMITS.photoMaxWidthPlusHeight;
      add({
        ...base,
        id: n("dimensions"),
        status: dimOk ? "ok" : "error",
        title: `${name} — o'lcham`,
        message: dimOk
          ? `${img.sent.width}+${img.sent.height} = ${sum} (ruxsat ${TELEGRAM_LIMITS.photoMaxWidthPlusHeight})`
          : `Kenglik+balandlik ${sum}, ruxsat ${TELEGRAM_LIMITS.photoMaxWidthPlusHeight} — rasmni kichraytiring`,
        value: String(sum),
        limit: String(TELEGRAM_LIMITS.photoMaxWidthPlusHeight),
      });

      // Nisbat.
      const ratio = Math.max(img.sent.width, img.sent.height) / Math.max(1, Math.min(img.sent.width, img.sent.height));
      const ratioText = `${Number(ratio.toFixed(1))}:1`;
      const ratioOk = ratio <= TELEGRAM_LIMITS.photoMaxAspectRatio;
      add({
        ...base,
        id: n("aspect"),
        status: ratioOk ? "ok" : "error",
        title: `${name} — nisbat`,
        message: ratioOk
          ? `nisbat ${ratioText} (ruxsat ${TELEGRAM_LIMITS.photoMaxAspectRatio}:1)`
          : `nisbat ${ratioText}, ruxsat ${TELEGRAM_LIMITS.photoMaxAspectRatio}:1 — rasmni qirqing`,
        value: ratioText,
        limit: `${TELEGRAM_LIMITS.photoMaxAspectRatio}:1`,
      });

      if (img.original.animated) {
        add({ ...base, id: n("animated"), status: "warn", title: `${name} — animatsiya`, message: "Animatsiyali GIF: faqat birinchi kadr yuboriladi" });
      }

      const maxSide = Math.max(img.original.width, img.original.height);
      if (img.original.bytes > TELEGRAM_LIMITS.photoMaxBytes || maxSide > CHANNEL_MEDIA_POLICY.maxSidePx) {
        add({
          ...base,
          id: n("downscale"),
          status: "warn",
          title: `${name} — kichraytiriladi`,
          message: `Katta rasm kichraytiriladi: ${img.original.width}×${img.original.height} (${fmtSize(img.original.bytes)}) → ${img.sent.width}×${img.sent.height} (${fmtSize(img.sent.bytes)})`,
          value: `${img.original.width}×${img.original.height}`,
          limit: `${CHANNEL_MEDIA_POLICY.maxSidePx}px`,
        });
      }

      if (Math.min(img.original.width, img.original.height) < CHANNEL_MEDIA_POLICY.tinySidePx) {
        add({
          ...base,
          id: n("tiny"),
          status: "warn",
          title: `${name} — kichik rasm`,
          message: `Rasm juda kichik (${img.original.width}×${img.original.height}), sifati past ko'rinishi mumkin`,
          value: `${img.original.width}×${img.original.height}`,
          limit: `${CHANNEL_MEDIA_POLICY.tinySidePx}px`,
        });
      }
    });

    // Albom bo'yicha.
    const count = computed.media.length;
    const maxItems = TELEGRAM_LIMITS.mediaGroupMaxItems;
    if (count > maxItems) {
      add({
        id: "album.count",
        group: "album",
        status: "error",
        title: "Rasmlar soni",
        message: `${count} ta rasm, ruxsat ${maxItems} ta — ${count - maxItems} ta rasmni olib tashlang`,
        value: String(count),
        limit: String(maxItems),
      });
    } else {
      add({ id: "album.count", group: "album", status: "ok", title: "Rasmlar soni", message: `${count} / ${maxItems}`, value: String(count), limit: String(maxItems) });
    }

    if (count === 0) {
      add({
        id: "album.empty",
        group: "album",
        status: opts.planFallback ? "warn" : "error",
        title: "Rasm",
        message: opts.planFallback
          ? "Postda rasm yo'q — yuborish vaqtida rasmsiz matn sifatida yuboriladi"
          : "Rasmli rejim uchun kamida bitta rasm kerak",
      });
    } else if (usable === 0) {
      add({ id: "album.empty", group: "album", status: "error", title: "Rasm", message: "Yuborish uchun yaroqli rasm yo'q" });
    }

    if (count > 0) {
      const totalStatus = totalUploadBytes > CHANNEL_MEDIA_POLICY.totalWarnBytes ? "warn" : "ok";
      add({
        id: "album.total",
        group: "album",
        status: totalStatus,
        title: "Jami hajm",
        message:
          totalStatus === "warn"
            ? `Jami yuklash ${fmtSize(totalUploadBytes)} — katta, yuborish sekin bo'lishi mumkin`
            : `Jami yuklash ${fmtSize(totalUploadBytes)}`,
        value: fmtSize(totalUploadBytes),
        limit: fmtMb(CHANNEL_MEDIA_POLICY.totalWarnBytes),
      });
    }
  }

  const errorCount = checks.filter((c) => c.status === "error").length;
  const warnCount = checks.filter((c) => c.status === "warn").length;
  return {
    canSend: errorCount === 0,
    checks,
    media,
    text: { visibleLength, limit: hardLimit },
    totalUploadBytes,
    errorCount,
    warnCount,
  };
}

export type ChannelPreflightResult =
  | { ok: true; preflight: ChannelPreflightResponse; computed: ChannelComputed }
  | { ok: false; reason: Extract<ComputeChannelPostResult, { ok: false }>["reason"] };

/**
 * `computeChannelPreflight(postId, selection)` — tanlov: avtomatik `{mode, variant}` yoki maxsus `{versionId}`.
 * Post/versiya topilmasa `ok: false` (marshrut 404/400 qaytaradi); aks holda hisobot (xatolar bilan ham).
 */
export async function computeChannelPreflight(
  postId: string,
  selection: ChannelSelection,
  opts: PreflightOptions = { requirePublished: true },
): Promise<ChannelPreflightResult> {
  const computed =
    "versionId" in selection
      ? await computeChannelVersionPost(postId, selection.versionId, { allowUnpublished: true, allowEmptyMedia: true })
      : await computeChannelPost(postId, selection.mode, selection.variant, { allowUnpublished: true, allowEmptyMedia: true });
  if (!computed.ok) return { ok: false, reason: computed.reason };
  const preflight = await computeChannelPreflightFor(computed.data, opts);
  return { ok: true, preflight, computed: computed.data };
}

/** Admin xabari uchun: xato tekshiruvlarini bitta qatorga yig'adi. */
export function summarizePreflightErrors(preflight: ChannelPreflightResponse): string {
  return preflight.checks
    .filter((c) => c.status === "error")
    .map((c) => c.message)
    .join("; ");
}

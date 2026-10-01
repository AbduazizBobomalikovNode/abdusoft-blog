import { and, eq } from "drizzle-orm";
import {
  CHANNEL_CAPTION_HARD_LIMIT,
  CHANNEL_TEXT_HARD_LIMIT,
  type ChannelMode,
  type ChannelPostImageOption,
  type ChannelVersion,
} from "@blog/shared";
import { db } from "../db/index.js";
import { channelPostVersions, posts } from "../db/schema.js";
import type { TiptapNode } from "./channel-post.js";
import { renderRestrictedDoc, telegramVisibleLength } from "./channel-html.js";

/** Maxsus versiyaning rejimga mos Telegram qattiq chegarasi. */
export function versionHardLimit(mode: ChannelMode): number {
  return mode === "media" ? CHANNEL_CAPTION_HARD_LIMIT : CHANNEL_TEXT_HARD_LIMIT;
}

export type VersionRow = typeof channelPostVersions.$inferSelect;
type PostRow = Pick<typeof posts.$inferSelect, "coverUrl" | "contentJson" | "updatedAt">;

/** Postdagi tanlanishi mumkin bo'lgan rasmlar — kover birinchi, so'ng kontent rasmlari hujjat tartibida (dublikatsiz). */
export function collectPostImages(post: Pick<PostRow, "coverUrl" | "contentJson">): ChannelPostImageOption[] {
  const out: ChannelPostImageOption[] = [];
  const seen = new Set<string>();
  if (post.coverUrl) {
    out.push({ url: post.coverUrl, kind: "cover", alt: null });
    seen.add(post.coverUrl);
  }
  const walk = (node: TiptapNode | undefined): void => {
    if (!node) return;
    if (node.type === "image") {
      const src = node.attrs?.src;
      if (typeof src === "string" && src && !seen.has(src)) {
        seen.add(src);
        const alt = typeof node.attrs?.alt === "string" && node.attrs.alt ? node.attrs.alt : null;
        out.push({ url: src, kind: "content", alt });
      }
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(post.contentJson as TiptapNode | undefined);
  return out;
}

/** Rasm tanlovi postdagi rasmlarning to'plamiga kirishini tekshiradi — xato bo'lsa o'zbekcha sabab. */
export function validateImageSubset(imageUrls: string[], available: ChannelPostImageOption[]): string | null {
  const allowed = new Set(available.map((i) => i.url));
  if (new Set(imageUrls).size !== imageUrls.length) return "Bir rasm ikki marta tanlangan";
  for (const url of imageUrls) {
    if (!allowed.has(url)) return "Tanlangan rasm postda yo'q (faqat kover va band ichidagi rasmlar mumkin)";
  }
  return null;
}

/** Hujjatdan HTML + uzunlikni qayta hisoblaydi. */
export function renderVersionContent(contentJson: unknown): { textHtml: string; visibleLength: number } {
  const textHtml = renderRestrictedDoc(contentJson);
  return { textHtml, visibleLength: telegramVisibleLength(textHtml) };
}

export function toVersionDto(row: VersionRow, post: Pick<PostRow, "updatedAt">): ChannelVersion {
  const limit = versionHardLimit(row.mode);
  return {
    id: row.id,
    postId: row.postId,
    name: row.name,
    mode: row.mode,
    contentJson: row.contentJson,
    textHtml: row.textHtml,
    visibleLength: row.visibleLength,
    limit,
    overLimit: row.visibleLength > limit,
    imageUrls: row.imageUrls ?? [],
    baseVariant: row.baseVariant,
    postChanged: post.updatedAt.getTime() > row.updatedAt.getTime(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function loadVersion(postId: string, versionId: string): Promise<VersionRow | null> {
  const [row] = await db
    .select()
    .from(channelPostVersions)
    .where(and(eq(channelPostVersions.id, versionId), eq(channelPostVersions.postId, postId)))
    .limit(1);
  return row ?? null;
}

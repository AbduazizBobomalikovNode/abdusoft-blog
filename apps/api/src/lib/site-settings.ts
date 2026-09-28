import { eq } from "drizzle-orm";
import {
  DEFAULT_POST_SETTINGS,
  DEFAULT_SOCIAL_LINKS,
  DEFAULT_TELEGRAM_SETTINGS,
  PostSettingsSchema,
  SocialLinksSchema,
  TelegramSettingsSchema,
  type PostSettings,
  type SocialLinks,
  type TelegramSettings,
} from "@blog/shared";
import { db } from "../db/index.js";
import { siteSettings } from "../db/schema.js";
import { decryptSecret, encryptSecret } from "./crypto.js";

const ABOUT_KEY = "about";
const SOCIAL_KEY = "social";
const DEFAULT_POST_SETTINGS_KEY = "defaultPostSettings";
const TELEGRAM_KEY = "telegram";
/** Avtomatik yaratilgan Telegraph `access_token` shu kalit ostida saqlanadi (Phase 6). */
const TELEGRAPH_KEY = "telegraph";

export interface AboutValue {
  json: unknown;
  html: string;
}

export interface SiteSettingsValue {
  about: AboutValue;
  social: SocialLinks;
  defaultPostSettings: PostSettings;
  telegram: TelegramSettings;
}

const EMPTY_ABOUT: AboutValue = { json: { type: "doc", content: [] }, html: "" };

export async function loadSiteSettings(): Promise<SiteSettingsValue> {
  const rows = await db.select().from(siteSettings);
  const map = new Map(rows.map((row) => [row.key, row.value]));

  const aboutRaw = map.get(ABOUT_KEY) as AboutValue | undefined;
  const socialRaw = map.get(SOCIAL_KEY) as Record<string, unknown> | undefined;
  const defaultsRaw = map.get(DEFAULT_POST_SETTINGS_KEY) as Record<string, unknown> | undefined;
  const telegramRaw = map.get(TELEGRAM_KEY) as Record<string, unknown> | undefined;

  return {
    about: aboutRaw ?? EMPTY_ABOUT,
    social: SocialLinksSchema.parse({ ...DEFAULT_SOCIAL_LINKS, ...(socialRaw ?? {}) }),
    defaultPostSettings: PostSettingsSchema.parse({
      ...DEFAULT_POST_SETTINGS,
      ...(defaultsRaw ?? {}),
    }),
    telegram: TelegramSettingsSchema.parse({ ...DEFAULT_TELEGRAM_SETTINGS, ...(telegramRaw ?? {}) }),
  };
}

export async function upsertSiteSetting(key: string, value: unknown): Promise<void> {
  await db
    .insert(siteSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: siteSettings.key, set: { value } });
}

/**
 * Telegraph `access_token`ni saqlaydi/o'qiydi — `TELEGRAPH_ACCESS_TOKEN` env bo'sh bo'lganda
 * ishlatiladi. Token AES-256-GCM bilan shifrlangan holda saqlanadi (`lib/crypto.ts`); eski
 * (shifrlanmagan) qiymatlar ham `decryptSecret`ning legacy-fallback orqali o'qiladi.
 */
export async function getStoredTelegraphToken(): Promise<string | null> {
  const [row] = await db.select().from(siteSettings).where(eq(siteSettings.key, TELEGRAPH_KEY)).limit(1);
  const value = row?.value as { accessToken?: string } | undefined;
  if (!value?.accessToken) return null;
  const decrypted = decryptSecret(value.accessToken);
  return decrypted || null;
}

export async function storeTelegraphToken(accessToken: string): Promise<void> {
  await upsertSiteSetting(TELEGRAPH_KEY, { accessToken: accessToken ? encryptSecret(accessToken) : "" });
}

/**
 * "💬 Javob" bosilgandan keyingi ForceReply -> izoh xaritasi shu yerda saqlanadi
 * (ilgari xotiradagi Map edi — server qayta ishga tushganda yo'qolib qolardi).
 * Kalit: Telegram `message_id` (string'ga aylantirilgan), qiymat: {commentId, postSlug}.
 */
const PENDING_REPLIES_KEY = "telegramPendingReplies";

export interface PendingCommentReply {
  kind: "comment";
  commentId: string;
  postSlug: string;
}

/**
 * "✏️ Qaytarish" bosilgandan keyingi ForceReply -> qaysi postga tuzatish izohi
 * ekanligi. `chatId`/`originalMessageId`/`originalText` — javob kelganda ASL
 * ko'rib chiqish xabarini (statusni qo'shib) tahrirlash uchun saqlanadi.
 */
export interface PendingReviewNoteReply {
  kind: "review";
  postId: string;
  chatId: number;
  originalMessageId: number;
  originalText: string;
}

export type PendingReply = PendingCommentReply | PendingReviewNoteReply;

async function loadPendingReplies(): Promise<Record<string, PendingReply>> {
  const [row] = await db.select().from(siteSettings).where(eq(siteSettings.key, PENDING_REPLIES_KEY)).limit(1);
  return (row?.value as Record<string, PendingReply> | undefined) ?? {};
}

export async function setPendingReply(messageId: number, reply: PendingReply): Promise<void> {
  const map = await loadPendingReplies();
  map[String(messageId)] = reply;
  await upsertSiteSetting(PENDING_REPLIES_KEY, map);
}

/** Topilsa yozuvni o'qiydi va o'chiradi (bir martalik) — topilmasa `null`. */
export async function takePendingReply(messageId: number): Promise<PendingReply | null> {
  const map = await loadPendingReplies();
  const key = String(messageId);
  const reply = map[key];
  if (!reply) return null;
  delete map[key];
  await upsertSiteSetting(PENDING_REPLIES_KEY, map);
  return reply;
}

export { ABOUT_KEY, SOCIAL_KEY, DEFAULT_POST_SETTINGS_KEY, TELEGRAM_KEY, TELEGRAPH_KEY };

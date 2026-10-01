import type { ChannelInfo } from "@blog/shared";
import { getSettings } from "../lib/settings.js";
import { bot } from "./client.js";

/**
 * Kanal nomi/username'ini `getChat` orqali oladi — ~10 daqiqa keshlanadi.
 * Xatolik bo'lsa (yoki bot sozlanmagan) — sozlangan id'ga qaytadi (`title: null`),
 * UI o'sha id'ni ko'rsatadi; xatolik qisqa muddat (30s) keshlanadi.
 */
const TTL_MS = 10 * 60_000;
const FAILURE_TTL_MS = 30_000;

let cached: { key: string; expiresAt: number; value: ChannelInfo } | null = null;

export function clearChannelInfoCache(): void {
  cached = null;
}

export async function getChannelInfo(): Promise<ChannelInfo> {
  const settings = await getSettings();
  const channelId = settings.telegram.channelId;
  const fallback: ChannelInfo = {
    title: null,
    username: channelId.startsWith("@") ? channelId.slice(1) : null,
  };
  if (!channelId || !bot) return fallback;

  const key = `${channelId}|${settings.telegram.apiRoot}`;
  if (cached && cached.key === key && cached.expiresAt > Date.now()) return cached.value;

  try {
    const chat = await bot.api.getChat(channelId);
    const title = "title" in chat && typeof chat.title === "string" && chat.title ? chat.title : null;
    const username = "username" in chat && typeof chat.username === "string" && chat.username ? chat.username : fallback.username;
    const value: ChannelInfo = { title, username };
    cached = { key, expiresAt: Date.now() + TTL_MS, value };
    return value;
  } catch (error: unknown) {
    console.error("Kanal nomini olishda xatolik (getChat):", error);
    cached = { key, expiresAt: Date.now() + FAILURE_TTL_MS, value: fallback };
    return fallback;
  }
}

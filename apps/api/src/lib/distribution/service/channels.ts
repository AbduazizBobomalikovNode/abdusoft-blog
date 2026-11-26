import type { DistributionChannelDto, DistributionProviderCapabilitiesDto } from "@blog/shared";
import { getSettings } from "../../settings.js";
import { PROVIDER_IDS } from "../registry.js";
import type { ProviderId } from "../types.js";
import { UNREADABLE_TOKEN_MESSAGE, accountView, getActiveAccount } from "./accounts.js";
import { distNow, getProvider } from "./env.js";

export const CHANNEL_NAMES: Record<ProviderId, string> = {
  linkedin: "LinkedIn (shaxsiy profil)",
  x: "X",
  threads: "Threads",
  instagram: "Instagram",
  github: "GitHub profil README",
};

export function capabilitiesDto(id: ProviderId): DistributionProviderCapabilitiesDto {
  const p = getProvider(id);
  return {
    text: p.capabilities.text,
    image: p.capabilities.image,
    delete: p.capabilities.delete,
    deleteNote: p.capabilities.notes?.delete ?? null,
    textMax: p.limits.textMax,
    textUnit: p.limits.textUnit,
  };
}

export async function channelFor(id: ProviderId): Promise<DistributionChannelDto> {
  const row = await getActiveAccount(id);
  const account = row ? accountView(row, distNow()) : null;
  let ready = false;
  let reason: string | null = null;
  if (!account) reason = "Akkaunt ulanmagan (Sozlamalar → Tarqatish kanallari)";
  else if (account.secretUnreadable) reason = UNREADABLE_TOKEN_MESSAGE;
  else if (account.status === "reauth_required" || account.tokenState === "expired") reason = "Token yaroqsiz yoki muddati tugagan — qayta ulang";
  else ready = true;
  return { id, name: CHANNEL_NAMES[id], readOnly: false, connected: Boolean(account), ready, notReadyReason: reason, account, capabilities: capabilitiesDto(id) };
}

/** Telegram ro'yxatda FAQAT ko'rsatiladi — mavjud kanal yuborish oqimi o'zgarmaydi. */
async function telegramChannel(): Promise<DistributionChannelDto> {
  const s = await getSettings();
  const connected = Boolean(s.telegram.enabled && s.telegram.channelId);
  return {
    id: "telegram",
    name: "Telegram kanal",
    readOnly: true,
    connected,
    ready: false,
    notReadyReason: "Telegram bu yerdan yuborilmaydi — post tahrirlagichidagi «Kanalga yuborish» tugmasidan foydalaning",
    account: null,
    capabilities: null,
  };
}

export async function listChannels(): Promise<DistributionChannelDto[]> {
  const out: DistributionChannelDto[] = [];
  for (const id of PROVIDER_IDS) out.push(await channelFor(id));
  out.push(await telegramChannel());
  return out;
}


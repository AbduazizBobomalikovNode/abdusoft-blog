import { z } from "zod";

/**
 * Claude konnektori (MCP) ruxsatlari. Bu ro'yxat API (metadata, vositalar uchun talab qilingan scope) va web
 * (rozilik sahifasi, "Ulangan ilovalar") uchun YAGONA manba. Yozuv ruxsatlari `MCP_WRITE_TOOLS_ENABLED=true` bo'lgandagina
 * beriladi (`grantableScopeIds`); o'chiq bo'lsa faqat o'qish beriladi.
 */
export const MCP_SCOPE_GROUPS = ["read", "write", "publish", "danger"] as const;
export type McpScopeGroup = (typeof MCP_SCOPE_GROUPS)[number];

export const MCP_SCOPE_GROUP_LABELS: Record<McpScopeGroup, string> = {
  read: "O'qish",
  write: "Yozish",
  publish: "Chop etish",
  danger: "Xavfli amallar",
};

export interface McpScopeInfo {
  id: string;
  group: McpScopeGroup;
  /** Rozilik sahifasidagi qisqa nom (o'zbekcha). */
  label: string;
  /** Bir qatorli tushuntirish (o'zbekcha). */
  description: string;
  /** Metadata (`scope_descriptions`) va hujjatlar uchun inglizcha tavsif. */
  english: string;
}

/** Video render ruxsati: faqat `VIDEO_ENABLED` YOQILGANDA (va yozuv kaliti ham yoqilgan bo'lsa) beriladi. */
export const MCP_VIDEO_SCOPE_ID = "video:render";

export const MCP_SCOPES: readonly McpScopeInfo[] = [
  {
    id: "blog:read",
    group: "read",
    label: "Blogni o'qish",
    description:
      "Postlar (qoralamalar ham), teglar, izohlar, statistika, tarix, chiqindi qutisi, media va amallar jurnalini ko'rish. Hech narsani o'zgartirmaydi.",
    english: "Read posts (including drafts), tags, comments, statistics, revision history, trash, media and the audit log. Changes nothing.",
  },
  {
    id: "posts:write",
    group: "write",
    label: "Qoralama yozish va tahrirlash",
    description: "Yangi qoralama yaratish, postlarni tahrirlash va teglarni boshqarish (chop etmasdan), chiqindi qutisidan qaytarish.",
    english: "Create drafts, edit posts, manage tags (create, rename) and restore posts from the trash, without publishing anything.",
  },
  {
    id: "media:upload",
    group: "write",
    label: "Media yuklash",
    description: "Rasmlarni media kutubxonasiga yuklash va ularning alt matnini o'zgartirish.",
    english: "Upload images to the media library and edit their alt text.",
  },
  {
    id: MCP_VIDEO_SCOPE_ID,
    group: "write",
    label: "Video yaratish",
    description: "Qisqa animatsiyali tushuntirish videosini (storyboard asosida) tayyorlash: ko'rik kadrlari, MP4 va GIF render qilish, ularni ro'yxatlash, bekor qilish va o'chirish. Hech narsani chop etmaydi.",
    english: "Make short animated explainer videos from a storyboard: render preview frames, MP4 and GIF files, list, cancel and delete them. Publishes nothing.",
  },
  {
    id: "posts:publish",
    group: "publish",
    label: "Chop etish va rejalashtirish",
    description: "Postni saytda chop etish, rejalashtirish, chop etishdan olish, arxivlash va ko'rib chiqishdagi postlarni tasdiqlash.",
    english: "Publish, schedule, unpublish and archive posts on the site, and approve or send back posts that staff submitted for review.",
  },
  {
    id: "channels:send",
    group: "publish",
    label: "Telegram kanalga yuborish",
    description: "Postni Telegram kanaliga yuborish yoki kanal xabarini yangilash.",
    english: "Send a post to the Telegram channel or update its channel message.",
  },
  {
    id: "comments:moderate",
    group: "danger",
    label: "Izohlarni boshqarish",
    description: "Izohlarni tasdiqlash, yashirish, spam deb belgilash, o'chirish, admin sifatida javob yozish va mualliflarni bloklash.",
    english: "Approve, hide, mark as spam, delete and reply to comments (as the admin), and ban commenters.",
  },
  {
    id: "posts:delete",
    group: "danger",
    label: "O'chirish",
    description: "Postlarni chiqindi qutisiga olish (va alohida yoqilgan bo'lsa butunlay o'chirish), teglar va media fayllarni o'chirish.",
    english: "Move posts to the trash (and permanently delete them when that extra switch is on), and delete tags and media files.",
  },
];

/** Offline (refresh token) ruxsati — alohida "ruxsat" emas, ulanishni saqlab turish uchun. */
export const MCP_OFFLINE_SCOPE = "offline_access";
export const MCP_OPENID_SCOPE = "openid";

export const MCP_SCOPE_IDS: readonly string[] = MCP_SCOPES.map((scope) => scope.id);

/** Faqat o'qish ruxsati — `MCP_WRITE_TOOLS_ENABLED` o'chiq bo'lganda berilishi mumkin bo'lgan yagona ruxsat (+ `offline_access`). */
export const MCP_GRANTABLE_SCOPE_IDS: readonly string[] = ["blog:read"];
export const MCP_GRANTABLE_OAUTH_SCOPES: readonly string[] = [...MCP_GRANTABLE_SCOPE_IDS, MCP_OFFLINE_SCOPE];

/** Ruxsat har doim yoqilgan va rozilik sahifasida o'chirib bo'lmaydi: barcha vositalar o'qishga tayanadi (postning `updatedAt` belgisi). */
export const MCP_REQUIRED_SCOPE_ID = "blog:read";

/**
 * Hozir berilishi mumkin bo'lgan ruxsatlar. `writeEnabled=false` (standart) — faqat o'qish (PR #11 xatti-harakati);
 * `true` — barcha yozuv ruxsatlari ham. Mavjud (faqat o'qish) rozilik o'z-o'zidan kengaymaydi: yangi ruxsat so'ralsa
 * server yangi rozilik talab qiladi.
 */
export function grantableScopeIds(writeEnabled = false, videoEnabled = false): readonly string[] {
  if (!writeEnabled) return MCP_GRANTABLE_SCOPE_IDS;
  return videoEnabled ? MCP_SCOPE_IDS : MCP_SCOPE_IDS.filter((id) => id !== MCP_VIDEO_SCOPE_ID);
}

export function grantableOAuthScopes(writeEnabled = false, videoEnabled = false): readonly string[] {
  return [...grantableScopeIds(writeEnabled, videoEnabled), MCP_OFFLINE_SCOPE];
}

/** `scope` ro'yxatini berilishi mumkin bo'lganlarga qisqartiradi (takrorlarsiz, tartib saqlanadi). */
export function clampToGrantable(scopes: readonly string[], writeEnabled = false, videoEnabled = false): string[] {
  const allowed = grantableOAuthScopes(writeEnabled, videoEnabled);
  return [...new Set(scopes.filter((scope) => allowed.includes(scope)))];
}

export function findMcpScope(id: string): McpScopeInfo | undefined {
  return MCP_SCOPES.find((scope) => scope.id === id);
}

/** `scope` qatorini ("a b c") massivga ajratadi (bo'sh qiymatlarsiz, takrorlarsiz). */
export function parseScopeString(raw: string | null | undefined): string[] {
  return [...new Set((raw ?? "").split(/\s+/).filter(Boolean))];
}

export interface McpScopeGroupView {
  group: McpScopeGroup;
  label: string;
  scopes: McpScopeInfo[];
}

/**
 * Rozilik sahifasi uchun: so'ralgan scope'larni guruhlarga ajratadi (guruh tartibi o'zgarmas), noma'lum
 * scope'larni `unknown`ga, `offline_access`ni `offline`ga qaytaradi.
 */
export function groupRequestedScopes(requested: readonly string[]): {
  groups: McpScopeGroupView[];
  offline: boolean;
  unknown: string[];
} {
  const set = new Set(requested);
  const groups: McpScopeGroupView[] = [];
  for (const group of MCP_SCOPE_GROUPS) {
    const scopes = MCP_SCOPES.filter((scope) => scope.group === group && set.has(scope.id));
    if (scopes.length > 0) groups.push({ group, label: MCP_SCOPE_GROUP_LABELS[group], scopes });
  }
  const known = new Set<string>([...MCP_SCOPE_IDS, MCP_OFFLINE_SCOPE, MCP_OPENID_SCOPE]);
  return {
    groups,
    offline: set.has(MCP_OFFLINE_SCOPE),
    unknown: requested.filter((id) => !known.has(id)),
  };
}

// ---------------------------------------------------------------------------------------------
// HTTP DTO'lar (rozilik sahifasi va "Ulangan ilovalar")
// ---------------------------------------------------------------------------------------------

export const McpRedirectKindSchema = z.enum(["claude", "loopback", "other"]);
export type McpRedirectKind = z.infer<typeof McpRedirectKindSchema>;

export const McpConsentInfoSchema = z.object({
  /** Joriy foydalanuvchi shu konnektorga ruxsat bera oladimi (faqat admin). */
  allowed: z.boolean(),
  reason: z.enum(["not_admin", "unknown_client"]).nullable(),
  user: z.object({ name: z.string().nullable(), email: z.string(), role: z.string() }),
  client: z
    .object({
      id: z.string(),
      name: z.string().nullable(),
      /** Birinchi redirect URI'ning host qismi (masalan `claude.ai`) — foydalanuvchi qaysi ilova ekanini tekshirishi uchun. */
      redirectHost: z.string().nullable(),
      /** Kod yuboriladigan manzil turi: Claude'ning rasmiy callback'i, lokal loopback (Claude Code) yoki boshqa. */
      redirectKind: McpRedirectKindSchema,
      /** Klient ro'yxatdan o'tgan vaqt (ISO) — "hozirgina" ro'yxatdan o'tgan bo'lishi kerak. */
      registeredAt: z.string().nullable(),
    })
    .nullable(),
  scopes: z.array(z.string()),
});
export type McpConsentInfo = z.infer<typeof McpConsentInfoSchema>;

export const McpConnectionSchema = z.object({
  clientId: z.string(),
  name: z.string().nullable(),
  redirectHost: z.string().nullable(),
  scopes: z.array(z.string()),
  connectedAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type McpConnection = z.infer<typeof McpConnectionSchema>;

export const McpConnectionsResponseSchema = z.object({
  items: z.array(McpConnectionSchema),
  /** Serverda yozuv vositalari (`MCP_WRITE_TOOLS_ENABLED`) hozir yoqilganmi. `false` bo'lsa berilgan yozuv ruxsatlari FAOL EMAS. */
  writeToolsEnabled: z.boolean().optional(),
});
export type McpConnectionsResponse = z.infer<typeof McpConnectionsResponseSchema>;

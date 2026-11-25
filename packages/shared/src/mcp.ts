import { z } from "zod";

/**
 * Claude konnektori (MCP) ruxsatlari. Bu ro'yxat API (metadata, vositalar uchun talab qilingan scope) va web
 * (rozilik sahifasi, "Ulangan ilovalar") uchun YAGONA manba. Yozuv vositalari keyingi PR'da qo'shiladi, lekin
 * ruxsatlar hozirdan belgilangan — keyin foydalanuvchi qayta rozilik berishi shart bo'lmasligi uchun.
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
    description: "Yangi qoralama yaratish va mavjud postlarni tahrirlash (chop etmasdan).",
    english: "Create drafts and edit existing posts without publishing them.",
  },
  {
    id: "media:upload",
    group: "write",
    label: "Media yuklash",
    description: "Rasmlarni media kutubxonasiga yuklash va ularning tavsifini o'zgartirish.",
    english: "Upload images to the media library and edit their alt text.",
  },
  {
    id: "posts:publish",
    group: "publish",
    label: "Chop etish va rejalashtirish",
    description: "Postni saytda chop etish, rejalashtirish yoki chop etishdan olish.",
    english: "Publish, schedule or unpublish posts on the site.",
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
    description: "Izohlarni tasdiqlash, yashirish, o'chirish, ularga javob berish va foydalanuvchilarni bloklash.",
    english: "Approve, hide, delete and reply to comments, and ban commenters.",
  },
  {
    id: "posts:delete",
    group: "danger",
    label: "O'chirish",
    description: "Postlarni chiqindi qutisiga olish va butunlay o'chirish.",
    english: "Move posts to the trash and delete them permanently.",
  },
];

/** Offline (refresh token) ruxsati — alohida "ruxsat" emas, ulanishni saqlab turish uchun. */
export const MCP_OFFLINE_SCOPE = "offline_access";
export const MCP_OPENID_SCOPE = "openid";

export const MCP_SCOPE_IDS: readonly string[] = MCP_SCOPES.map((scope) => scope.id);

/**
 * HOZIR berilishi mumkin bo'lgan ruxsatlar: faqat o'qish (+ `offline_access`). Qolgan ruxsatlar modelda saqlanadi, lekin
 * ularning vositalari yo'q — shu sabab e'lon qilinmaydi, ro'yxatdan o'tishda/authorize'da/rozilikda qabul qilinmaydi.
 * Yozuv vositalari qo'shilganda ruxsat shu ro'yxatga kiritiladi; mavjud (faqat o'qish) rozilik o'z-o'zidan kengaymaydi:
 * yangi ruxsat so'ralsa server yangi rozilik talab qiladi.
 */
export const MCP_GRANTABLE_SCOPE_IDS: readonly string[] = ["blog:read"];
export const MCP_GRANTABLE_OAUTH_SCOPES: readonly string[] = [...MCP_GRANTABLE_SCOPE_IDS, MCP_OFFLINE_SCOPE];

/** `scope` ro'yxatini berilishi mumkin bo'lganlarga qisqartiradi (takrorlarsiz, tartib saqlanadi). */
export function clampToGrantable(scopes: readonly string[]): string[] {
  return [...new Set(scopes.filter((scope) => MCP_GRANTABLE_OAUTH_SCOPES.includes(scope)))];
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
});
export type McpConnectionsResponse = z.infer<typeof McpConnectionsResponseSchema>;

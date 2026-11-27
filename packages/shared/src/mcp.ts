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
  /** `true` — hisob/sayt boshqaruvi ruxsati (xodimlar, sozlamalar): rozilik sahifasida alohida ogohlantirish chiqadi. */
  sensitive?: boolean;
}

/** Video render ruxsati: faqat `VIDEO_ENABLED` YOQILGANDA (va yozuv kaliti ham yoqilgan bo'lsa) beriladi. */
export const MCP_VIDEO_SCOPE_ID = "video:render";
/**
 * Ijtimoiy tarmoqlarga post chiqarish ruxsati. FAQAT yozuv kaliti VA `DISTRIBUTION_ENABLED` ikkalasi yoqilganda beriladi
 * (`grantableScopeIds`); bayroq o'chiq bo'lsa u e'lon qilinmaydi, so'ralmaydi va rozilik sahifasida chiqmaydi.
 */
export const MCP_SOCIAL_SCOPE_ID = "social:post";

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
    description: "Yangi qoralama yaratish, postlarni tahrirlash (asosiy videoni tanlash ham) va teglarni boshqarish (chop etmasdan), chiqindi qutisidan qaytarish.",
    english: "Create drafts, edit posts (including choosing the post main video from its finished renders), manage tags (create, rename) and restore posts from the trash, without publishing anything.",
  },
  {
    id: "media:upload",
    group: "write",
    label: "Media yuklash",
    description: "Rasmlarni media kutubxonasiga yuklash va ularning alt matnini o'zgartirish.",
    english: "Upload images to the media library and edit their alt text.",
  },
  {
    id: "channels:prepare",
    group: "write",
    label: "Telegram kanal versiyalarini tayyorlash",
    description: "Kanal uchun maxsus matn versiyalarini yaratish, tahrirlash va o'chirish hamda postda qaysi versiya yuborilishini belgilash. Hech narsa kanalga hozir yuborilmaydi; lekin rejalashtirilgan kanalga yuborish ishlatadigan versiya yoki belgini o'zgartirish uchun \"Kanalga yuborish\" ruxsati ham kerak.",
    english: "Prepare Telegram channel versions: create, edit and delete custom versions and mark which version a post uses. Nothing is sent to the channel now; changing a version or mark that a scheduled channel send relies on also needs the channel-sending permission.",
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
    id: MCP_SOCIAL_SCOPE_ID,
    group: "publish",
    label: "Ijtimoiy tarmoqlarga post chiqarish",
    description:
      "Postni LinkedIn, X, Threads, Instagram'da ommaviy e'lon qilish yoki rejalashtirish, matnini va nomli versiyalarini saqlash, «saytga chiqqach N daqiqadan keyin» rejasini qo'yish, qayta urinish, bekor qilish va yuborilgan postni tarmoqdan o'chirish. Telegram kanal ruxsatidan alohida.",
    english:
      "Post to the owner's public social accounts (LinkedIn, X, Threads, Instagram, GitHub profile README): send or schedule a distribution (or plan one for N minutes after the post is published), save its text and named versions, retry, cancel, and remove a sent post from the platform. Separate from the Telegram channel permission. Only grantable when social distribution is enabled.",
  },
  {
    id: "comments:moderate",
    group: "danger",
    label: "Izohlarni boshqarish",
    description: "Izohlarni tasdiqlash, yashirish, spam deb belgilash, o'chirish, admin sifatida javob yozish va mualliflarni bloklash.",
    english: "Approve, hide, mark as spam, delete and reply to comments (as the admin), and ban commenters.",
  },
  {
    id: "staff:manage",
    group: "danger",
    label: "Xodimlarni boshqarish",
    description: "Xodimlar va takliflar ro'yxatini ko'rish, taklif havolasi yaratish va bekor qilish, xodimni olib tashlash. Taklif havolasi parol kabi maxfiy: kim ochsa, xodim bo'ladi.",
    english: "List staff members and pending invites, create and revoke staff invites (an invite link is a credential: whoever opens it becomes staff) and remove staff members.",
    sensitive: true,
  },
  {
    id: "settings:manage",
    group: "danger",
    label: "Sayt sozlamalarini boshqarish",
    description: "Sayt nomi/tavsifi, ijtimoiy havolalar, standart post sozlamalari va \"Haqida\" sahifasini o'zgartirish; integratsiyalar holatini (sozlangan yoki yo'q) ko'rish. Hech qanday kalit yoki parol ko'rinmaydi va o'zgartirilmaydi.",
    english: "Change the site name and description, social links, default post settings and the About page, and see whether each integration is configured. No key, token or password is ever shown or changed.",
    sensitive: true,
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
export function grantableScopeIds(writeEnabled = false, distributionEnabled = false, videoEnabled = false): readonly string[] {
  if (!writeEnabled) return MCP_GRANTABLE_SCOPE_IDS;
  // `social:post` va `video:render` — har biri o'z bayrog'i yoqilgandagina; bayroqlar o'chiq bo'lsa ro'yxat avvalgidek.
  return MCP_SCOPE_IDS.filter((id) => (id !== MCP_SOCIAL_SCOPE_ID || distributionEnabled) && (id !== MCP_VIDEO_SCOPE_ID || videoEnabled));
}

export function grantableOAuthScopes(writeEnabled = false, distributionEnabled = false, videoEnabled = false): readonly string[] {
  return [...grantableScopeIds(writeEnabled, distributionEnabled, videoEnabled), MCP_OFFLINE_SCOPE];
}

/** `scope` ro'yxatini berilishi mumkin bo'lganlarga qisqartiradi (takrorlarsiz, tartib saqlanadi). */
export function clampToGrantable(scopes: readonly string[], writeEnabled = false, distributionEnabled = false, videoEnabled = false): string[] {
  const allowed = grantableOAuthScopes(writeEnabled, distributionEnabled, videoEnabled);
  return [...new Set(scopes.filter((scope) => allowed.includes(scope)))];
}

/** Hisob/sayt boshqaruvi ruxsatlari (`sensitive`): rozilik sahifasi va "Ulangan ilovalar" ularni alohida ajratadi. */
export const MCP_SENSITIVE_SCOPE_IDS: readonly string[] = MCP_SCOPES.filter((scope) => scope.sensitive).map((scope) => scope.id);

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

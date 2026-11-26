import type { ChannelCheck } from "./dto.js";

/**
 * Ijtimoiy tarqatish (LinkedIn, X, Threads, Instagram, GitHub README): API va admin panel o'rtasidagi umumiy turlar
 * va matn uzunligini platforma sanagandek hisoblash. Hech narsa import paytida ishlamaydi.
 */

export const DISTRIBUTION_PROVIDERS = ["linkedin", "x", "threads", "instagram", "github"] as const;
export type DistributionProviderId = (typeof DISTRIBUTION_PROVIDERS)[number];

/** Telegram ro'yxatda FAQAT ko'rsatiladi (o'qish rejimida) — bu PR'da u shu tizimga ko'chirilmaydi. */
export type DistributionChannelId = DistributionProviderId | "telegram";

export const DISTRIBUTION_STATUSES = ["draft", "scheduled", "sending", "sent", "failed", "needs_checking", "cancelled"] as const;
export type DistributionStatus = (typeof DISTRIBUTION_STATUSES)[number];

export const DISTRIBUTION_STATUS_LABELS: Record<DistributionStatus, string> = {
  draft: "Qoralama",
  scheduled: "Rejalashtirilgan",
  sending: "Yuborilmoqda",
  sent: "Yuborilgan",
  failed: "Xato",
  needs_checking: "Tekshirish kerak",
  cancelled: "Bekor qilingan",
};

/** Faol (hali yakunlanmagan) holatlar: bitta post + kanal uchun ko'pi bilan bittasi. */
export const ACTIVE_DISTRIBUTION_STATUSES: readonly DistributionStatus[] = ["draft", "scheduled", "sending", "failed", "needs_checking"];

export type DistributionErrorKindDto =
  | "auth_expired"
  | "permission_missing"
  | "rate_limited"
  | "validation_rejected"
  | "duplicate_content"
  | "payment_required"
  | "transient"
  | "outcome_unknown"
  | "refresh_ambiguous"
  | "not_supported"
  | "internal";

export type DistributionImageChoice = "auto" | "cover" | "og" | "none";
export const DISTRIBUTION_IMAGE_CHOICES: readonly DistributionImageChoice[] = ["auto", "cover", "og", "none"];

export type DistributionLinkMode = "article" | "text";

export type DistributionTokenState = "ok" | "expiring" | "expired" | "none";

export interface DistributionAccountDto {
  id: string;
  displayName: string;
  username: string | null;
  status: "active" | "reauth_required";
  scopes: string[];
  connectedAt: string;
  tokenState: DistributionTokenState;
  /** Token (yoki refresh orqali davom etganda refresh token) tugash vaqti; noma'lum bo'lsa null. */
  expiresAt: string | null;
  daysLeft: number | null;
  canRefresh: boolean;
  /** Saqlangan token deshifrlanmaydi (masalan `BETTER_AUTH_SECRET` almashtirilgan) — faqat qayta ulash yordam beradi. */
  secretUnreadable?: boolean;
  /** Platforma muddat bermagan token (Instagram Unified Login) — "N kun qoldi" ko'rsatilmaydi, eslatma ham yo'q. */
  neverExpires?: boolean;
}

export interface DistributionCredentialField {
  value: string;
  source: "env" | "db" | "none";
  isSet: boolean;
  envVar: string | null;
}

export interface DistributionProviderCapabilitiesDto {
  text: boolean;
  image: boolean;
  delete: boolean;
  deleteNote: string | null;
  textMax: number | null;
  textUnit: "characters" | "weighted" | "utf8_bytes" | "none";
}

/** Sozlamalar bo'limi uchun: provider metama'lumoti + qayta yo'naltirish URL + hisob ma'lumotlari holati + ulangan akkaunt. */
export interface DistributionProviderSettingsDto {
  id: DistributionProviderId;
  name: string;
  authKind: "oauth_code" | "oauth_pkce" | "pasted_token";
  ownerSetup: string[];
  scopes: string[];
  redirectUrl: string | null;
  costsMoney: boolean;
  costNote: string;
  tokenLifetime: string;
  restrictions: string[];
  docs: string[];
  /** OAuth provider uchun client id/secret (maxfiy qiymat maskalangan). GitHub (token yopishtiriladi) uchun null. */
  credentials: { clientId: DistributionCredentialField; clientSecret: DistributionCredentialField; /** Faqat Instagram (maxfiy emas). */ configId?: DistributionCredentialField } | null;
  /** Ixtiyoriy: maydon yorliqlari (Instagram: "Meta App ID" / "Meta App Secret" / "Config ID"). Yo'q bo'lsa UI standart yorliqlarni ishlatadi. */
  credentialLabels?: { clientId: string; clientSecret: string; configId?: string };
  credentialsReady: boolean;
  /** Saqlangan Client Secret deshifrlanmaydi (maxfiy kalit almashtirilgan) — qaytadan kiriting. */
  credentialsUnreadable?: boolean;
  account: DistributionAccountDto | null;
  capabilities: DistributionProviderCapabilitiesDto;
}

export interface DistributionSettingsResponse {
  enabled: true;
  providers: DistributionProviderSettingsDto[];
  /** Hech narsa chop etilganda AVTOMATIK yuborilmaydi — UI shuni ko'rsatadi. */
  autoPost: false;
  linkedinTermsNote: string;
}

export type DistributionCredentialsPatch = Partial<Record<Exclude<DistributionProviderId, "github">, { clientId?: string; clientSecret?: string; configId?: string }>>;

export interface DistributionChannelDto {
  id: DistributionChannelId;
  name: string;
  /** `telegram` — faqat ko'rsatiladi, bu yerdan yuborilmaydi. */
  readOnly: boolean;
  connected: boolean;
  /** Yuborish mumkinmi (ulangan, token ishlaydi, hisob ma'lumotlari bor). */
  ready: boolean;
  /** Ulanmagan/yaroqsiz bo'lsa — sababi (o'zbekcha). */
  notReadyReason: string | null;
  account: DistributionAccountDto | null;
  capabilities: DistributionProviderCapabilitiesDto | null;
}

export interface DistributionItemDto {
  id: string;
  postId: string;
  provider: DistributionProviderId;
  status: DistributionStatus;
  /** Qo'lda tahrirlangan matn (null — standart shablon). */
  text: string | null;
  sentText: string | null;
  imageChoice: DistributionImageChoice;
  linkMode: DistributionLinkMode | null;
  scheduledAt: string | null;
  nextAttemptAt: string | null;
  attempts: number;
  lastErrorKind: DistributionErrorKindDto | null;
  lastErrorMessage: string | null;
  externalId: string | null;
  externalUrl: string | null;
  step: string | null;
  canResume: boolean;
  createdBy: string | null;
  createdVia: string;
  sentAt: string | null;
  removedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DistributionImagePreview {
  /** Qaysi manba ishlatiladi: muqova, saytning OG rasmi yoki rasm yo'q. */
  source: "cover" | "og" | "none";
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  /** Ko'rsatish uchun URL (manba). */
  previewUrl: string | null;
  /** Tayyorlab bo'lmasa sababi. */
  error: string | null;
}

export interface DistributionPreviewResponse {
  provider: DistributionProviderId;
  postId: string;
  postTitle: string;
  postUrl: string;
  /** Hozir yuboriladigan matn (saqlangan tahrir yoki standart). */
  text: string;
  defaultText: string;
  edited: boolean;
  length: number;
  limit: number | null;
  unit: DistributionProviderCapabilitiesDto["textUnit"];
  image: DistributionImagePreview;
  imageChoice: DistributionImageChoice;
  linkMode: DistributionLinkMode | null;
  checks: ChannelCheck[];
  canSend: boolean;
  errorCount: number;
  warnCount: number;
  channel: DistributionChannelDto;
  distribution: DistributionItemDto | null;
  /** Shu post+kanalga avval muvaffaqiyatli yuborilgan nusxa (qayta yuborish ogohlantirishi uchun). */
  previouslySent: DistributionItemDto | null;
}

export interface DistributionPostResponse {
  channels: DistributionChannelDto[];
  distributions: DistributionItemDto[];
  /** Doim `false`: chop etilganda hech narsa avtomatik yuborilmaydi. */
  autoPost: false;
  /** Post savatda (o'chirilgan): faqat ko'rish va platformadan olib tashlash mumkin; yangi yuborish yo'q. Savatda bo'lmasa maydon yo'q. */
  postDeleted?: true;
}

// --- Matn uzunligini platforma sanagandek hisoblash (API providerlarining `measureText` bilan bir xil; API testi tengligini tekshiradi) ---

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
const URL_RE = /https?:\/\/[^\s<>"]+/giu;
const URL_TRAILING_RE = /[.,;:!?)\]}'»”’]+$/u;
const X_TCO_URL_WEIGHT = 23;

function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

export function codePointLength(text: string): number {
  return Array.from(text).length;
}

function utf8Length(text: string): number {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

function findUrls(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const trimmed = m[0].replace(URL_TRAILING_RE, "");
    if (trimmed.length < 8) continue;
    out.push({ start: m.index, end: m.index + trimmed.length });
  }
  return out;
}

function xCharWeight(cp: number): number {
  if (cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247)) return 1;
  return 2;
}

export function xWeightedLength(raw: string): number {
  const text = raw.normalize("NFC");
  let total = 0;
  let cursor = 0;
  const countPlain = (chunk: string) => {
    for (const g of graphemes(chunk)) {
      if (EMOJI_RE.test(g) && !/^[0-9#*]$/.test(g)) total += 2;
      else for (const ch of g) total += xCharWeight(ch.codePointAt(0)!);
    }
  };
  for (const u of findUrls(text)) {
    countPlain(text.slice(cursor, u.start));
    total += X_TCO_URL_WEIGHT;
    cursor = u.end;
  }
  countPlain(text.slice(cursor));
  return total;
}

export function threadsLength(text: string): number {
  let n = 0;
  for (const g of graphemes(text)) n += EMOJI_RE.test(g) && !/^[0-9#*]$/.test(g) ? utf8Length(g) : codePointLength(g);
  return n;
}

/** Provayderning o'z uzunlik hisobi (LinkedIn/Instagram/GitHub — code point; X — vaznli; Threads — emoji UTF-8 bayt). */
export function measureSocialText(provider: DistributionProviderId, text: string): number {
  if (provider === "x") return xWeightedLength(text);
  if (provider === "threads") return threadsLength(text);
  return codePointLength(text);
}

export interface CounterState {
  length: number;
  limit: number | null;
  remaining: number | null;
  level: "ok" | "warn" | "over" | "none";
}

/** Jonli hisoblagich: chegaradan oshgan = `over`, 95% dan yuqori = `warn`. */
export function socialCounterState(provider: DistributionProviderId, text: string, limit: number | null): CounterState {
  const length = measureSocialText(provider, text);
  if (limit === null) return { length, limit, remaining: null, level: "none" };
  const remaining = limit - length;
  return { length, limit, remaining, level: length > limit ? "over" : length > limit * 0.95 ? "warn" : "ok" };
}

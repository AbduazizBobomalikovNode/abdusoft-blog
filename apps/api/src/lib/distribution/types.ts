import type { ChannelCheck } from "@blog/shared";
import type { PartialRefs } from "./errors.js";
import type { ProviderDeps } from "./http.js";
import type { TokenPolicy, TokenStatus } from "./token-status.js";

/**
 * Provider shartnomasi. Keyingi integratsiya PR'i platforma tafsilotlarini bilmasdan shu interfeys orqali ishlaydi.
 *
 * Telegram bilan moslik (kelajakda Telegram ham shu shartnomaga o'tishi uchun):
 *  - `preflight` — `ChannelCheck[]` (id/group/status/title/message/value/limit/imageUrl), Telegram preflight bilan AYNAN bir xil shakl;
 *  - `PublishInput.text` — Telegram `captionHtml`ga mos "tayyor matn" (caller bergan yoki `renderDefaultText`);
 *  - `PublishResult` — Telegram `telegramRefs` (message id) ga mos `externalId` + `url`;
 *  - `remove` — Telegram `deleteMessage`ga mos.
 *
 * XAVFSIZLIK / QAYTA URINISH QOIDASI: `publish` timeout yoki uzilgan ulanishda `DistributionError{kind:"outcome_unknown"}`
 * tashlashi mumkin. Bu "post yaratilgan bo'lishi mumkin" degani — chaqiruvchi yaratishni KO'R-KO'RONA QAYTA URINMASLIGI shart.
 * Faqat `transient` va `rate_limited` (retryAt dan keyin) xavfsiz qayta uriniladi.
 *
 * Saqlash (DB, shifrlash) — chaqiruvchining vazifasi (`lib/crypto.ts` `encryptSecret`). Bu modul hech narsani saqlamaydi,
 * env o'qimaydi, log yozmaydi.
 */

export type ProviderId = "linkedin" | "x" | "threads" | "instagram" | "github";

export type AuthKind = "oauth_code" | "oauth_pkce" | "pasted_token";

export interface ProviderCapabilities {
  text: boolean;
  link: boolean;
  image: boolean;
  /** Mavjud postni tahrirlash (update). */
  edit: boolean;
  delete: boolean;
  /** Platformaning o'z rejalashtirishi. Hozirgi barcha platformalar uchun false — rejalashtirish chaqiruvchi tomonda. */
  nativeScheduling: false;
  /** Qo'llanmaydigan amallar sababi (`delete: false` / `edit: false` bo'lganda). `remove`/`update` shunda `not_supported` tashlaydi. */
  notes?: { delete?: string; edit?: string };
}

export interface ProviderLimits {
  /** Matn chegarasi (platforma o'lchov birligida — `textUnit`). Matn qabul qilmaydigan provider (GitHub) uchun null. */
  textMax: number | null;
  textUnit: "characters" | "weighted" | "utf8_bytes" | "none";
  imageMaxBytes: number | null;
  imageMimes: readonly string[];
}

export interface ClientCredentials {
  clientId: string;
  /** Konfidensial mijoz uchun (LinkedIn, Threads, Instagram: majburiy; X: ixtiyoriy — public client). */
  clientSecret?: string;
  redirectUri: string;
  /** Ixtiyoriy, maxfiy EMAS: Instagram (Unified Login) konfiguratsiya id'si (`config_id`). Boshqa providerlar e'tiborsiz qoldiradi. */
  configId?: string;
}

/** Normallashtirilgan akkaunt yozuvi. Saqlash — chaqiruvchida (token maydonlari shifrlanishi kerak). */
export interface ConnectedAccount {
  provider: ProviderId;
  externalId: string;
  displayName: string;
  username?: string;
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  scopes: string[];
  /** Access token berilgan (yoki oxirgi marta yangilangan) vaqt. */
  issuedAt: Date;
  connectedAt: Date;
  /** Providerga xos qo'shimcha maydonlar (masalan GitHub `owner`/`repo`). */
  meta?: Record<string, string>;
}

export interface RefreshResult {
  account: ConnectedAccount;
  /** Javobda YANGI refresh token keldimi (rotatsiya). `false` bo'lsa `account.refreshToken` eskisi. */
  refreshTokenRotated: boolean;
}

export interface AuthorizationUrlInput {
  creds: ClientCredentials;
  state: string;
  /** PKCE (`oauth_pkce` provider'lar uchun majburiy): S256 challenge. */
  codeChallenge?: string;
}

export interface ExchangeCodeInput {
  creds: ClientCredentials;
  code: string;
  /** PKCE verifier (`oauth_pkce`). */
  codeVerifier?: string;
}

export interface ProviderAuth {
  kind: AuthKind;
  scopes: readonly string[];
  /** `oauth_*` uchun. Sof funksiya (tarmoqsiz). */
  buildAuthorizationUrl?(input: AuthorizationUrlInput): string;
  exchangeCode?(deps: ProviderDeps, input: ExchangeCodeInput): Promise<ConnectedAccount>;
  /**
   * Yangilash mumkin bo'lgan platformalar. MUHIM (X, rotatsiyali refresh token): qaytgan `account` ni (yangi refresh token
   * bilan) YANGI access token'dan FOYDALANISHDAN OLDIN saqlang — aks holda eski refresh token bekor bo'lib, akkaunt yo'qoladi.
   * `refreshTokenRotated=false` — javobda yangi refresh token kelmadi (eskisi saqlandi; X hujjati rotatsiyani aniq aytmaydi — UNVERIFIED).
   * Aloqa uzilishi/5xx: `refresh_ambiguous` — token almashgan bo'lishi mumkin; keyingi yangilash ham xato bersa, qayta ulang.
   */
  refresh?(deps: ProviderDeps, creds: ClientCredentials, account: ConnectedAccount): Promise<RefreshResult>;
  /** Yopishtirilgan token (GitHub): tokenni tekshiradi va akkaunt yozuvini qaytaradi. */
  connectWithToken?(deps: ProviderDeps, token: string): Promise<ConnectedAccount>;
}

/** Post — `lib/posts` dagi post shaklidan kerakli maydonlar (title, excerpt, URL, teglar). */
export interface DistributionPost {
  title: string;
  excerpt: string | null;
  /** Maqolaning to'liq (mutlaq, https) URL'i. */
  url: string;
  /** Teg nomlari yoki slug'lari (hashtag'ga aylanadi). */
  tags: readonly string[];
  publishedAt?: Date | null;
}

/** Rasm metama'lumotlari (preflight uchun). Konvertatsiya bu yerda QILINMAYDI — preflight nima kerakligini aytadi. */
export interface ImageMeta {
  mime: string;
  width: number;
  height: number;
  sizeBytes: number;
}

export interface ImageInput extends ImageMeta {
  bytes: Uint8Array;
  alt?: string;
}

export interface RenderOptions {
  /** Instagram: URL'ni matnga qo'shish (bosilmaydi). Standart: false. */
  includeUrl?: boolean;
  /** Matnga qo'shiladigan maksimal hashtag soni (provider standartini kamaytirish uchun). */
  maxHashtags?: number;
}

export interface PreflightInput {
  post: DistributionPost;
  /** Caller bergan matn; bo'lmasa `renderDefaultText` ishlatiladi. */
  text?: string;
  image?: ImageMeta;
  /** Threads/Instagram: ommaviy rasm URL'i. */
  imageUrl?: string;
  /** LinkedIn: `article` (standart, rasm kerak) yoki `text` (matn + havola). */
  linkMode?: "article" | "text";
  /** GitHub: README'ning joriy matni (caller o'qiydi) — markerlar bor-yo'qligini tekshirish uchun. */
  currentReadme?: string;
}

export interface PublishInput {
  post: DistributionPost;
  /** Tayyor matn (caller yoki `renderDefaultText`). */
  text: string;
  image?: ImageInput;
  imageUrl?: string;
  linkMode?: "article" | "text";
  /** GitHub: README ro'yxati uchun oxirgi postlar (yangisi birinchi). GitHub uchun MAJBURIY (bo'sh bo'lmagan), boshqalar e'tiborsiz qoldiradi. */
  latestPosts?: readonly DistributionPost[];
  /**
   * Oldingi urinishdan qolgan TAYYOR narsalar (`DistributionError.partial`): shu bilan `publish` mavjud rasm/konteynerni
   * qayta ishlatadi, ikkinchisini yaratmaydi. `outcome_unknown` dan keyin davom ettirishdan oldin platformani tekshiring.
   */
  resume?: PartialRefs;
}

export interface PublishResult {
  externalId: string;
  url: string | null;
}

export interface ProviderContext {
  deps: ProviderDeps;
  account: ConnectedAccount;
}

export interface DistributionProvider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  readonly limits: ProviderLimits;
  readonly auth: ProviderAuth;
  readonly tokenPolicy: TokenPolicy;

  /** Token holati (soat — `now`). */
  tokenStatus(account: ConnectedAccount, now: Date): TokenStatus;
  /** Default matn (deterministik shablon). */
  renderDefaultText(post: DistributionPost, opts?: RenderOptions): string;
  /** Platforma hisoblaganidek uzunlik (`limits.textUnit` birligida). */
  measureText(text: string): number;
  /** Telegram preflight bilan bir xil shakl. Tarmoqsiz. */
  preflight(input: PreflightInput): ChannelCheck[];
  /** Post yaratadi. `outcome_unknown` — qayta urinmang (yuqoridagi qoida). */
  publish(ctx: ProviderContext, input: PublishInput): Promise<PublishResult>;
  /** Postni o'chiradi. `capabilities.delete=false` bo'lsa `DistributionError{kind:"not_supported"}` tashlaydi. */
  remove(ctx: ProviderContext, externalId: string): Promise<void>;
  /** Mavjud postni yangilaydi (`capabilities.edit`). */
  update?(ctx: ProviderContext, externalId: string, input: PublishInput): Promise<PublishResult>;
}

export type { ChannelCheck, ProviderDeps, TokenPolicy, TokenStatus };

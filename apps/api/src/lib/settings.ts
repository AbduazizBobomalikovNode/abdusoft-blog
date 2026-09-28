import { randomBytes } from "node:crypto";
import { inArray } from "drizzle-orm";
import {
  SECRET_KEEP_PREFIX,
  type GeneralSettingsPatch,
  type GithubSettingsPatch,
  type R2SettingsPatch,
  type SettingsAdmin,
  type SettingsPatch,
  type SettingSource,
  type TelegramSettingsPatch,
  type TelegraphSettingsPatch,
  type TurnstileSettingsPatch,
  type UmamiSettingsPatch,
} from "@blog/shared";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { siteSettings } from "../db/schema.js";
import { decryptSecret, encryptSecret, maskSecret } from "./crypto.js";
import { getStoredTelegraphToken, loadSiteSettings, storeTelegraphToken, upsertSiteSetting, TELEGRAM_KEY } from "./site-settings.js";

/** Bot token bo'lsa, webhook secret kamida shuncha belgidan iborat bo'lishi SHART — aks holda bot yoqilmaydi (server qulab tushmaydi, faqat bot o'chiq qoladi). */
export const MIN_WEBHOOK_SECRET_LENGTH = 16;

// ---------------------------------------------------------------------------
// DB kalitlar — mavjud `site_settings` jadvalidagi eski kalitlar
// ("about", "social", "telegram", "telegraph", ...) bilan TO'QNASHMASLIGI
// uchun barchasi "settings:" prefiksi bilan.
// ---------------------------------------------------------------------------

const KEY_TELEGRAM = "settings:telegram";
const KEY_TELEGRAPH = "settings:telegraph";
const KEY_TURNSTILE = "settings:turnstile";
const KEY_R2 = "settings:r2";
const KEY_UMAMI = "settings:umami";
const KEY_GITHUB = "settings:github";
const KEY_GENERAL = "settings:general";
const ALL_KEYS = [KEY_TELEGRAM, KEY_TELEGRAPH, KEY_TURNSTILE, KEY_R2, KEY_UMAMI, KEY_GITHUB, KEY_GENERAL];

interface TelegramRaw {
  botToken?: string;
  webhookSecret?: string;
  adminChatId?: string;
  adminUserIds?: string;
  channelId?: string;
  apiRoot?: string;
}
interface TelegraphRaw {
  enabled?: boolean;
}
interface TurnstileRaw {
  siteKey?: string;
  secretKey?: string;
  required?: boolean;
}
interface R2Raw {
  accountId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket?: string;
  publicUrl?: string;
}
interface UmamiRaw {
  apiUrl?: string;
  websiteId?: string;
  scriptUrl?: string;
  apiKey?: string;
  username?: string;
  password?: string;
}
interface GithubRaw {
  clientId?: string;
  clientSecret?: string;
  loginEnabled?: boolean;
}
interface GeneralRaw {
  siteName?: string;
  siteDescription?: string;
}

interface RawMap {
  telegram: TelegramRaw;
  telegraph: TelegraphRaw;
  turnstile: TurnstileRaw;
  r2: R2Raw;
  umami: UmamiRaw;
  github: GithubRaw;
  general: GeneralRaw;
}

async function loadRawMap(): Promise<RawMap> {
  const rows = await db.select().from(siteSettings).where(inArray(siteSettings.key, ALL_KEYS));
  const map = new Map(rows.map((r) => [r.key, r.value as Record<string, unknown>]));
  return {
    telegram: (map.get(KEY_TELEGRAM) as TelegramRaw) ?? {},
    telegraph: (map.get(KEY_TELEGRAPH) as TelegraphRaw) ?? {},
    turnstile: (map.get(KEY_TURNSTILE) as TurnstileRaw) ?? {},
    r2: (map.get(KEY_R2) as R2Raw) ?? {},
    umami: (map.get(KEY_UMAMI) as UmamiRaw) ?? {},
    github: (map.get(KEY_GITHUB) as GithubRaw) ?? {},
    general: (map.get(KEY_GENERAL) as GeneralRaw) ?? {},
  };
}

// ---------------------------------------------------------------------------
// Precedence: env (non-empty) > DB > default
// ---------------------------------------------------------------------------

interface Picked<T> {
  value: T;
  source: SettingSource;
  envVar: string | null;
}

function envRaw(name: string): string {
  return process.env[name] ?? "";
}

function pickString(envVar: string | null, dbValue: string | undefined, fallback = ""): Picked<string> {
  const ev = envVar ? envRaw(envVar) : "";
  if (ev) return { value: ev, source: "env", envVar };
  if (dbValue) return { value: dbValue, source: "db", envVar };
  return { value: fallback, source: "none", envVar };
}

/** Sirli (encrypted) DB qiymatini deshifrlab, keyin oddiy string precedence bilan bir xil tarzda ishlatadi. */
function pickSecret(envVar: string | null, dbRawValue: string | undefined): Picked<string> {
  return pickString(envVar, decryptSecret(dbRawValue));
}

function pickBool(envVar: string | null, dbValue: boolean | undefined, fallback: boolean): Picked<boolean> {
  const raw = envVar ? envRaw(envVar) : "";
  if (envVar && raw) return { value: raw === "true" || raw === "1", source: "env", envVar };
  if (dbValue !== undefined) return { value: dbValue, source: "db", envVar };
  return { value: fallback, source: "none", envVar };
}

// ---------------------------------------------------------------------------
// Merged (plain) settings — konsumerlar (turnstile.ts, umami.ts, telegram/*, ...) shundan foydalanadi
// ---------------------------------------------------------------------------

export interface MergedSettings {
  telegram: {
    botToken: string;
    webhookSecret: string;
    adminChatId: string;
    adminUserIds: number[];
    channelId: string;
    apiRoot: string;
    notifyComments: boolean;
    digestEnabled: boolean;
    /** `botToken` bor va `webhookSecret` yetarlicha uzun bo'lsa `true` — shundagina bot yaratiladi/webhook o'rnatiladi. */
    enabled: boolean;
    disabledReason: string | null;
  };
  telegraph: {
    enabled: boolean;
    accessToken: string;
  };
  turnstile: {
    siteKey: string;
    secretKey: string;
    required: boolean;
  };
  r2: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    publicUrl: string;
    enabled: boolean;
  };
  umami: {
    apiUrl: string;
    websiteId: string;
    scriptUrl: string;
    apiKey: string;
    username: string;
    password: string;
  };
  github: {
    clientId: string;
    clientSecret: string;
    loginEnabled: boolean;
    /** OAuth provider ro'yxatdan o'tkazish uchun yetarli ma'lumot bor-yo'qligi (clientId+clientSecret). */
    providerEnabled: boolean;
  };
  general: {
    siteName: string;
    siteDescription: string;
  };
}

function parseAdminUserIds(raw: string): number[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

async function computeAll(): Promise<{ merged: MergedSettings; admin: SettingsAdmin }> {
  const raw = await loadRawMap();
  const legacy = await loadSiteSettings();
  const legacyTelegraphToken = await getStoredTelegraphToken();

  // --- telegram ---
  const botToken = pickSecret("TELEGRAM_BOT_TOKEN", raw.telegram.botToken);
  const webhookSecret = pickSecret("TELEGRAM_WEBHOOK_SECRET", raw.telegram.webhookSecret);
  const adminChatId = pickString("TELEGRAM_ADMIN_CHAT_ID", raw.telegram.adminChatId);
  const adminUserIds = pickString("TELEGRAM_ADMIN_USER_IDS", raw.telegram.adminUserIds);
  const channelId = pickString("TELEGRAM_CHANNEL_ID", raw.telegram.channelId);
  const apiRoot = pickString("TELEGRAM_API_ROOT", raw.telegram.apiRoot, "https://api.telegram.org");

  let telegramEnabled = false;
  let disabledReason: string | null = null;
  if (botToken.value) {
    if (webhookSecret.value.length >= MIN_WEBHOOK_SECRET_LENGTH) {
      telegramEnabled = true;
    } else {
      disabledReason = `Bot token sozlangan, lekin webhook secret yo'q yoki juda qisqa (kamida ${MIN_WEBHOOK_SECRET_LENGTH} belgi) — bot ishga tushirilmadi.`;
    }
  }

  // --- telegraph --- (accessToken `getStoredTelegraphToken()` orqali allaqachon deshifrlangan holda keladi)
  const telegraphEnabled = pickBool("TELEGRAPH_ENABLED", raw.telegraph.enabled, false);
  const telegraphTokenEnv = envRaw("TELEGRAPH_ACCESS_TOKEN");
  const telegraphAccessToken: Picked<string> = telegraphTokenEnv
    ? { value: telegraphTokenEnv, source: "env", envVar: "TELEGRAPH_ACCESS_TOKEN" }
    : legacyTelegraphToken
      ? { value: legacyTelegraphToken, source: "db", envVar: "TELEGRAPH_ACCESS_TOKEN" }
      : { value: "", source: "none", envVar: "TELEGRAPH_ACCESS_TOKEN" };

  // --- turnstile ---
  const turnstileSiteKey = pickString(null, raw.turnstile.siteKey);
  const turnstileSecretKey = pickSecret("TURNSTILE_SECRET_KEY", raw.turnstile.secretKey);
  const turnstileRequired = pickBool("REQUIRE_TURNSTILE", raw.turnstile.required, false);

  // --- r2 ---
  const r2AccountId = pickString("R2_ACCOUNT_ID", raw.r2.accountId);
  const r2AccessKeyId = pickString("R2_ACCESS_KEY_ID", raw.r2.accessKeyId);
  const r2SecretAccessKey = pickSecret("R2_SECRET_ACCESS_KEY", raw.r2.secretAccessKey);
  const r2Bucket = pickString("R2_BUCKET", raw.r2.bucket);
  const r2PublicUrl = pickString("R2_PUBLIC_URL", raw.r2.publicUrl);
  const r2Enabled = Boolean(
    r2AccountId.value && r2AccessKeyId.value && r2SecretAccessKey.value && r2Bucket.value && r2PublicUrl.value,
  );

  // --- umami ---
  const umamiApiUrl = pickString("UMAMI_API_URL", raw.umami.apiUrl);
  const umamiWebsiteId = pickString("UMAMI_WEBSITE_ID", raw.umami.websiteId);
  const umamiScriptUrl = pickString("UMAMI_SCRIPT_URL", raw.umami.scriptUrl);
  const umamiApiKey = pickSecret("UMAMI_API_KEY", raw.umami.apiKey);
  const umamiUsername = pickString("UMAMI_USERNAME", raw.umami.username);
  const umamiPassword = pickSecret("UMAMI_PASSWORD", raw.umami.password);

  // --- github ---
  const githubClientId = pickString("GITHUB_CLIENT_ID", raw.github.clientId);
  const githubClientSecret = pickSecret("GITHUB_CLIENT_SECRET", raw.github.clientSecret);
  const githubLoginEnabled = pickBool(null, raw.github.loginEnabled, Boolean(githubClientId.value && githubClientSecret.value));
  const githubProviderEnabled = Boolean(githubClientId.value && githubClientSecret.value);

  // --- general ---
  const generalSiteName = pickString("SITE_NAME", raw.general.siteName, "abdusoft");
  const generalSiteDescription = pickString(null, raw.general.siteDescription);

  const merged: MergedSettings = {
    telegram: {
      botToken: botToken.value,
      webhookSecret: webhookSecret.value,
      adminChatId: adminChatId.value,
      adminUserIds: parseAdminUserIds(adminUserIds.value),
      channelId: channelId.value,
      apiRoot: apiRoot.value,
      notifyComments: legacy.telegram.notifyComments,
      digestEnabled: legacy.telegram.digestEnabled,
      enabled: telegramEnabled,
      disabledReason,
    },
    telegraph: {
      enabled: telegraphEnabled.value,
      accessToken: telegraphAccessToken.value,
    },
    turnstile: {
      siteKey: turnstileSiteKey.value,
      secretKey: turnstileSecretKey.value,
      required: turnstileRequired.value,
    },
    r2: {
      accountId: r2AccountId.value,
      accessKeyId: r2AccessKeyId.value,
      secretAccessKey: r2SecretAccessKey.value,
      bucket: r2Bucket.value,
      publicUrl: r2PublicUrl.value,
      enabled: r2Enabled,
    },
    umami: {
      apiUrl: umamiApiUrl.value,
      websiteId: umamiWebsiteId.value,
      scriptUrl: umamiScriptUrl.value,
      apiKey: umamiApiKey.value,
      username: umamiUsername.value,
      password: umamiPassword.value,
    },
    github: {
      clientId: githubClientId.value,
      clientSecret: githubClientSecret.value,
      loginEnabled: githubLoginEnabled.value,
      providerEnabled: githubProviderEnabled,
    },
    general: {
      siteName: generalSiteName.value,
      siteDescription: generalSiteDescription.value,
    },
  };

  function secretField(p: Picked<string>) {
    return { value: p.value ? maskSecret(p.value) : "", source: p.source, isSet: p.source !== "none", envVar: p.envVar };
  }
  function plainField<T extends string | boolean>(p: Picked<T>) {
    return { value: p.value, source: p.source, isSet: p.source !== "none", envVar: p.envVar };
  }

  const admin: SettingsAdmin = {
    telegram: {
      botToken: secretField(botToken),
      webhookSecret: secretField(webhookSecret),
      adminChatId: plainField(adminChatId),
      adminUserIds: plainField(adminUserIds),
      channelId: plainField(channelId),
      apiRoot: plainField(apiRoot),
      notifyComments: { value: legacy.telegram.notifyComments, source: "db", isSet: true, envVar: null },
      digestEnabled: { value: legacy.telegram.digestEnabled, source: "db", isSet: true, envVar: null },
      enabled: telegramEnabled,
      disabledReason,
    },
    telegraph: {
      enabled: plainField(telegraphEnabled),
      accessToken: secretField(telegraphAccessToken),
    },
    turnstile: {
      siteKey: plainField(turnstileSiteKey),
      secretKey: secretField(turnstileSecretKey),
      required: plainField(turnstileRequired),
    },
    r2: {
      accountId: plainField(r2AccountId),
      accessKeyId: plainField(r2AccessKeyId),
      secretAccessKey: secretField(r2SecretAccessKey),
      bucket: plainField(r2Bucket),
      publicUrl: plainField(r2PublicUrl),
    },
    umami: {
      apiUrl: plainField(umamiApiUrl),
      websiteId: plainField(umamiWebsiteId),
      scriptUrl: plainField(umamiScriptUrl),
      apiKey: secretField(umamiApiKey),
      username: plainField(umamiUsername),
      password: secretField(umamiPassword),
    },
    github: {
      clientId: plainField(githubClientId),
      clientSecret: secretField(githubClientSecret),
      loginEnabled: plainField(githubLoginEnabled),
      restartRequired: false, // auth.ts orqali GET /admin/settings marshrutida to'ldiriladi
      callbackUrl: `${config.API_ORIGIN}/api/auth/callback/github`,
    },
    general: {
      siteName: plainField(generalSiteName),
      siteDescription: plainField(generalSiteDescription),
    },
  };

  return { merged, admin };
}

let cached: { merged: MergedSettings; admin: SettingsAdmin } | null = null;
let inflight: Promise<{ merged: MergedSettings; admin: SettingsAdmin }> | null = null;

async function ensureCache(): Promise<{ merged: MergedSettings; admin: SettingsAdmin }> {
  if (cached) return cached;
  inflight ??= computeAll().finally(() => {
    inflight = null;
  });
  cached = await inflight;
  return cached;
}

export async function getSettings(): Promise<MergedSettings> {
  return (await ensureCache()).merged;
}

export async function getSettingsForAdmin(): Promise<SettingsAdmin> {
  return (await ensureCache()).admin;
}

export function invalidateSettingsCache(): void {
  cached = null;
}

type SettingsListener = (settings: MergedSettings) => void | Promise<void>;
const listeners = new Set<SettingsListener>();

/** `getSettings()` natijasi o'zgarganda (saqlashdan keyin) chaqiriladi — masalan bot qayta yaratish, R2 klient keshini tozalash uchun. */
export function onSettingsChange(cb: SettingsListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

async function notifyListeners(settings: MergedSettings): Promise<void> {
  for (const cb of listeners) {
    try {
      await cb(settings);
    } catch (error) {
      console.error("onSettingsChange listener xatosi:", error);
    }
  }
}

// ---------------------------------------------------------------------------
// Saqlash (PUT) — faqat DB-backed maydonlar; env'dan qulflangan maydonga urinish rad etiladi.
// Maskalangan (o'zgarmagan) qiymat — "••••..." bilan boshlansa yoki maydon patch'da umuman
// bo'lmasa — saqlanган sirni O'ZGARTIRMAYDI ("keep" semantikasi).
// ---------------------------------------------------------------------------

export class SettingsValidationError extends Error {
  fields: Record<string, string>;
  constructor(fields: Record<string, string>) {
    super("Sozlamalarda xatolik topildi");
    this.name = "SettingsValidationError";
    this.fields = fields;
  }
}

type SecretAction = "keep" | "clear" | "set";

function secretAction(value: string | undefined): SecretAction {
  if (value === undefined) return "keep";
  if (value.startsWith(SECRET_KEEP_PREFIX)) return "keep";
  if (value === "") return "clear";
  return "set";
}

const CHANNEL_ID_RE = /^(@[A-Za-z][A-Za-z0-9_]{3,31}|-100\d{6,})$/;
const NUMERIC_LIST_RE = /^\d+$/;

function validateAdminUserIds(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(",").map((s) => s.trim());
  if (parts.some((p) => !NUMERIC_LIST_RE.test(p))) {
    return "Faqat raqamlar, vergul bilan ajratilgan (masalan: 12345,67890)";
  }
  return null;
}

function validateChannelId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!CHANNEL_ID_RE.test(trimmed)) {
    return "@kanalnomi (kamida 4 belgi) yoki -100... ko'rinishida bo'lishi kerak";
  }
  return null;
}

function validateUrlField(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    new URL(trimmed);
    return null;
  } catch {
    return "Noto'g'ri URL manzil";
  }
}

function normalizeForCompare(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(",");
  return value === null || value === undefined ? "" : String(value).trim();
}

/**
 * Env'dan qulflangan maydonni DB'ga yozishga yo'l qo'ymaydi. UI bo'limni butunligicha
 * yuboradi — shu sabab qulflangan maydonning O'ZGARMAGAN qiymati (yoki maska) kelsa,
 * u jimgina e'tiborsiz qoldiriladi (xato emas). Faqat haqiqatan boshqa qiymat
 * yuborilganda xato qaytadi.
 */
function assertNotEnvLocked(
  section: string,
  field: string,
  admin: SettingsAdmin,
  errors: Record<string, string>,
  incoming?: unknown,
): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic section lookup
  const current = (admin as any)[section]?.[field] as { source: SettingSource; envVar: string | null; value?: unknown } | undefined;
  if (current?.source === "env") {
    if (incoming !== undefined && normalizeForCompare(incoming) === normalizeForCompare(current.value)) {
      return false; // o'zgarmagan — yozilmaydi, xato ham emas
    }
    errors[`${section}.${field}`] = `env'dan qulflangan (${current.envVar}) — admin panelda o'zgartirib bo'lmaydi`;
    return false;
  }
  return true;
}

export async function saveSettings(patch: SettingsPatch): Promise<void> {
  const { admin } = await ensureCache();
  const errors: Record<string, string> = {};
  const raw = await loadRawMap();

  // ---- telegram ----
  if (patch.telegram) {
    const p: TelegramSettingsPatch = patch.telegram;
    const next: TelegramRaw = { ...raw.telegram };
    if (p.botToken !== undefined && assertNotEnvLocked("telegram", "botToken", admin, errors, p.botToken)) {
      const action = secretAction(p.botToken);
      if (action === "set") next.botToken = encryptSecret(p.botToken!);
      else if (action === "clear") next.botToken = "";
    }
    if (p.webhookSecret !== undefined && assertNotEnvLocked("telegram", "webhookSecret", admin, errors, p.webhookSecret)) {
      const action = secretAction(p.webhookSecret);
      if (action === "set") {
        if (p.webhookSecret!.length < MIN_WEBHOOK_SECRET_LENGTH) {
          errors["telegram.webhookSecret"] = `Kamida ${MIN_WEBHOOK_SECRET_LENGTH} belgi bo'lishi kerak`;
        } else {
          next.webhookSecret = encryptSecret(p.webhookSecret!);
        }
      } else if (action === "clear") next.webhookSecret = "";
    }
    if (p.adminChatId !== undefined && assertNotEnvLocked("telegram", "adminChatId", admin, errors, p.adminChatId)) {
      next.adminChatId = p.adminChatId;
    }
    if (p.adminUserIds !== undefined && assertNotEnvLocked("telegram", "adminUserIds", admin, errors, p.adminUserIds)) {
      const err = validateAdminUserIds(p.adminUserIds);
      if (err) errors["telegram.adminUserIds"] = err;
      else next.adminUserIds = p.adminUserIds;
    }
    if (p.channelId !== undefined && assertNotEnvLocked("telegram", "channelId", admin, errors, p.channelId)) {
      const err = validateChannelId(p.channelId);
      if (err) errors["telegram.channelId"] = err;
      else next.channelId = p.channelId;
    }
    if (p.apiRoot !== undefined && assertNotEnvLocked("telegram", "apiRoot", admin, errors, p.apiRoot)) {
      const err = validateUrlField(p.apiRoot);
      if (err) errors["telegram.apiRoot"] = err;
      else next.apiRoot = p.apiRoot;
    }
    if (Object.keys(errors).filter((k) => k.startsWith("telegram.")).length === 0) {
      await upsertSiteSetting(KEY_TELEGRAM, next);
    }
    if (p.notifyComments !== undefined || p.digestEnabled !== undefined) {
      const legacy = await loadSiteSettings();
      await upsertSiteSetting(TELEGRAM_KEY, {
        ...legacy.telegram,
        ...(p.notifyComments !== undefined ? { notifyComments: p.notifyComments } : {}),
        ...(p.digestEnabled !== undefined ? { digestEnabled: p.digestEnabled } : {}),
      });
    }
  }

  // ---- telegraph ----
  if (patch.telegraph) {
    const p: TelegraphSettingsPatch = patch.telegraph;
    const next: TelegraphRaw = { ...raw.telegraph };
    if (p.enabled !== undefined && assertNotEnvLocked("telegraph", "enabled", admin, errors, p.enabled)) {
      next.enabled = p.enabled;
    }
    await upsertSiteSetting(KEY_TELEGRAPH, next);
    if (p.accessToken !== undefined && assertNotEnvLocked("telegraph", "accessToken", admin, errors, p.accessToken)) {
      const action = secretAction(p.accessToken);
      if (action === "set") await storeTelegraphToken(p.accessToken!);
      else if (action === "clear") await storeTelegraphToken("");
    }
  }

  // ---- turnstile ----
  if (patch.turnstile) {
    const p: TurnstileSettingsPatch = patch.turnstile;
    const next: TurnstileRaw = { ...raw.turnstile };
    if (p.siteKey !== undefined && assertNotEnvLocked("turnstile", "siteKey", admin, errors, p.siteKey)) {
      next.siteKey = p.siteKey;
    }
    if (p.secretKey !== undefined && assertNotEnvLocked("turnstile", "secretKey", admin, errors, p.secretKey)) {
      const action = secretAction(p.secretKey);
      if (action === "set") next.secretKey = encryptSecret(p.secretKey!);
      else if (action === "clear") next.secretKey = "";
    }
    if (p.required !== undefined && assertNotEnvLocked("turnstile", "required", admin, errors, p.required)) {
      next.required = p.required;
    }
    if (Object.keys(errors).filter((k) => k.startsWith("turnstile.")).length === 0) {
      await upsertSiteSetting(KEY_TURNSTILE, next);
    }
  }

  // ---- r2 ----
  if (patch.r2) {
    const p: R2SettingsPatch = patch.r2;
    const next: R2Raw = { ...raw.r2 };
    if (p.accountId !== undefined && assertNotEnvLocked("r2", "accountId", admin, errors, p.accountId)) next.accountId = p.accountId;
    if (p.accessKeyId !== undefined && assertNotEnvLocked("r2", "accessKeyId", admin, errors, p.accessKeyId)) next.accessKeyId = p.accessKeyId;
    if (p.secretAccessKey !== undefined && assertNotEnvLocked("r2", "secretAccessKey", admin, errors, p.secretAccessKey)) {
      const action = secretAction(p.secretAccessKey);
      if (action === "set") next.secretAccessKey = encryptSecret(p.secretAccessKey!);
      else if (action === "clear") next.secretAccessKey = "";
    }
    if (p.bucket !== undefined && assertNotEnvLocked("r2", "bucket", admin, errors, p.bucket)) next.bucket = p.bucket;
    if (p.publicUrl !== undefined && assertNotEnvLocked("r2", "publicUrl", admin, errors, p.publicUrl)) {
      const err = validateUrlField(p.publicUrl);
      if (err) errors["r2.publicUrl"] = err;
      else next.publicUrl = p.publicUrl;
    }
    if (Object.keys(errors).filter((k) => k.startsWith("r2.")).length === 0) {
      await upsertSiteSetting(KEY_R2, next);
    }
  }

  // ---- umami ----
  if (patch.umami) {
    const p: UmamiSettingsPatch = patch.umami;
    const next: UmamiRaw = { ...raw.umami };
    if (p.apiUrl !== undefined && assertNotEnvLocked("umami", "apiUrl", admin, errors, p.apiUrl)) {
      const err = validateUrlField(p.apiUrl);
      if (err) errors["umami.apiUrl"] = err;
      else next.apiUrl = p.apiUrl;
    }
    if (p.websiteId !== undefined && assertNotEnvLocked("umami", "websiteId", admin, errors, p.websiteId)) next.websiteId = p.websiteId;
    if (p.scriptUrl !== undefined && assertNotEnvLocked("umami", "scriptUrl", admin, errors, p.scriptUrl)) {
      const err = validateUrlField(p.scriptUrl);
      if (err) errors["umami.scriptUrl"] = err;
      else next.scriptUrl = p.scriptUrl;
    }
    if (p.apiKey !== undefined && assertNotEnvLocked("umami", "apiKey", admin, errors, p.apiKey)) {
      const action = secretAction(p.apiKey);
      if (action === "set") next.apiKey = encryptSecret(p.apiKey!);
      else if (action === "clear") next.apiKey = "";
    }
    if (p.username !== undefined && assertNotEnvLocked("umami", "username", admin, errors, p.username)) next.username = p.username;
    if (p.password !== undefined && assertNotEnvLocked("umami", "password", admin, errors, p.password)) {
      const action = secretAction(p.password);
      if (action === "set") next.password = encryptSecret(p.password!);
      else if (action === "clear") next.password = "";
    }
    if (Object.keys(errors).filter((k) => k.startsWith("umami.")).length === 0) {
      await upsertSiteSetting(KEY_UMAMI, next);
    }
  }

  // ---- github ----
  if (patch.github) {
    const p: GithubSettingsPatch = patch.github;
    const next: GithubRaw = { ...raw.github };
    if (p.clientId !== undefined && assertNotEnvLocked("github", "clientId", admin, errors, p.clientId)) next.clientId = p.clientId;
    if (p.clientSecret !== undefined && assertNotEnvLocked("github", "clientSecret", admin, errors, p.clientSecret)) {
      const action = secretAction(p.clientSecret);
      if (action === "set") next.clientSecret = encryptSecret(p.clientSecret!);
      else if (action === "clear") next.clientSecret = "";
    }
    if (p.loginEnabled !== undefined && assertNotEnvLocked("github", "loginEnabled", admin, errors, p.loginEnabled)) {
      next.loginEnabled = p.loginEnabled;
    }
    if (Object.keys(errors).filter((k) => k.startsWith("github.")).length === 0) {
      await upsertSiteSetting(KEY_GITHUB, next);
    }
  }

  // ---- general ----
  if (patch.general) {
    const p: GeneralSettingsPatch = patch.general;
    const next: GeneralRaw = { ...raw.general };
    if (p.siteName !== undefined && assertNotEnvLocked("general", "siteName", admin, errors, p.siteName)) next.siteName = p.siteName;
    if (p.siteDescription !== undefined && assertNotEnvLocked("general", "siteDescription", admin, errors, p.siteDescription)) {
      next.siteDescription = p.siteDescription;
    }
    if (Object.keys(errors).filter((k) => k.startsWith("general.")).length === 0) {
      await upsertSiteSetting(KEY_GENERAL, next);
    }
  }

  if (Object.keys(errors).length > 0) {
    throw new SettingsValidationError(errors);
  }

  invalidateSettingsCache();
  const fresh = await ensureCache();
  await notifyListeners(fresh.merged);
}

/** `POST /admin/settings/generate-secret` — webhook secret uchun qulay tasodifiy 32 ta hex belgi. */
export function generateRandomSecret(): string {
  return randomBytes(16).toString("hex");
}

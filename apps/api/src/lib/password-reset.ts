import { AsyncLocalStorage } from "node:async_hooks";
import { and, count, eq, gt, like, ne, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { auditLog } from "../db/schema.js";
import { verification } from "../db/auth-schema.js";
import { bot } from "../telegram/client.js";
import { escapeHtml } from "../telegram/format.js";
import { recordAuditSafe } from "./audit.js";
import { AUTH_CLIENT_IP_HEADER } from "./auth-options.js";
import { getSettings } from "./settings.js";

/**
 * Parolni tiklash (Better Auth'ning O'Z mexanizmi ustida): token yaratish, saqlash (`verification` jadvali),
 * muddat va bir martalik ishlatish — hammasi kutubxonada. Bu modul faqat ikki narsani qo'shadi:
 * `emailAndPassword.sendResetPassword` (havolani Telegram'ga yuborish yoki admin uchun ushlab qolish) va
 * `emailAndPassword.onPasswordReset` (audit + qolgan havolalarni bekor qilish).
 */

/** Veb-ilovadagi tiklash sahifasi (token `?token=` bilan keladi va manzil satridan darhol olib tashlanadi). */
export const RESET_PAGE_PATH = "/parolni-tiklash";

/** Better Auth `verification.identifier` formati: `reset-password:<token>` (kutubxona manbasidan: api/routes/password). */
const RESET_IDENTIFIER_PREFIX = "reset-password:";

export const PASSWORD_RESET_REQUEST_ACTION = "auth.password_reset_request";
export const PASSWORD_RESET_COMPLETE_ACTION = "auth.password_reset_complete";

export const PASSWORD_RESET_TTL_SECONDS = config.PASSWORD_RESET_TTL_MINUTES * 60;

export function webResetPageUrl(): string {
  return `${config.WEB_ORIGIN}${RESET_PAGE_PATH}`;
}

/**
 * Foydalanuvchiga beriladigan havola: Better Auth'ning GET `/reset-password/:token` endpoint'i tokenni tekshiradi
 * (yaroqsiz/muddati o'tgan bo'lsa `?error=INVALID_TOKEN`), yaroqli bo'lsa veb sahifaga `?token=` bilan yo'naltiradi.
 * `callbackURL` HAR DOIM biz belgilagan sahifa — mijoz yuborgan `redirectTo` ishlatilmaydi.
 */
export function buildResetLink(token: string): string {
  const base = `${config.API_ORIGIN.replace(/\/+$/, "")}/api/auth/reset-password/${encodeURIComponent(token)}`;
  return `${base}?callbackURL=${encodeURIComponent(webResetPageUrl())}`;
}

// ---------------------------------------------------------------------------
// Token ushlash (admin xodim uchun havola yaratganda Telegram'ga YUBORILMAYDI)
// ---------------------------------------------------------------------------

const captureStore = new AsyncLocalStorage<{ token?: string }>();

/** `fn` ichida Better Auth tokenni yaratsa — Telegram'ga yuborish o'rniga shu yerga qaytariladi. */
export async function captureResetToken(fn: () => Promise<unknown>): Promise<string | null> {
  const store: { token?: string } = {};
  await captureStore.run(store, fn);
  return store.token ?? null;
}

export async function resetTokenExpiry(token: string): Promise<Date | null> {
  const [row] = await db
    .select({ expiresAt: verification.expiresAt })
    .from(verification)
    .where(eq(verification.identifier, `${RESET_IDENTIFIER_PREFIX}${token}`))
    .limit(1);
  return row?.expiresAt ?? null;
}

async function deleteResetToken(token: string): Promise<void> {
  await db.delete(verification).where(eq(verification.identifier, `${RESET_IDENTIFIER_PREFIX}${token}`));
}

/** Foydalanuvchining barcha (yaroqli yoki yo'q) tiklash tokenlarini o'chiradi. */
export async function revokeAllResetTokens(userId: string): Promise<void> {
  await db
    .delete(verification)
    .where(and(eq(verification.value, userId), like(verification.identifier, `${RESET_IDENTIFIER_PREFIX}%`)));
}

// ---------------------------------------------------------------------------
// Telegram orqali yuborish (faqat admin, faqat shaxsiy chat)
// ---------------------------------------------------------------------------

type Outcome =
  | "delivered"
  | "not_admin"
  | "telegram_not_configured"
  | "coalesced"
  | "hourly_limit"
  | "chat_not_private"
  | "send_failed";

interface ResetUser {
  id: string;
  email: string;
  role?: string | null;
}

const pending = new Set<Promise<void>>();

/** Faqat testlar uchun: fon rejimida ishlayotgan barcha tiklash so'rovlari tugashini kutadi. */
export async function whenPasswordResetIdle(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

const locks = new Map<string, Promise<void>>();

/** Bir hisob uchun so'rovlarni ketma-ket bajaradi — ikki parallel so'rov ikki xabar yubormasin (bitta jarayon). */
async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => mine);
  locks.set(userId, chain);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(userId) === chain) locks.delete(userId);
  }
}

function formatTashkent(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tashkent",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}.${get("month")}.${get("year")} ${get("hour")}:${get("minute")}`;
}

/** Telegram xabari (HTML). Token faqat havola ichida — boshqa joyga yozilmaydi. */
export function buildResetMessage(input: { link: string; requestedAt: Date; ip: string; ttlMinutes: number; email: string }): string {
  return [
    "🔐 <b>Parolni tiklash so'rovi</b>",
    "",
    `Hisob: ${escapeHtml(input.email)}`,
    `Vaqt: ${formatTashkent(input.requestedAt)} (Toshkent)`,
    `IP manzil: ${escapeHtml(input.ip)}`,
    `Havola ${input.ttlMinutes} daqiqa amal qiladi va faqat bir marta ishlaydi.`,
    "",
    escapeHtml(input.link),
    "",
    "Agar bu siz bo'lmasangiz — havolani bosmang va e'tibor bermang.",
  ].join("\n");
}

async function hourlyDeliveredCount(userId: string): Promise<number> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const [row] = await db
    .select({ n: count() })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, PASSWORD_RESET_REQUEST_ACTION),
        eq(auditLog.entityId, userId),
        sql`${auditLog.meta}->>'outcome' = 'delivered'`,
        gt(auditLog.createdAt, since),
      ),
    );
  return row?.n ?? 0;
}

const recentSends = new Map<string, number[]>();

function recentSendCount(userId: string): number {
  const cutoff = Date.now() - 3_600_000;
  const fresh = (recentSends.get(userId) ?? []).filter((at) => at > cutoff);
  if (fresh.length === 0) recentSends.delete(userId);
  else recentSends.set(userId, fresh);
  return fresh.length;
}

async function hasOtherValidToken(userId: string, token: string): Promise<boolean> {
  const [row] = await db
    .select({ n: count() })
    .from(verification)
    .where(
      and(
        eq(verification.value, userId),
        like(verification.identifier, `${RESET_IDENTIFIER_PREFIX}%`),
        ne(verification.identifier, `${RESET_IDENTIFIER_PREFIX}${token}`),
        gt(verification.expiresAt, new Date()),
      ),
    );
  return (row?.n ?? 0) > 0;
}

async function deliver(user: ResetUser, token: string, requestedAt: Date, ip: string): Promise<Outcome> {
  if (user.role !== "admin") return "not_admin";

  const settings = await getSettings();
  const chatId = settings.telegram.adminChatId;
  if (!bot || !settings.telegram.enabled || !chatId) return "telegram_not_configured";

  // Hali yaroqli havola bor — yangi xabar yuborilmaydi (egasining chatini to'ldirmaslik uchun).
  if (await hasOtherValidToken(user.id, token)) return "coalesced";

  // Soatlik chegara: jurnaldagi (qayta ishga tushishdan omon qoladi) va xotiradagi hisobning kattasi.
  const sentLastHour = Math.max(await hourlyDeliveredCount(user.id), recentSendCount(user.id));
  if (sentLastHour >= config.PASSWORD_RESET_MAX_PER_HOUR) return "hourly_limit";

  // Havola FAQAT shaxsiy chatga yuboriladi: guruh/kanalga tushsa a'zolar hammasi uni ko'ra oladi.
  try {
    const chat = await bot.api.getChat(chatId);
    if (chat.type !== "private") {
      console.warn(
        `Parolni tiklash: TELEGRAM_ADMIN_CHAT_ID shaxsiy chat emas (type=${chat.type}) — tiklash havolasi YUBORILMADI. ` +
          "Admin chatni botning shaxsiy (DM) chatiga o'zgartiring.",
      );
      return "chat_not_private";
    }
  } catch (error: unknown) {
    console.warn("Parolni tiklash: admin chat turini aniqlab bo'lmadi — havola yuborilmadi:", error instanceof Error ? error.message : "noma'lum xato");
    return "chat_not_private";
  }

  try {
    await bot.api.sendMessage(
      chatId,
      buildResetMessage({
        link: buildResetLink(token),
        requestedAt,
        ip,
        ttlMinutes: config.PASSWORD_RESET_TTL_MINUTES,
        email: user.email,
      }),
      { parse_mode: "HTML", link_preview_options: { is_disabled: true }, protect_content: true },
    );
    recentSends.set(user.id, [...(recentSends.get(user.id) ?? []), Date.now()]);
    return "delivered";
  } catch (error: unknown) {
    // Xato matni tokenni o'z ichiga olishi mumkin emas (so'rov tanasi log qilinmaydi), lekin baribir faqat xabar yoziladi.
    console.error("Parolni tiklash: Telegram'ga yuborib bo'lmadi:", error instanceof Error ? error.message : "noma'lum xato");
    return "send_failed";
  }
}

async function handleResetRequest(user: ResetUser, token: string, ip: string): Promise<void> {
  const requestedAt = new Date();
  await withUserLock(user.id, async () => {
    let outcome: Outcome;
    try {
      outcome = await deliver(user, token, requestedAt, ip);
    } catch (error: unknown) {
      console.error("Parolni tiklash: so'rovni qayta ishlab bo'lmadi:", error instanceof Error ? error.message : "noma'lum xato");
      outcome = "send_failed";
    }

    // Yuborilmagan havola hech kimga ma'lum emas — yaroqli qolib ketmasin (keyingi so'rov yubora olishi uchun ham).
    if (outcome !== "delivered") {
      try {
        await deleteResetToken(token);
      } catch (error: unknown) {
        console.error("Parolni tiklash: ishlatilmagan tokenni o'chirib bo'lmadi:", error instanceof Error ? error.message : "noma'lum xato");
      }
    }

    await recordAuditSafe(
      { userId: null, role: "system", via: "web" },
      {
        action: PASSWORD_RESET_REQUEST_ACTION,
        entityType: "user",
        entityId: user.id,
        summary: "Parolni tiklash so'ralindi",
        meta: { ip, outcome },
      },
    );
  });
}

/**
 * `emailAndPassword.sendResetPassword`. Better Auth buni mavjud foydalanuvchi uchun chaqiradi (token allaqachon
 * saqlangan); javob vaqti Telegram'ga bog'liq bo'lmasligi uchun bu yerda faqat ishni fon rejimiga topshiramiz.
 */
export async function sendPasswordResetLink(
  data: { user: ResetUser; url: string; token: string },
  request?: Request,
): Promise<void> {
  const capture = captureStore.getStore();
  if (capture) {
    capture.token = data.token;
    return;
  }

  const ip = request?.headers.get(AUTH_CLIENT_IP_HEADER) ?? "unknown";
  const task: Promise<void> = handleResetRequest(data.user, data.token, ip)
    .catch((error: unknown) => {
      console.error("Parolni tiklash: kutilmagan xato:", error instanceof Error ? error.message : "noma'lum xato");
    })
    .finally(() => {
      pending.delete(task);
    });
  pending.add(task);
}

/** `emailAndPassword.onPasswordReset`: bu hisobning qolgan tiklash havolalari bekor qilinadi va yozuv jurnalga tushadi. */
export async function onPasswordResetCompleted(data: { user: { id: string; role?: string | null } }, request?: Request): Promise<void> {
  try {
    await revokeAllResetTokens(data.user.id);
  } catch (error: unknown) {
    console.error("Parolni tiklash: qolgan havolalarni bekor qilib bo'lmadi:", error instanceof Error ? error.message : "noma'lum xato");
  }
  const role = data.user.role === "admin" || data.user.role === "staff" ? data.user.role : "user";
  await recordAuditSafe(
    { userId: data.user.id, role, via: "web" },
    {
      action: PASSWORD_RESET_COMPLETE_ACTION,
      entityType: "user",
      entityId: data.user.id,
      summary: "Parol tiklash havolasi orqali yangilandi",
      meta: { ip: request?.headers.get(AUTH_CLIENT_IP_HEADER) ?? "unknown" },
    },
  );
}

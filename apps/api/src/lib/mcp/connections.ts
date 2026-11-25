import { and, desc, eq, inArray, isNull, lt, notExists, or, sql } from "drizzle-orm";
import type { Executor } from "../executor.js";
import type { McpConnection, McpConsentInfo } from "@blog/shared";
import { MCP_OFFLINE_SCOPE, MCP_SCOPE_IDS, parseScopeString, type McpRedirectKind } from "@blog/shared";
import { db } from "../../db/index.js";
import { oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } from "../../db/auth-schema.js";
import { auditLog } from "../../db/schema.js";
import { verification } from "../../db/auth-schema.js";
import { recordAudit } from "../audit.js";
import type { Actor } from "../posts/types.js";
import { ALL_OAUTH_SCOPES, clampNow } from "./scopes.js";

function hostOf(uri: string | undefined): string | null {
  if (!uri) return null;
  try {
    return new URL(uri).host;
  } catch {
    return null;
  }
}

/** Foydalanuvchining ulangan ilovalari (rozilik qatori bor klientlar) — "Ulangan ilovalar" sahifasi uchun. */
export async function listConnections(userId: string): Promise<McpConnection[]> {
  const rows = await db
    .select({
      clientId: oauthConsent.clientId,
      scopes: oauthConsent.scopes,
      connectedAt: oauthConsent.createdAt,
      name: oauthClient.name,
      redirectUris: oauthClient.redirectUris,
    })
    .from(oauthConsent)
    .leftJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .where(eq(oauthConsent.userId, userId))
    .orderBy(desc(oauthConsent.createdAt));
  if (rows.length === 0) return [];

  const clientIds = rows.map((row) => row.clientId);

  // So'nggi faollik: (a) jurnaldagi `mcp.read`/vosita yozuvlari (`meta.lastAt` yoki `createdAt`), (b) oxirgi token chiqarilishi (refresh).
  const [auditRows, tokenRows] = await Promise.all([
    db
      .select({
        clientId: auditLog.entityId,
        last: sql<Date>`max(coalesce((${auditLog.meta}->>'lastAt')::timestamptz, ${auditLog.createdAt}))`,
      })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "mcp"), eq(auditLog.via, "mcp"), inArray(auditLog.entityId, clientIds)))
      .groupBy(auditLog.entityId),
    db
      .select({ clientId: oauthRefreshToken.clientId, last: sql<Date>`max(${oauthRefreshToken.createdAt})` })
      .from(oauthRefreshToken)
      .where(and(eq(oauthRefreshToken.userId, userId), inArray(oauthRefreshToken.clientId, clientIds)))
      .groupBy(oauthRefreshToken.clientId),
  ]);

  const lastUsed = new Map<string, number>();
  for (const row of [...auditRows, ...tokenRows]) {
    if (!row.clientId || !row.last) continue;
    const time = new Date(row.last).getTime();
    if (!Number.isNaN(time) && time > (lastUsed.get(row.clientId) ?? 0)) lastUsed.set(row.clientId, time);
  }

  return rows.map((row) => ({
    clientId: row.clientId,
    name: row.name,
    redirectHost: hostOf(row.redirectUris?.[0]),
    // Saqlangan (berilgan) barcha ma'lum ruxsatlar ko'rsatiladi — yozuv kaliti o'chiq bo'lsa ham (ular faol emas, lekin yashirilmaydi).
    scopes: row.scopes.filter((scope) => MCP_SCOPE_IDS.includes(scope) || scope === MCP_OFFLINE_SCOPE),
    connectedAt: row.connectedAt.toISOString(),
    lastUsedAt: lastUsed.has(row.clientId) ? new Date(lastUsed.get(row.clientId)!).toISOString() : null,
  }));
}

/**
 * Ulanishni TO'LIQ bekor qiladi: (1) shu foydalanuvchi + klient uchun barcha refresh token qatorlari (ularga bog'liq
 * access token qatorlari cascade bilan), (2) qolgan access token qatorlari, (3) rozilik qatori. Stock `delete-consent`
 * refresh token'ni tirik qoldiradi; JWT access token holatsiz — shu sabab `/mcp` har so'rovda rozilik qatorini tekshiradi
 * (`principal.ts`), ya'ni 3-qadamdan keyin access token ham DARHOL ishlamay qoladi. Klient qatori saqlanadi
 * (`metadata.revokedAt`), shunda klient qayta ulanganda "client not found" bo'lmaydi.
 */
export async function revokeConnection(actor: Actor, userId: string, clientId: string): Promise<{ revoked: boolean }> {
  return db.transaction(async (tx) => {
    const [consent] = await tx
      .select({ id: oauthConsent.id })
      .from(oauthConsent)
      .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)))
      .limit(1);
    if (!consent) return { revoked: false };

    const [client] = await tx.select({ name: oauthClient.name, metadata: oauthClient.metadata }).from(oauthClient).where(eq(oauthClient.clientId, clientId)).limit(1);

    await tx.delete(oauthRefreshToken).where(and(eq(oauthRefreshToken.userId, userId), eq(oauthRefreshToken.clientId, clientId)));
    await tx.delete(oauthAccessToken).where(and(eq(oauthAccessToken.userId, userId), eq(oauthAccessToken.clientId, clientId)));
    await tx.delete(oauthConsent).where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)));
    await invalidateAuthorizationCodes(tx, [clientId]);
    await tx
      .update(oauthClient)
      .set({ metadata: { ...((client?.metadata as Record<string, unknown> | null) ?? {}), revokedAt: new Date().toISOString() } })
      .where(eq(oauthClient.clientId, clientId));

    await recordAudit(tx, actor, {
      action: "mcp.revoke",
      entityType: "mcp",
      entityId: clientId,
      summary: `Ulangan ilova uzildi: ${client?.name ?? clientId}`,
      meta: { clientId, clientName: client?.name ?? null },
    });
    return { revoked: true };
  });
}

/**
 * Hali almashtirilmagan authorization code'larni yaroqsiz qiladi (Better Auth ularni `verification` jadvalida saqlaydi,
 * qiymatda `"type":"authorization_code"` va `client_id`). Aks holda bekor qilishdan OLDIN berilgan kod keyin token olib berardi.
 */
export async function invalidateAuthorizationCodes(executor: Executor, clientIds: string[]): Promise<void> {
  for (const clientId of clientIds) {
    await executor
      .delete(verification)
      .where(and(sql`${verification.value} like '%"type":"authorization_code"%'`, sql`${verification.value} like ${`%"client_id":"${clientId.replace(/[%_\\"]/g, "")}"%`}`));
  }
}

/**
 * HAMMASINI uzish: foydalanuvchining barcha ulanishlari (refresh/access token qatorlari, rozilik qatorlari, kutilayotgan kodlar).
 * Bitta tranzaksiya, bitta jurnal yozuvi (`mcp.revoke_all`).
 */
export async function revokeAllConnections(actor: Actor, userId: string): Promise<{ revoked: number }> {
  return db.transaction(async (tx) => {
    const consents = await tx.select({ clientId: oauthConsent.clientId }).from(oauthConsent).where(eq(oauthConsent.userId, userId));
    const clientIds = [...new Set(consents.map((row) => row.clientId))];
    await tx.delete(oauthRefreshToken).where(eq(oauthRefreshToken.userId, userId));
    await tx.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, userId));
    await tx.delete(oauthConsent).where(eq(oauthConsent.userId, userId));
    if (clientIds.length > 0) {
      await invalidateAuthorizationCodes(tx, clientIds);
      await tx
        .update(oauthClient)
        .set({ metadata: sql`coalesce(${oauthClient.metadata}, '{}'::jsonb) || ${JSON.stringify({ revokedAt: new Date().toISOString() })}::jsonb` })
        .where(inArray(oauthClient.clientId, clientIds));
    }
    if (clientIds.length === 0 && actor.via !== "web") return { revoked: 0 };
    await recordAudit(tx, actor, {
      action: "mcp.revoke_all",
      entityType: "mcp",
      summary: `Barcha ulangan ilovalar uzildi (${clientIds.length} ta)`,
      meta: { count: clientIds.length, trigger: actor.via === "web" ? "manual" : "credentials" },
    });
    return { revoked: clientIds.length };
  });
}

/**
 * Rozilik olmagan klientlar soni `max`dan oshsa, eng eskilarini o'chiradi (anonim ro'yxatdan o'tish jadvalni cheksiz
 * o'stira olmasin; yangi ro'yxatdan o'tish hech qachon rad etilmaydi). Bekor qilingan klientlarga tegilmaydi.
 */
export async function trimUnconsentedClients(max: number): Promise<number> {
  const unconsented = and(
    notExists(db.select({ one: sql`1` }).from(oauthConsent).where(eq(oauthConsent.clientId, oauthClient.clientId))),
    isNull(sql`${oauthClient.metadata}->>'revokedAt'`),
  );
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(oauthClient).where(unconsented);
  const excess = (row?.count ?? 0) - Math.max(0, max);
  if (excess <= 0) return 0;
  const oldest = await db.select({ id: oauthClient.id }).from(oauthClient).where(unconsented).orderBy(oauthClient.createdAt).limit(excess);
  if (oldest.length === 0) return 0;
  await db.delete(oauthClient).where(inArray(oauthClient.id, oldest.map((r) => r.id)));
  return oldest.length;
}

function redirectKindOf(uri: string | undefined): McpRedirectKind {
  if (!uri) return "other";
  try {
    const url = new URL(uri);
    if (url.protocol === "https:" && url.host === "claude.ai") return "claude";
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return "loopback";
  } catch {
    // quyida "other"
  }
  return "other";
}

/** Rozilik sahifasi uchun klient ma'lumoti (tasdiqlangan `oauth_query`dan olingan client_id/scope bilan). */
export async function buildConsentInfo(input: {
  user: { name: string | null; email: string; role: string };
  clientId: string | null;
  scope: string | null;
}): Promise<McpConsentInfo> {
  const base = { user: input.user, scopes: clampNow(parseScopeString(input.scope)) };
  if (!input.clientId) return { ...base, allowed: false, reason: "unknown_client", client: null };

  const [client] = await db
    .select({ name: oauthClient.name, redirectUris: oauthClient.redirectUris, disabled: oauthClient.disabled, createdAt: oauthClient.createdAt })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, input.clientId))
    .limit(1);

  const clientInfo = {
    id: input.clientId,
    name: client?.name ?? null,
    redirectHost: hostOf(client?.redirectUris?.[0]),
    redirectKind: redirectKindOf(client?.redirectUris?.[0]),
    registeredAt: client?.createdAt ? client.createdAt.toISOString() : null,
  };
  if (input.user.role !== "admin") return { ...base, allowed: false, reason: "not_admin", client: clientInfo };
  if (!client || client.disabled) return { ...base, allowed: false, reason: "unknown_client", client: clientInfo };
  return { ...base, allowed: true, reason: null, client: clientInfo };
}

/**
 * Davriy tozalash: (1) hech qachon rozilik olmagan va `MCP_UNUSED_CLIENT_TTL_HOURS`dan eski ro'yxatdan o'tgan klientlar
 * (autentifikatsiyasiz DCR qoldiqlari; bekor qilingan klientlar 30 kun saqlanadi), (2) 7 kundan oldin muddati
 * tugagan refresh token'lar (access token qatorlari cascade).
 */
export async function cleanupMcpData(ttlHours: number, now: Date = new Date()): Promise<{ clients: number; refreshTokens: number }> {
  const clientCutoff = new Date(now.getTime() - ttlHours * 3600 * 1000);
  const revokedCutoff = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();

  const deletedClients = await db
    .delete(oauthClient)
    .where(
      and(
        lt(sql`coalesce(${oauthClient.createdAt}, ${clientCutoff.toISOString()}::timestamptz - interval '1 second')`, clientCutoff),
        notExists(db.select({ one: sql`1` }).from(oauthConsent).where(eq(oauthConsent.clientId, oauthClient.clientId))),
        or(isNull(sql`${oauthClient.metadata}->>'revokedAt'`), lt(sql`(${oauthClient.metadata}->>'revokedAt')`, revokedCutoff)),
      ),
    )
    .returning();

  const tokenCutoff = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const deletedTokens = await db.delete(oauthRefreshToken).where(lt(oauthRefreshToken.expiresAt, tokenCutoff)).returning();

  return { clients: deletedClients.length, refreshTokens: deletedTokens.length };
}

/**
 * Klientning ro'yxatdan o'tgan ruxsatlar SHIFTINI kengaytiradi (faqat shift: rozilik o'zgarmaydi). Yozuv kaliti keyin
 * yoqilganda, avval faqat o'qish bilan ro'yxatdan o'tgan klient yozuv ruxsatlarini so'ray olishi uchun (Better Auth
 * so'ralgan ruxsat klientning ro'yxatdagisidan tashqarida bo'lsa `invalid_scope` beradi). Kengaytma faqat HOZIR berilishi
 * mumkin ruxsatlar bilan cheklanadi va foydalanuvchi baribir yangi rozilik berishi shart.
 */
export async function widenClientScopes(clientId: string, requested: readonly string[]): Promise<void> {
  const wanted = requested.filter((scope) => ALL_OAUTH_SCOPES.includes(scope));
  if (wanted.length === 0) return;
  const [client] = await db.select({ id: oauthClient.id, scopes: oauthClient.scopes }).from(oauthClient).where(eq(oauthClient.clientId, clientId)).limit(1);
  if (!client) return;
  const current = client.scopes ?? [];
  const missing = wanted.filter((scope) => !current.includes(scope));
  if (missing.length === 0) return;
  await db
    .update(oauthClient)
    .set({ scopes: [...new Set([...current, ...missing])] })
    .where(eq(oauthClient.id, client.id));
}

/** Rozilik POST'ida klient hali mavjudmi (o'chirilgan/yo'q klient uchun toza `invalid_client`). */
export async function clientExists(clientId: string): Promise<boolean> {
  const [client] = await db.select({ disabled: oauthClient.disabled }).from(oauthClient).where(eq(oauthClient.clientId, clientId)).limit(1);
  return Boolean(client) && !client?.disabled;
}

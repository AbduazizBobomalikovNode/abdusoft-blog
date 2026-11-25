import { and, desc, eq, inArray, isNull, lt, notExists, or, sql } from "drizzle-orm";
import type { McpConnection, McpConsentInfo } from "@blog/shared";
import { MCP_SCOPE_IDS, parseScopeString } from "@blog/shared";
import { db } from "../../db/index.js";
import { oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } from "../../db/auth-schema.js";
import { auditLog } from "../../db/schema.js";
import { recordAudit } from "../audit.js";
import type { Actor } from "../posts/types.js";

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
    scopes: row.scopes.filter((scope) => MCP_SCOPE_IDS.includes(scope) || scope === "offline_access"),
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

/** Rozilik sahifasi uchun klient ma'lumoti (tasdiqlangan `oauth_query`dan olingan client_id/scope bilan). */
export async function buildConsentInfo(input: {
  user: { name: string | null; email: string; role: string };
  clientId: string | null;
  scope: string | null;
}): Promise<McpConsentInfo> {
  const base = { user: input.user, scopes: parseScopeString(input.scope) };
  if (!input.clientId) return { ...base, allowed: false, reason: "unknown_client", client: null };

  const [client] = await db
    .select({ name: oauthClient.name, redirectUris: oauthClient.redirectUris, disabled: oauthClient.disabled })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, input.clientId))
    .limit(1);

  const clientInfo = { id: input.clientId, name: client?.name ?? null, redirectHost: hostOf(client?.redirectUris?.[0]) };
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

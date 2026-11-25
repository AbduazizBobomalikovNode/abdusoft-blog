import { and, eq } from "drizzle-orm";
import type { JWTPayload } from "jose";
import { parseScopeString } from "@blog/shared";
import { db } from "../../db/index.js";
import { oauthClient, oauthConsent, user } from "../../db/auth-schema.js";
import { grantableIdsNow } from "./scopes.js";

export interface McpPrincipal {
  userId: string;
  email: string;
  name: string | null;
  clientId: string;
  clientName: string | null;
  /** Token scope'lari VA rozilik qatoridagi scope'larning kesishmasi (faqat blog ruxsatlari). */
  scopes: Set<string>;
}

export type PrincipalResult =
  | { ok: true; principal: McpPrincipal }
  | { ok: false; status: 401 | 403; reason: "invalid_token" | "consent_revoked" | "forbidden"; message: string };

/**
 * JWT access token holatsiz bo'lgani uchun HAR BIR `/mcp` so'rovida bitta DB o'qish bilan tekshiramiz:
 * foydalanuvchi hali ham `admin`mi (demote qilingan bo'lsa darhol 403), shu klient uchun rozilik qatori bor-yo'qligi
 * (ulanish uzilgan bo'lsa darhol 401) va klient o'chirib qo'yilmaganmi. Ruxsatlar token va rozilikning KESISHMASI.
 */
export async function resolvePrincipal(claims: JWTPayload): Promise<PrincipalResult> {
  const userId = typeof claims.sub === "string" ? claims.sub : "";
  const clientId = typeof claims.azp === "string" ? claims.azp : "";
  if (!userId || !clientId) {
    return { ok: false, status: 401, reason: "invalid_token", message: "token has no subject or client" };
  }

  const [row] = await db
    .select({
      role: user.role,
      email: user.email,
      name: user.name,
      consentScopes: oauthConsent.scopes,
      consentCreatedAt: oauthConsent.createdAt,
      clientName: oauthClient.name,
      clientDisabled: oauthClient.disabled,
    })
    .from(user)
    .leftJoin(oauthConsent, and(eq(oauthConsent.userId, user.id), eq(oauthConsent.clientId, clientId)))
    .leftJoin(oauthClient, eq(oauthClient.clientId, clientId))
    .where(eq(user.id, userId))
    .limit(1);

  if (!row) return { ok: false, status: 401, reason: "invalid_token", message: "user no longer exists" };
  if (row.role !== "admin") return { ok: false, status: 403, reason: "forbidden", message: "forbidden: admin role required" };
  if (!row.consentScopes || row.clientDisabled) {
    return { ok: false, status: 401, reason: "consent_revoked", message: "the connection was revoked" };
  }

  // Token JORIY rozilikdan keyin chiqarilgan bo'lishi shart: bekor qilingan (keyin qayta berilgan) ulanishning eski
  // token'lari qayta tirilmaydi. `iat` soniya aniqligida — 1 soniya bardosh.
  const issuedAtMs = typeof claims.iat === "number" ? claims.iat * 1000 : 0;
  if (issuedAtMs + 1000 < row.consentCreatedAt!.getTime()) {
    return { ok: false, status: 401, reason: "consent_revoked", message: "the token predates the current consent" };
  }

  const tokenScopes = new Set(parseScopeString(typeof claims.scope === "string" ? claims.scope : ""));
  const consented = new Set(row.consentScopes);
  // Uch tomonli kesishma: token VA rozilik VA hozir berilishi mumkin (kalit o'chirilsa yozuv ruxsatlari darhol ishlamay qoladi).
  const scopes = new Set(grantableIdsNow().filter((id) => tokenScopes.has(id) && consented.has(id)));

  return {
    ok: true,
    principal: { userId, email: row.email, name: row.name, clientId, clientName: row.clientName, scopes },
  };
}

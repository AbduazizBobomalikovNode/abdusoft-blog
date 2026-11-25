import { config } from "../config.js";
import { recordAuditSafe } from "./audit.js";
import { auth } from "./auth.js";
import { revokeAllResetTokens } from "./password-reset.js";

export const SERVER_RESET_MIN = 12;
export const SERVER_RESET_MAX = 128;

export type ServerResetResult = { ok: true; userId: string } | { ok: false; reason: "not_found" | "too_short" | "too_long" };

/**
 * Telegram sozlanmagan bo'lsa (yoki bot ishlamasa) parolni SERVERNING o'zida tiklash (`scripts/reset-password.ts`).
 * Better Auth'ning ichki adapterlari orqali: parol xeshlanadi, barcha sessiyalar va ochiq tiklash havolalari bekor
 * qilinadi, Claude konnektori yoqilgan bo'lsa ulanishlar ham uziladi, jurnalga yoziladi (parolsiz).
 */
export async function resetPasswordOnServer(email: string, newPassword: string): Promise<ServerResetResult> {
  if (newPassword.length < SERVER_RESET_MIN) return { ok: false, reason: "too_short" };
  if (newPassword.length > SERVER_RESET_MAX) return { ok: false, reason: "too_long" };

  const ctx = await auth.$context;
  const found = await ctx.internalAdapter.findUserByEmail(email.trim());
  if (!found) return { ok: false, reason: "not_found" };
  const userId = found.user.id;

  const hash = await ctx.password.hash(newPassword);
  if (await ctx.internalAdapter.findCredentialAccount(userId)) {
    await ctx.internalAdapter.updatePassword(userId, hash);
  } else {
    await ctx.internalAdapter.createAccount({ userId, providerId: "credential", accountId: userId, password: hash });
  }
  await ctx.internalAdapter.deleteUserSessions(userId);
  await revokeAllResetTokens(userId);
  if (config.MCP_ENABLED) {
    const { revokeAllConnections } = await import("./mcp/connections.js");
    await revokeAllConnections({ userId: null, role: "system", via: "system" }, userId);
  }

  await recordAuditSafe(
    { userId: null, role: "system", via: "system" },
    {
      action: "auth.password_reset_server",
      entityType: "user",
      entityId: userId,
      summary: "Parol serverda qo'lda tiklandi (skript)",
    },
  );
  return { ok: true, userId };
}

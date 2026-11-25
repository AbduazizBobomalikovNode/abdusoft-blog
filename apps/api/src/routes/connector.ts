import { Hono } from "hono";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { config } from "../config.js";
import { auth } from "../lib/auth.js";
import { buildConsentInfo } from "../lib/mcp/connections.js";

/**
 * Veb `/consent` sahifasi uchun: joriy foydalanuvchi shu ilovaga ruxsat bera oladimi (faqat admin) va ilova/ruxsatlar
 * haqida ma'lumot. `oauth_query` provider imzosi (`sig`) va muddati bo'yicha TEKSHIRILADI — ko'rsatiladigan
 * `client_id`/`scope` faqat imzolangan so'rovdan olinadi, soxta havola boshqa ruxsatlarni ko'rsatib aldab bo'lmaydi.
 * Faqat MCP yoqilganda ulanadi.
 */
export const connectorRoute = new Hono().get("/consent", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const oauthQuery = c.req.query("oauth_query") ?? "";
  if (!oauthQuery || !(await verifyOAuthQueryParams(oauthQuery, config.BETTER_AUTH_SECRET))) {
    return c.json({ error: "invalid_query", message: "Havola yaroqsiz yoki muddati o'tgan" }, 400);
  }

  const params = new URLSearchParams(oauthQuery);
  const role = (session.user as { role?: string }).role ?? "user";
  return c.json(
    await buildConsentInfo({
      user: { name: session.user.name ?? null, email: session.user.email, role },
      clientId: params.get("client_id"),
      scope: params.get("scope"),
    }),
  );
});

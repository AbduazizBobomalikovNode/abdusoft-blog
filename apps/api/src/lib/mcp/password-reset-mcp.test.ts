import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMockTelegram } from "../../../scripts/mock-telegram.js";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD } from "../../test/auth-test-helpers.js";
import { connect, mcpCall } from "../../test/mcp-harness.js";
import { linkFromMessage, postReset, requestReset, tgCalls, tokenFromLink, type MockTelegram } from "../../test/password-reset-helpers.js";
import { reconfigureBot } from "../../telegram/client.js";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.TRUST_PROXY = "true";
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
});

let app: Hono;
let mock: MockTelegram;
let db: typeof import("../../db/index.js").db;
let authSchema: typeof import("../../db/auth-schema.js");

beforeAll(async () => {
  mock = await startMockTelegram();
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  ({ db } = await import("../../db/index.js"));
  authSchema = await import("../../db/auth-schema.js");
  const { saveSettings, invalidateSettingsCache } = await import("../settings.js");
  delete process.env.TELEGRAM_API_ROOT;
  invalidateSettingsCache();
  await saveSettings({ telegram: { botToken: "test-bot-token", webhookSecret: "0123456789abcdef", adminChatId: "424242", apiRoot: mock.url } });
  reconfigureBot("test-bot-token", mock.url);
});

afterAll(async () => {
  reconfigureBot("", "");
  await mock.close();
});

describe("password reset revokes Claude connector tokens (MCP_ENABLED=true)", () => {
  it("kills access/refresh tokens and the consent after a successful reset, like a password change does", async () => {
    const owner = await createTestUser({ role: "admin" });
    const { tokens } = await connect(app, { email: owner.email, password: TEST_USER_PASSWORD });
    expect((await mcpCall(app, tokens.access_token, "tools/list")).status).toBe(200);
    expect(await db.select().from(authSchema.oauthConsent).where(eq(authSchema.oauthConsent.userId, owner.id))).toHaveLength(1);

    await requestReset(app, owner.email);
    const { whenPasswordResetIdle } = await import("../password-reset.js");
    await whenPasswordResetIdle();
    const sent = await tgCalls(mock, "sendMessage");
    expect(sent).toHaveLength(1);
    const token = tokenFromLink(linkFromMessage(String(sent[0]!.body.text)));

    // Muvaffaqiyatsiz urinish (qisqa parol) ulanishlarga tegmaydi.
    expect((await postReset(app, { token, newPassword: "short" })).status).toBe(400);
    expect((await mcpCall(app, tokens.access_token, "tools/list")).status).toBe(200);

    expect((await postReset(app, { token, newPassword: "yangi-juda-uzun-parol-2026" })).status).toBe(200);
    expect((await mcpCall(app, tokens.access_token, "tools/list")).status).toBe(401);
    expect(await db.select().from(authSchema.oauthConsent).where(eq(authSchema.oauthConsent.userId, owner.id))).toHaveLength(0);
    expect(await db.select().from(authSchema.oauthRefreshToken).where(eq(authSchema.oauthRefreshToken.userId, owner.id))).toHaveLength(0);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { startMockTelegram } from "../../../scripts/mock-telegram.js";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD, type TestUser } from "../../test/auth-test-helpers.js";
import { API, callTool, connect, type Json } from "../../test/mcp-harness.js";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_WRITE_TOOLS_ENABLED = "true";
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
  for (const key of ["CREATES_PER_HOUR", "EDITS_PER_HOUR", "PUBLISHES_PER_DAY", "CHANNEL_SENDS_PER_DAY", "DESTRUCTIVE_PER_DAY"]) process.env[`MCP_WRITE_LIMIT_${key}`] = "0";
});

let app: Hono;
let admin: TestUser;
let full: string; // every permission
let narrow: string; // reading + writing + publishing, NO channels:send
let mock: { url: string; close: () => Promise<void> } | null = null;
let db: typeof import("../../db/index.js").db;
let s: typeof import("../../db/schema.js");

const calls = async () => ((await (await fetch(`${mock!.url}/__calls`)).json()) as { calls: { method: string }[] }).calls;
const methods = async (re: RegExp) => (await calls()).map((c) => c.method).filter((m) => re.test(m));
const settle = () => new Promise((r) => setTimeout(r, 400));
const callAs = (tok: string, name: string, args: Record<string, unknown> = {}) => callTool(app, tok, name, args);
const webReq = (path: string, init: { method?: string; body?: unknown } = {}) =>
  app.request(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie: admin.cookie, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

const refOf = async (id: string) => (await db.select().from(s.telegramRefs).where(eq(s.telegramRefs.postId, id)))[0];

beforeAll(async () => {
  mock = await startMockTelegram();
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  ({ db } = await import("../../db/index.js"));
  s = await import("../../db/schema.js");
  const { config } = await import("../../config.js");
  (config as { TELEGRAPH_API_ROOT: string }).TELEGRAPH_API_ROOT = mock.url;
  const { invalidateSettingsCache, saveSettings } = await import("../settings.js");
  const { reconfigureBot } = await import("../../telegram/client.js");
  const { registerTelegramPublishing } = await import("../../telegram/publish.js");
  registerTelegramPublishing();
  admin = await createTestUser({ role: "admin" });
  delete process.env.TELEGRAM_API_ROOT;
  invalidateSettingsCache();
  await saveSettings({ telegram: { botToken: "test-bot-token", webhookSecret: "0123456789abcdef", channelId: "@testchannel", apiRoot: mock.url }, telegraph: { enabled: true, accessToken: "tgph-token" } });
  reconfigureBot("test-bot-token", mock.url);
  full = (await connect(app, { email: admin.email, password: TEST_USER_PASSWORD })).tokens.access_token;
  narrow = (await connect(app, { email: admin.email, password: TEST_USER_PASSWORD }, { consentScope: "blog:read posts:write posts:publish" })).tokens.access_token;
});
afterAll(async () => {
  await mock?.close();
});
beforeEach(async () => {
  await fetch(`${mock!.url}/__calls`, { method: "DELETE" });
});

describe("the Telegraph mirror follows the site, with or without channels:send", () => {
  it("publish and update without the channel permission still create and refresh the Telegraph page, and never touch the channel", async () => {
    const created = (await callAs(narrow, "create_post_draft", { title: "Ko'zgu", content_markdown: "## Salom\n\nBu Telegraph ko'zgusi uchun matn. ".repeat(4) })).json.post;
    const pub = (await callAs(narrow, "publish_post", { id: created.id, expected_updated_at: created.updatedAt })).json;
    expect(pub.post.status).toBe("published");
    await settle();
    expect(await methods(/^createPage$/)).toHaveLength(1);
    expect((await refOf(created.id))?.telegraphUrl).toMatch(/telegra\.ph/);

    const upd = await callAs(narrow, "update_post", { id: created.id, expected_updated_at: pub.post.updatedAt, content_markdown: "## Yangi\n\nMatn o'zgardi va ko'zgu yangilanishi kerak." });
    expect(upd.isError, upd.text).toBe(false);
    await settle();
    expect(await methods(/^editPage$/)).toHaveLength(1);
    expect(await methods(/^(sendMessage|sendPhoto|sendMediaGroup|editMessage|deleteMessage)/)).toEqual([]);
  });
});

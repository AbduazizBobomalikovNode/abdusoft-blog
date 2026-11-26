import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { startMockTelegram } from "../../../scripts/mock-telegram.js";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD, type TestUser } from "../../test/auth-test-helpers.js";
import { API, ALL_BLOG_SCOPES, callTool, connect, type Json } from "../../test/mcp-harness.js";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_WRITE_TOOLS_ENABLED = "true";
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
  for (const key of ["CREATES_PER_HOUR", "EDITS_PER_HOUR", "PUBLISHES_PER_DAY", "CHANNEL_SENDS_PER_DAY", "MODERATION_PER_HOUR", "DESTRUCTIVE_PER_DAY"]) process.env[`MCP_WRITE_LIMIT_${key}`] = "0";
});

const EVERY_SCOPE = `${ALL_BLOG_SCOPES} channels:prepare`;
let app: Hono;
let admin: TestUser;
let full: string;
let prepareOnly: string; // blog:read + channels:prepare, NO channels:send
let db: typeof import("../../db/index.js").db;
let s: typeof import("../../db/schema.js");
let mock: { url: string; close: () => Promise<void> };

const call = (tok: string, name: string, args: Record<string, unknown> = {}) => callTool(app, tok, name, args);
const ok = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await call(full, name, args);
  expect(r.isError, `${name}: ${r.text}`).toBe(false);
  return r.json as Json;
};
const row = async (id: string) => (await db.select().from(s.posts).where(eq(s.posts.id, id)))[0]!;
const panel = (path: string, method: string, body?: unknown) =>
  app.request(`${API}${path}`, { method, headers: { cookie: admin.cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });

async function scheduledPostWithVersion(title: string) {
  const created = (await ok("create_post_draft", { title, content_markdown: "## Salom\n\nBu rejalashtirilgan post uchun yetarlicha uzun matn. ".repeat(6) })).post;
  const v = (await ok("create_channel_version", { id: created.id, mode: "text", name: "Asosiy" })).version;
  const sched = (await ok("schedule_post", { id: created.id, expected_updated_at: created.updatedAt, scheduled_at: new Date(Date.now() + 3_600_000).toISOString() })).post;
  return { id: created.id as string, versionId: v.id as string, token: sched.updatedAt as string };
}
const versionToken = async (id: string, vid: string) => (await ok("get_channel_version", { id, version_id: vid })).version.updatedAt as string;

beforeAll(async () => {
  mock = await startMockTelegram();
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  ({ db } = await import("../../db/index.js"));
  s = await import("../../db/schema.js");
  const { invalidateSettingsCache, saveSettings } = await import("../settings.js");
  const { reconfigureBot } = await import("../../telegram/client.js");
  const { registerTelegramPublishing } = await import("../../telegram/publish.js");
  registerTelegramPublishing();
  admin = await createTestUser({ role: "admin", name: "Owner" });
  delete process.env.TELEGRAM_API_ROOT;
  invalidateSettingsCache();
  await saveSettings({ telegram: { botToken: "test-bot-token", webhookSecret: "0123456789abcdef", channelId: "@testchannel", apiRoot: mock.url } });
  reconfigureBot("test-bot-token", mock.url);
  full = (await connect(app, { email: admin.email, password: TEST_USER_PASSWORD }, { scope: EVERY_SCOPE })).tokens.access_token;
  prepareOnly = (await connect(app, { email: admin.email, password: TEST_USER_PASSWORD }, { scope: EVERY_SCOPE, consentScope: "blog:read channels:prepare" })).tokens.access_token;
});
afterAll(async () => {
  await mock?.close();
});

describe("channels:prepare cannot change what a pending public channel post will contain", () => {
  it("update_channel_version on a version used directly by a scheduled plan is refused without channels:send; allowed with it; and allowed when no plan uses it", async () => {
    const p = await scheduledPostWithVersion("Reja versiya");
    await ok("set_channel_plan", { id: p.id, expected_updated_at: p.token, delay_minutes: 5, version_id: p.versionId });
    const token = await versionToken(p.id, p.versionId);
    const refused = await call(prepareOnly, "update_channel_version", { id: p.id, version_id: p.versionId, expected_version_updated_at: token, text_html: "<b>Boshqa matn</b>" });
    expect(refused.isError).toBe(true);
    expect(refused.json.error.code).toBe("conflict");
    expect(refused.json.error.requiredScope).toBe("channels:send");
    expect(await versionToken(p.id, p.versionId)).toBe(token);
    const allowed = await call(full, "update_channel_version", { id: p.id, version_id: p.versionId, expected_version_updated_at: token, text_html: "<b>Boshqa matn</b>" });
    expect(allowed.isError, allowed.text).toBe(false);
    // a version nothing relies on stays editable with prepare only
    const other = (await ok("create_channel_version", { id: p.id, mode: "text", name: "Boshqa" })).version;
    const free = await call(prepareOnly, "update_channel_version", { id: p.id, version_id: other.id, expected_version_updated_at: other.updatedAt, name: "Yangi nom" });
    expect(free.isError, free.text).toBe(false);
  });

  it("the marked version of a post whose plan uses the mark is protected, and so are set/clear of the mark", async () => {
    const p = await scheduledPostWithVersion("Reja belgi");
    const fresh = (await ok("get_post", { id: p.id })).post;
    const marked = await ok("set_channel_choice", { id: p.id, expected_updated_at: fresh.updatedAt, version_id: p.versionId });
    await ok("set_channel_plan", { id: p.id, expected_updated_at: marked.post.updatedAt, delay_minutes: 5, use_marked: true });
    const cur = (await ok("get_post", { id: p.id })).post.updatedAt as string;
    const vtoken = await versionToken(p.id, p.versionId);

    const editMarked = await call(prepareOnly, "update_channel_version", { id: p.id, version_id: p.versionId, expected_version_updated_at: vtoken, name: "Hijack" });
    expect(editMarked.json.error.code).toBe("conflict");
    const setAuto = await call(prepareOnly, "set_channel_choice", { id: p.id, expected_updated_at: cur, mode: "text", variant: "s" });
    expect(setAuto.json.error.code).toBe("conflict");
    const clear = await call(prepareOnly, "clear_channel_choice", { id: p.id, expected_updated_at: cur });
    expect(clear.json.error.code).toBe("conflict");
    expect((await row(p.id)).channelChoice).toMatchObject({ kind: "version", versionId: p.versionId });

    // the owner with channels:send may do it
    const setOk = await call(full, "set_channel_choice", { id: p.id, expected_updated_at: cur, mode: "text", variant: "s" });
    expect(setOk.isError, setOk.text).toBe(false);
    // the web panel is unchanged: it can edit the version and the mark freely
    const patch = await panel(`/admin/posts/${p.id}/channel/versions/${p.versionId}`, "PATCH", { name: "Paneldan" });
    expect(patch.status).toBe(200);
    expect((await panel(`/admin/posts/${p.id}/channel/choice`, "PUT", { kind: "auto", mode: "text", variant: "m" })).status).toBe(200);
  });

  it("a plan with an explicit mode+variant does not make the mark or other versions protected", async () => {
    const p = await scheduledPostWithVersion("Reja aniq");
    await ok("set_channel_plan", { id: p.id, expected_updated_at: p.token, delay_minutes: 5, mode: "text", variant: "m" });
    const cur = (await ok("get_post", { id: p.id })).post.updatedAt as string;
    const r = await call(prepareOnly, "set_channel_choice", { id: p.id, expected_updated_at: cur, version_id: p.versionId });
    expect(r.isError, r.text).toBe(false);
  });
});

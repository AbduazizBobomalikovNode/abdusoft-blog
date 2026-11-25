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

/** A published post, optionally already sent to the channel (as the owner with every permission). */
async function publishedPost(title: string, sent: boolean): Promise<{ id: string; token: string }> {
  const created = (await callAs(full, "create_post_draft", { title, content_markdown: "## Salom\n\nBu kanalga yuboriladigan post matni. ".repeat(6) })).json.post;
  const pub = (await callAs(full, "publish_post", { id: created.id, expected_updated_at: created.updatedAt })).json;
  let token = pub.post.updatedAt as string;
  if (sent) {
    const r = await callAs(full, "send_to_channel", { id: created.id, expected_updated_at: token, mode: "text", variant: "m" });
    expect(r.isError, r.text).toBe(false);
    token = (await callAs(full, "get_post", { id: created.id })).json.post.updatedAt;
  }
  return { id: created.id, token };
}
const refOf = async (id: string) => (await db.select().from(s.telegramRefs).where(eq(s.telegramRefs.postId, id)))[0];
const postOf = async (id: string) => (await db.select().from(s.posts).where(eq(s.posts.id, id)))[0]!;

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
  admin = await createTestUser({ role: "admin" });
  delete process.env.TELEGRAM_API_ROOT;
  invalidateSettingsCache();
  await saveSettings({ telegram: { botToken: "test-bot-token", webhookSecret: "0123456789abcdef", channelId: "@testchannel", apiRoot: mock.url } });
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

describe("a connection without channels:send never touches the Telegram channel", () => {
  it("sanity: the narrow connection really lacks the channel permission", async () => {
    const who = (await callAs(narrow, "whoami")).json;
    expect(who.grantedScopes.map((g: Json) => g.id)).toEqual(expect.arrayContaining(["blog:read", "posts:write", "posts:publish"]));
    expect(who.grantedScopes.map((g: Json) => g.id)).not.toContain("channels:send");
  });

  it("update_post on a published, already-sent post changes the site, leaves the channel message alone and says so", async () => {
    const p = await publishedPost("Tahrir sinovi", true);
    await fetch(`${mock!.url}/__calls`, { method: "DELETE" });
    const r = await callAs(narrow, "update_post", { id: p.id, expected_updated_at: p.token, content_markdown: "## Yangi\n\nSayt matni o'zgardi." });
    expect(r.isError, r.text).toBe(false);
    expect(r.json.channelNote).toMatch(/NOT changed/);
    expect((await postOf(p.id)).contentText).toContain("Sayt matni o'zgardi");
    await settle();
    expect(await methods(/^edit|^delete|^send/)).toEqual([]);
    expect((await refOf(p.id))?.channelMessageId).toBeTruthy();
  });

  it("with the permission the same edit refreshes the channel message exactly as the panel does", async () => {
    const p = await publishedPost("Tahrir ruxsat bilan", true);
    await fetch(`${mock!.url}/__calls`, { method: "DELETE" });
    const r = await callAs(full, "update_post", { id: p.id, expected_updated_at: p.token, content_markdown: "## Yangi\n\nMatn o'zgardi." });
    expect(r.isError, r.text).toBe(false);
    expect(r.json.channelNote).toBeUndefined();
    await settle();
    expect((await methods(/^edit/)).length).toBe(1);
  });

  it.each([
    ["unpublish_post", {}],
    ["archive_post", {}],
    ["schedule_post", { scheduled_at: new Date(Date.now() + 3_600_000).toISOString() }],
  ])("%s on a post that has a channel message is refused, with nothing deleted and nothing changed", async (tool, extra) => {
    const p = await publishedPost(`Rad etiladi ${tool}`, true);
    await fetch(`${mock!.url}/__calls`, { method: "DELETE" });
    const r = await callAs(narrow, tool, { id: p.id, expected_updated_at: p.token, ...extra });
    expect(r.isError).toBe(true);
    expect(r.json.error.code).toBe("insufficient_scope");
    expect(r.json.error.requiredScope).toBe("channels:send");
    expect(r.json.error.message).toMatch(/DELETE that channel message/);
    await settle();
    expect(await methods(/^delete|^edit|^send/)).toEqual([]);
    expect((await postOf(p.id)).status).toBe("published");
    expect((await refOf(p.id))?.channelMessageId).toBeTruthy();
  });

  it.each([
    ["unpublish_post", {}, "draft"],
    ["archive_post", {}, "archived"],
    ["schedule_post", { scheduled_at: new Date(Date.now() + 3_600_000).toISOString() }, "scheduled"],
  ])("%s on a published post WITHOUT a channel message still works for the narrow connection", async (tool, extra, status) => {
    const p = await publishedPost(`Kanalsiz ${tool}`, false);
    const r = await callAs(narrow, tool, { id: p.id, expected_updated_at: p.token, ...extra });
    expect(r.isError, r.text).toBe(false);
    expect((await postOf(p.id)).status).toBe(status);
    await settle();
    expect(await methods(/^delete/)).toEqual([]);
  });

  it.each([
    ["unpublish_post", {}, "draft"],
    ["archive_post", {}, "archived"],
    ["schedule_post", { scheduled_at: new Date(Date.now() + 3_600_000).toISOString() }, "scheduled"],
  ])("%s with channels:send deletes the channel message, like the panel", async (tool, extra, status) => {
    const p = await publishedPost(`Ruxsat bilan ${tool}`, true);
    await fetch(`${mock!.url}/__calls`, { method: "DELETE" });
    const r = await callAs(full, tool, { id: p.id, expected_updated_at: p.token, ...extra });
    expect(r.isError, r.text).toBe(false);
    expect((await postOf(p.id)).status).toBe(status);
    await settle();
    expect(await methods(/^delete/)).toHaveLength(1);
    expect((await refOf(p.id))?.channelMessageId ?? null).toBeNull();
  });

  it("the panel's own behaviour is unchanged: unpublishing a sent post over HTTP deletes the channel message", async () => {
    const p = await publishedPost("Panel o'zgarmaydi", true);
    await fetch(`${mock!.url}/__calls`, { method: "DELETE" });
    const res = await webReq(`/admin/posts/${p.id}/unpublish`, { method: "POST" });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    await settle();
    expect(await methods(/^delete/)).toHaveLength(1);
  });

  it("the tool metadata matches the behaviour: removal tools are destructive and no description claims the channel message is untouched", async () => {
    const { mcpCall } = await import("../../test/mcp-harness.js");
    const tools = (await mcpCall(app, full, "tools/list")).body.result.tools as Json[];
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ["unpublish_post", "archive_post", "schedule_post"]) {
      expect(by[name].annotations.destructiveHint, name).toBe(true);
      expect(by[name].description, name).not.toMatch(/NOT deleted/i);
      expect(by[name].description, name).toMatch(/channels:send/);
    }
    expect(by.update_post.description).toMatch(/channelNote/);
  });
});

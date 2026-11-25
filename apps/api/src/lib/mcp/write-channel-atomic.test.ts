import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { startMockTelegram } from "../../../scripts/mock-telegram.js";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD, type TestUser } from "../../test/auth-test-helpers.js";
import { API, callTool, connect } from "../../test/mcp-harness.js";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_WRITE_TOOLS_ENABLED = "true";
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
  for (const key of ["CREATES_PER_HOUR", "EDITS_PER_HOUR", "PUBLISHES_PER_DAY", "CHANNEL_SENDS_PER_DAY", "DESTRUCTIVE_PER_DAY"]) process.env[`MCP_WRITE_LIMIT_${key}`] = "0";
});

let app: Hono;
let admin: TestUser;
let t: string;
let mock: { url: string; close: () => Promise<void> } | null = null;
let db: typeof import("../../db/index.js").db;
let s: typeof import("../../db/schema.js");

const calls = async () => ((await (await fetch(`${mock!.url}/__calls`)).json()) as { calls: { method: string; body: Record<string, unknown> }[] }).calls;
const methods = async (re: RegExp) => (await calls()).map((c) => c.method).filter((m) => re.test(m));
const call = (name: string, args: Record<string, unknown> = {}) => callTool(app, t, name, args);
const refOf = async (id: string) => (await db.select().from(s.telegramRefs).where(eq(s.telegramRefs.postId, id)))[0];
const audits = async (action: string, id: string) => (await db.select().from(s.auditLog).where(and(eq(s.auditLog.action, action), eq(s.auditLog.entityId, id))));

async function publishedPost(title: string) {
  const created = (await call("create_post_draft", { title, content_markdown: "## Salom\n\nBu kanalga yuboriladigan post matni. ".repeat(6) })).json.post;
  const pub = (await call("publish_post", { id: created.id, expected_updated_at: created.updatedAt })).json;
  return { id: created.id as string, token: pub.post.updatedAt as string };
}

beforeAll(async () => {
  mock = await startMockTelegram();
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  ({ db } = await import("../../db/index.js"));
  s = await import("../../db/schema.js");
  const { invalidateSettingsCache, saveSettings } = await import("../settings.js");
  const { reconfigureBot } = await import("../../telegram/client.js");
  admin = await createTestUser({ role: "admin" });
  delete process.env.TELEGRAM_API_ROOT;
  invalidateSettingsCache();
  await saveSettings({ telegram: { botToken: "test-bot-token", webhookSecret: "0123456789abcdef", channelId: "@testchannel", apiRoot: mock.url } });
  reconfigureBot("test-bot-token", mock.url);
  t = (await connect(app, { email: admin.email, password: TEST_USER_PASSWORD })).tokens.access_token;
});
afterAll(async () => {
  await mock?.close();
});
beforeEach(async () => {
  await fetch(`${mock!.url}/__calls`, { method: "DELETE" });
  await fetch(`${mock!.url}/__fail`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "sendMessage", count: 0 }) });
});

describe("sending to the channel is atomic per post", () => {
  it("four parallel send_to_channel calls produce exactly one channel message", async () => {
    const p = await publishedPost("Parallel yuborish");
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => call("send_to_channel", { id: p.id, expected_updated_at: p.token, mode: "text", variant: "m" })),
    );
    expect(await methods(/^sendMessage$/)).toHaveLength(1);
    const okCount = results.filter((r) => !r.isError).length;
    expect(okCount).toBe(1);
    expect(results.filter((r) => r.isError).every((r) => /already/i.test(r.text))).toBe(true);
    expect((await refOf(p.id))?.channelMessageId).toBeTruthy();
  });

  it("a replace sends the NEW message first and deletes the old one only after success", async () => {
    const p = await publishedPost("Almashtirish tartibi");
    const first = await call("send_to_channel", { id: p.id, expected_updated_at: p.token, mode: "text", variant: "m" });
    expect(first.isError, first.text).toBe(false);
    const oldId = (await refOf(p.id))!.channelMessageId!;
    await fetch(`${mock!.url}/__calls`, { method: "DELETE" });
    const token = (await call("get_post", { id: p.id })).json.post.updatedAt;
    const second = await call("send_to_channel", { id: p.id, expected_updated_at: token, mode: "text", variant: "l", replace_existing: true });
    expect(second.isError, second.text).toBe(false);
    const order = await methods(/^(sendMessage|deleteMessage)$/);
    expect(order).toEqual(["sendMessage", "deleteMessage"]);
    const ref = (await refOf(p.id))!;
    expect(ref.channelMessageId).not.toBe(oldId);
    expect(ref.channelVariant).toBe("l");
  });

  it("a failing replace keeps the old message and its reference, and is audited", async () => {
    const p = await publishedPost("Almashtirish yiqiladi");
    expect((await call("send_to_channel", { id: p.id, expected_updated_at: p.token, mode: "text", variant: "m" })).isError).toBe(false);
    const before = (await refOf(p.id))!;
    await fetch(`${mock!.url}/__calls`, { method: "DELETE" });
    await fetch(`${mock!.url}/__fail`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "sendMessage", count: 1 }) });
    const token = (await call("get_post", { id: p.id })).json.post.updatedAt;
    const failed = await call("send_to_channel", { id: p.id, expected_updated_at: token, mode: "text", variant: "l", replace_existing: true });
    expect(failed.isError).toBe(true);
    expect(await methods(/^deleteMessage$/)).toEqual([]);
    const after = (await refOf(p.id))!;
    expect(after.channelMessageId).toBe(before.channelMessageId);
    expect(after.channelSentAt?.getTime()).toBe(before.channelSentAt?.getTime());
    const failures = await audits("post.channel_send_failed", p.id);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.meta).toMatchObject({ replaceExisting: true, previousMessageKept: true });
    expect(JSON.stringify(failures[0]!.meta)).not.toContain("Kanalga yuboriladigan");
    // and a retry still works
    const retry = await call("send_to_channel", { id: p.id, expected_updated_at: token, mode: "text", variant: "l", replace_existing: true });
    expect(retry.isError, retry.text).toBe(false);
  });

  it("the panel's single successful send is unchanged: one message, one audit entry", async () => {
    const p = await publishedPost("Panel yuborishi");
    const res = await app.request(`${API}/admin/posts/${p.id}/channel/send`, {
      method: "POST",
      headers: { cookie: admin.cookie, "content-type": "application/json" },
      body: JSON.stringify({ mode: "text", variant: "m" }),
    });
    expect(res.status).toBeLessThan(300);
    expect(await methods(/^sendMessage$/)).toHaveLength(1);
    expect(await audits("post.channel_send", p.id)).toHaveLength(1);
  });
});

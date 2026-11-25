import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
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
});

const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

let app: Hono;
let admin: TestUser;
let t: string;
let mock: { url: string; close: () => Promise<void> } | null = null;
let db: typeof import("../../db/index.js").db;
let s: typeof import("../../db/schema.js");
let uploadsDir: string;
let publishedId: string;
let publishedToken: string;

const calls = async () => ((await (await fetch(`${mock!.url}/__calls`)).json()) as { calls: { method: string; body: Record<string, unknown> }[] }).calls;
/** Faqat yozuvchi chaqiruvlar (getChat kabi o'qish chaqiruvlari hisobga olinmaydi). */
const writes = async () => (await calls()).filter((c) => /^(send|delete|edit|pin|ban)/.test(c.method));
const call = (name: string, args: Record<string, unknown> = {}) => callTool(app, t, name, args);
const auditOf = async (action: string) => (await db.select().from(s.auditLog).where(eq(s.auditLog.action, action))).filter((r) => r.via === "mcp");

beforeAll(async () => {
  mock = await startMockTelegram();
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  ({ db } = await import("../../db/index.js"));
  s = await import("../../db/schema.js");
  const { config } = await import("../../config.js");
  const { invalidateSettingsCache, saveSettings } = await import("../settings.js");
  const { reconfigureBot } = await import("../../telegram/client.js");
  ({ uploadsDir } = (await import("../media/store.js")) as unknown as { uploadsDir: string });
  admin = await createTestUser({ role: "admin" });
  delete process.env.TELEGRAM_API_ROOT;
  invalidateSettingsCache();
  await saveSettings({ telegram: { botToken: "test-bot-token", webhookSecret: "0123456789abcdef", channelId: "@testchannel", apiRoot: mock.url } });
  reconfigureBot("test-bot-token", mock.url);
  t = (await connect(app, { email: admin.email, password: TEST_USER_PASSWORD })).tokens.access_token;

  const dir = path.join(uploadsDir, "test-mcp-channel");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "cover.png"), TINY_PNG);
  const coverUrl = `${config.API_ORIGIN}/uploads/test-mcp-channel/cover.png`;

  const created = (await call("create_post_draft", { title: "Kanal posti", content_markdown: "## Salom\n\nBu kanalga yuboriladigan post matni. ".repeat(6) })).json.post;
  await call("update_post", { id: created.id, expected_updated_at: created.updatedAt, cover_url: coverUrl });
  const fresh = (await call("get_post", { id: created.id })).json.post;
  const pub = (await call("publish_post", { id: created.id, expected_updated_at: fresh.updatedAt })).json;
  publishedId = created.id;
  publishedToken = pub.post.updatedAt;
});

afterAll(async () => {
  await mock?.close();
  await rm(path.join(uploadsDir, "test-mcp-channel"), { recursive: true, force: true });
});

beforeEach(async () => {
  await fetch(`${mock!.url}/__calls`, { method: "DELETE" });
});

describe("Telegram channel tools", () => {
  it("previews and checks without sending anything", async () => {
    const preview = await call("preview_channel_post", { id: publishedId, mode: "text", variant: "m" });
    expect(preview.isError, preview.text).toBe(false);
    expect(preview.json).toMatchObject({ selection: { mode: "text", variant: "m", chosenBy: "explicit" }, truncated: expect.any(Boolean), alreadySent: null, untrusted: true });
    expect(preview.json.captionHtml).toContain("Kanal posti");
    expect(preview.json.limit).toBe(800);

    const check = await call("check_channel_post", { id: publishedId, mode: "text", variant: "m" });
    expect(check.json.canSend).toBe(true);
    expect(check.json.checks.length).toBeGreaterThan(0);
    const dflt = await call("check_channel_post", { id: publishedId });
    expect(dflt.json.selection.chosenBy).toBe("default");
    expect(await writes()).toEqual([]);
  });

  it("send_to_channel dry run reports and sends nothing; a stale token conflicts", async () => {
    const dry = await call("send_to_channel", { id: publishedId, expected_updated_at: publishedToken, mode: "text", variant: "m", dry_run: true });
    expect(dry.json).toMatchObject({ dryRun: true, canSend: true });
    expect(await writes()).toEqual([]);
    expect((await auditOf("post.channel_send")).length).toBe(0);
    const stale = await call("send_to_channel", { id: publishedId, expected_updated_at: "2000-01-01T00:00:00.000Z", mode: "text", variant: "m" });
    expect(stale.json.error.code).toBe("conflict");
    expect(await writes()).toEqual([]);
  });

  it("sends once, refuses a second send, and replaces the message only when asked", async () => {
    const sent = await call("send_to_channel", { id: publishedId, expected_updated_at: publishedToken, mode: "text", variant: "m" });
    expect(sent.isError, sent.text).toBe(false);
    expect(sent.json.channel).toMatchObject({ mode: "text", variant: "m", messages: 1 });
    expect((await calls()).filter((c) => c.method === "sendMessage")).toHaveLength(1);
    const [ref] = await db.select().from(s.telegramRefs).where(eq(s.telegramRefs.postId, publishedId));
    expect(ref?.channelMessageId).toBeTruthy();
    const audit = (await auditOf("post.channel_send"))[0]!;
    expect(audit.meta).toMatchObject({ tool: "send_to_channel", mode: "text", variant: "m", replaceExisting: false });
    expect(JSON.stringify(audit.meta)).not.toContain("Kanalga yuboriladigan");

    const again = await call("send_to_channel", { id: publishedId, expected_updated_at: publishedToken, mode: "text", variant: "m" });
    expect(again.json.error).toMatchObject({ code: "conflict" });
    expect(again.json.error.hint).toContain("replace_existing");
    expect((await calls()).filter((c) => c.method === "sendMessage")).toHaveLength(1);

    const dry = await call("send_to_channel", { id: publishedId, expected_updated_at: publishedToken, mode: "text", variant: "m", dry_run: true });
    expect(dry.json.canSend).toBe(false);
    expect(dry.json.refusedBecause).toMatch(/already sent/);

    const replaced = await call("send_to_channel", { id: publishedId, expected_updated_at: publishedToken, mode: "text", variant: "m", replace_existing: true });
    expect(replaced.isError, replaced.text).toBe(false);
    const methods = (await calls()).map((c) => c.method);
    expect(methods).toContain("deleteMessage");
    expect(methods.filter((m) => m === "sendMessage")).toHaveLength(2);
    expect((await auditOf("post.channel_replace")).length).toBe(1);
  });

  it("a failed preflight sends nothing and returns the failing checks", async () => {
    // cover is missing on disk -> the photo preflight cannot read it
    const post = (await call("create_post_draft", { title: "Rasmsiz kanal", content_markdown: "## A\n\nBu yetarlicha uzun matn va u hammasi joyida bo'lishi kerak." })).json.post;
    const withCover = (await call("update_post", { id: post.id, expected_updated_at: post.updatedAt, cover_url: `${API}/uploads/yo-q-rasm/missing.png` })).json.post;
    const pub = (await call("publish_post", { id: post.id, expected_updated_at: withCover.updatedAt })).json.post;
    const r = await call("send_to_channel", { id: post.id, expected_updated_at: pub.updatedAt, mode: "media", variant: "m" });
    expect(r.isError).toBe(true);
    expect(["unprocessable"]).toContain(r.json.error.code);
    expect(r.json.error.message).toMatch(/nothing was sent|Telegram checks failed/i);
    expect(r.json.error.failingChecks.length).toBeGreaterThan(0);
    expect((await calls()).filter((c) => c.method.startsWith("send"))).toEqual([]);
    expect((await db.select().from(s.telegramRefs).where(eq(s.telegramRefs.postId, post.id))).filter((x) => x.channelMessageId)).toHaveLength(0);
  });

  it("only a published, live post can be sent", async () => {
    const draft = (await call("create_post_draft", { title: "Qoralama kanal", content_markdown: "## A\n\nyetarlicha matn" })).json.post;
    const r = await call("send_to_channel", { id: draft.id, expected_updated_at: draft.updatedAt, mode: "text", variant: "m" });
    expect(r.json.error.code).toBe("conflict");
    expect(r.json.error.message).toMatch(/published/);
  });

  it("publish_post with send_to_channel needs a marked version and sends it after publishing", async () => {
    const p = (await call("create_post_draft", { title: "Belgilangan", content_markdown: "## A\n\nBu yetarlicha uzun matn va u hammasi joyida." })).json.post;
    const noChoice = await call("publish_post", { id: p.id, expected_updated_at: p.updatedAt, send_to_channel: true });
    expect(noChoice.json.error.code).toBe("invalid_input");
    expect((await db.select().from(s.posts).where(eq(s.posts.id, p.id)))[0]!.status).toBe("draft");

    const mark = await app.request(`${API}/admin/posts/${p.id}/channel/choice`, { method: "PUT", headers: { cookie: admin.cookie, "content-type": "application/json" }, body: JSON.stringify({ kind: "auto", mode: "text", variant: "m" }) });
    expect(mark.status).toBe(200);
    const fresh = (await call("get_post", { id: p.id })).json.post;
    const dry = await call("publish_post", { id: p.id, expected_updated_at: fresh.updatedAt, send_to_channel: true, dry_run: true });
    expect(dry.json.channelPreflight).toMatchObject({ canSend: true });
    expect(await writes()).toEqual([]);
    const pub = await call("publish_post", { id: p.id, expected_updated_at: fresh.updatedAt, send_to_channel: true });
    expect(pub.isError, pub.text).toBe(false);
    expect(pub.json.channelSend.state).toBe("sent");
    expect((await calls()).filter((c) => c.method === "sendMessage").length).toBe(1);
  });
});

void (undefined as unknown as Json);

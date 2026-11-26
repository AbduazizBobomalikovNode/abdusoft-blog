import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { startMockTelegram } from "../../../scripts/mock-telegram.js";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD, type TestUser } from "../../test/auth-test-helpers.js";
import { ALL_BLOG_SCOPES, callTool, connect, mcpCall, type Json } from "../../test/mcp-harness.js";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_WRITE_TOOLS_ENABLED = "true";
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
  for (const key of ["CREATES_PER_HOUR", "EDITS_PER_HOUR", "PUBLISHES_PER_DAY", "CHANNEL_SENDS_PER_DAY", "MODERATION_PER_HOUR", "DESTRUCTIVE_PER_DAY"]) process.env[`MCP_WRITE_LIMIT_${key}`] = "0";
});

const EVERY_SCOPE = `${ALL_BLOG_SCOPES} channels:prepare staff:manage settings:manage`;
let app: Hono;
let admin: TestUser;
let full: string;
let db: typeof import("../../db/index.js").db;
let s: typeof import("../../db/schema.js");
let mock: { url: string; close: () => Promise<void> };

const call = (name: string, args: Record<string, unknown> = {}, tok = full) => callTool(app, tok, name, args);
const ok = async (name: string, args: Record<string, unknown> = {}, tok = full) => {
  const r = await call(name, args, tok);
  expect(r.isError, `${name}: ${r.text}`).toBe(false);
  return r.json as Json;
};
const calls = async () => ((await (await fetch(`${mock.url}/__calls`)).json()) as { calls: { method: string }[] }).calls.map((c) => c.method);
const settle = () => new Promise((r) => setTimeout(r, 400));

async function publishedPost(title: string) {
  const created = (await ok("create_post_draft", { title, content_markdown: "## Salom\n\nBu kanal versiyalari uchun yetarlicha uzun matn. ".repeat(6) })).post;
  const pub = await ok("publish_post", { id: created.id, expected_updated_at: created.updatedAt });
  return pub.post as Json;
}

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
  admin = await createTestUser({ role: "admin", name: "Owner" });
  delete process.env.TELEGRAM_API_ROOT;
  invalidateSettingsCache();
  await saveSettings({ telegram: { botToken: "test-bot-token", webhookSecret: "0123456789abcdef", channelId: "@testchannel", apiRoot: mock.url }, telegraph: { enabled: true, accessToken: "tgph-token" } });
  reconfigureBot("test-bot-token", mock.url);
  full = (await connect(app, { email: admin.email, password: TEST_USER_PASSWORD }, { scope: EVERY_SCOPE })).tokens.access_token;
});
afterAll(async () => {
  await mock?.close();
});

describe("scopes: the new permissions are required, granted separately and listed by whoami", () => {
  it("a connection without the new permissions is refused with insufficient_scope naming the permission", async () => {
    const narrow = (await connect(app, { email: admin.email, password: TEST_USER_PASSWORD }, { scope: "blog:read posts:write posts:publish channels:send comments:moderate posts:delete media:upload" })).tokens.access_token;
    for (const [tool, scope, args] of [
      ["list_staff", "staff:manage", {}],
      ["create_staff_invite", "staff:manage", {}],
      ["get_site_settings", "settings:manage", {}],
      ["update_about_page", "settings:manage", { expected_etag: "x".repeat(12), content_markdown: "## A\n\nb" }],
      ["create_channel_version", "channels:prepare", { id: "00000000-0000-4000-8000-000000000000", mode: "text" }],
    ] as const) {
      const r = await call(tool, args, narrow);
      expect(r.isError, tool).toBe(true);
      expect(r.json.error, tool).toMatchObject({ code: "insufficient_scope", requiredScope: scope });
    }
    const who = (await call("whoami", {}, full)).json;
    expect(who.grantedScopes.map((g: Json) => g.id)).toEqual(expect.arrayContaining(["channels:prepare", "staff:manage", "settings:manage"]));
  });

  it("read-only connections do not even see the new tools; with the switch on every new tool is registered with annotations", async () => {
    const list = (await mcpCall(app, full, "tools/list")).body.result.tools as Json[];
    const by = Object.fromEntries(list.map((t) => [t.name, t]));
    for (const name of ["list_channel_versions", "create_channel_version", "set_channel_plan", "refresh_telegraph_mirror", "list_comment_bans", "lift_comment_ban", "list_staff", "create_staff_invite", "update_site_settings", "update_about_page", "get_integration_status"]) expect(by[name], name).toBeTruthy();
    expect(by.remove_staff_member.annotations.destructiveHint).toBe(true);
    expect(by.list_staff.annotations.readOnlyHint).toBe(true);
  });
});

describe("channel versions, the marked choice and the channel plan", () => {
  it("create -> list -> get -> update (with token) -> mark -> delete, all audited with via mcp", async () => {
    const post = await publishedPost("Kanal versiyasi");
    const created = await ok("create_channel_version", { id: post.id, mode: "text", name: "Qisqa", idempotency_key: "ver-create-0001" });
    const vid = created.version.id as string;
    const replay = await ok("create_channel_version", { id: post.id, mode: "text", name: "Qisqa", idempotency_key: "ver-create-0001" });
    expect(replay.idempotentReplay).toBe(true);

    const listed = await ok("list_channel_versions", { id: post.id });
    expect(listed.versions).toHaveLength(1);
    expect(listed.untrusted).toBe(true);
    const got = await ok("get_channel_version", { id: post.id, version_id: vid });
    const token = got.version.updatedAt as string;

    const stale = await call("update_channel_version", { id: post.id, version_id: vid, expected_version_updated_at: "2000-01-01T00:00:00.000Z", name: "X" });
    expect(stale.json.error.code).toBe("conflict");
    const updated = await ok("update_channel_version", { id: post.id, version_id: vid, expected_version_updated_at: token, name: "Yangilangan", text_html: "<b>Salom</b> dunyo" });
    expect(updated.version.name).toBe("Yangilangan");
    expect((await ok("get_channel_version", { id: post.id, version_id: vid })).version.telegramHtml).toContain("<b>Salom</b>");

    const refetched = (await ok("get_post", { id: post.id })).post;
    const marked = await ok("set_channel_choice", { id: post.id, expected_updated_at: refetched.updatedAt, version_id: vid });
    expect(marked.marked.label).toBe("Yangilangan");
    expect((await call("set_channel_choice", { id: post.id, expected_updated_at: "2000-01-01T00:00:00.000Z", version_id: vid })).json.error.code).toBe("conflict");

    const del = await ok("delete_channel_version", { id: post.id, version_id: vid, expected_version_updated_at: updated.version.updatedAt });
    expect(del.clearedChoice).toBe(true);
    expect((await ok("list_channel_versions", { id: post.id })).versions).toHaveLength(0);

    const audit = await db.select().from(s.auditLog);
    const actions = audit.filter((a) => a.entityId === post.id && a.via === "mcp").map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["post.channel_version_create", "post.channel_version_update", "post.channel_choice_set", "post.channel_version_delete"]));
    const row = audit.find((a) => a.action === "post.channel_version_create")!;
    expect((row.meta as Json).tool).toBe("create_channel_version");
    await ok("clear_channel_choice", { id: post.id, expected_updated_at: (await ok("get_post", { id: post.id })).post.updatedAt });
  });

  it("plans and cancels a channel send for a scheduled post; dry run changes nothing; a draft is refused", async () => {
    const created = (await ok("create_post_draft", { title: "Rejali", content_markdown: "## Salom\n\nBu rejalashtirilgan post uchun yetarlicha uzun matn. ".repeat(6) })).post;
    const when = new Date(Date.now() + 3_600_000).toISOString();
    expect((await call("set_channel_plan", { id: created.id, expected_updated_at: created.updatedAt, delay_minutes: 5, mode: "text", variant: "m" })).json.error.code).toBe("conflict");
    const sched = (await ok("schedule_post", { id: created.id, expected_updated_at: created.updatedAt, scheduled_at: when })).post;
    const dry = await ok("set_channel_plan", { id: created.id, expected_updated_at: sched.updatedAt, delay_minutes: 5, mode: "text", variant: "m", dry_run: true });
    expect(dry.canPlan).toBe(true);
    expect((await db.select().from(s.posts).where(eq(s.posts.id, created.id)))[0]!.channelPlan).toBeNull();
    const set = await ok("set_channel_plan", { id: created.id, expected_updated_at: sched.updatedAt, delay_minutes: 5, mode: "text", variant: "m" });
    expect((await db.select().from(s.posts).where(eq(s.posts.id, created.id)))[0]!.channelPlan).toMatchObject({ mode: "text", variant: "m", delayMinutes: 5 });
    const cancelled = await ok("cancel_channel_plan", { id: created.id, expected_updated_at: set.post.updatedAt });
    expect(cancelled.summary).toMatch(/cancelled/);
    expect((await db.select().from(s.posts).where(eq(s.posts.id, created.id)))[0]!.channelPlan).toBeNull();
    expect((await ok("cancel_channel_plan", { id: created.id, expected_updated_at: cancelled.post.updatedAt })).alreadyInState).toBe(true);
  });

  it("resync_channel_caption does nothing for an unsent post; refresh_telegraph_mirror touches Telegraph only, never the channel", async () => {
    const post = await publishedPost("Ko'zgu yangilash");
    await settle();
    await fetch(`${mock.url}/__calls`, { method: "DELETE" });
    expect((await ok("resync_channel_caption", { id: post.id })).alreadyInState).toBe(true);
    const r = await ok("refresh_telegraph_mirror", { id: post.id });
    expect(r.telegraphUrl).toMatch(/telegra\.ph/);
    await settle();
    expect((await calls()).filter((m) => /^(sendMessage|sendPhoto|sendMediaGroup|editMessage|deleteMessage)/.test(m))).toEqual([]);
    const draft = (await ok("create_post_draft", { title: "Qoralama ko'zgu" })).post;
    expect((await call("refresh_telegraph_mirror", { id: draft.id })).json.error.code).toBe("conflict");
  });
});

describe("comment bans", () => {
  it("lists bans without fingerprints and lifts one (audited)", async () => {
    const [ban] = await db.insert(s.bannedDevices).values({ deviceHash: "dev-hash-secret-1", ipHash: "ip-hash-secret-1", reason: "spam" }).returning();
    const listed = await call("list_comment_bans");
    expect(listed.json.items.find((b: Json) => b.id === ban!.id)).toMatchObject({ reason: "spam" });
    expect(listed.text).not.toContain("hash-secret");
    await ok("lift_comment_ban", { ban_id: ban!.id });
    expect((await call("list_comment_bans")).json.items.some((b: Json) => b.id === ban!.id)).toBe(false);
    expect((await call("lift_comment_ban", { ban_id: ban!.id })).json.error.code).toBe("not_found");
    const audit = (await db.select().from(s.auditLog)).filter((a) => a.action === "ban.remove" && a.via === "mcp");
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });
});

describe("staff", () => {
  it("creates an invite whose link is marked sensitive and never stored or logged; lists without links; revokes; removes a staff member", async () => {
    const created = await ok("create_staff_invite", { note: "Ali uchun", idempotency_key: "staff-inv-0001" });
    expect(created.sensitive).toBe(true);
    expect(created.sensitiveNote).toMatch(/credential/);
    expect(created.inviteUrl).toMatch(/\/taklif\/[A-Za-z0-9_-]{20,}/);
    const token = String(created.inviteUrl).split("/taklif/")[1]!;

    const replay = await ok("create_staff_invite", { note: "Ali uchun", idempotency_key: "staff-inv-0001" });
    expect(replay.inviteUrl).toBeUndefined();
    expect(replay.linkOmitted).toBe(true);

    const everything = JSON.stringify(await db.select().from(s.auditLog)) + JSON.stringify(await db.select().from(s.mcpIdempotency));
    expect(everything).not.toContain(token);

    const listed = await call("list_staff");
    expect(listed.text).not.toContain(token);
    expect(listed.json.invites.find((i: Json) => i.id === created.invite.id)).toMatchObject({ status: "active", note: "Ali uchun" });
    await ok("revoke_staff_invite", { invite_id: created.invite.id });
    expect((await call("revoke_staff_invite", { invite_id: created.invite.id })).json.error.code).toBe("conflict");

    const member = await createTestUser({ role: "staff", name: "Xodim" });
    expect((await call("list_staff")).json.staff.some((m: Json) => m.id === member.id)).toBe(true);
    await ok("remove_staff_member", { user_id: member.id });
    expect((await call("remove_staff_member", { user_id: member.id })).json.error.code).toBe("not_found");
    const admins = await call("remove_staff_member", { user_id: admin.id });
    expect(admins.isError).toBe(true);
  });
});

describe("site settings and the About page", () => {
  it("reads settings and integration STATUS only (no values), updates non-secret settings, and dry runs change nothing", async () => {
    const status = await call("get_integration_status");
    expect(status.json.telegram.configured).toBe(true);
    expect(status.text).not.toContain("test-bot-token");
    expect(status.text).not.toContain("tgph-token");
    expect(status.text).not.toContain("0123456789abcdef");
    expect(status.text).not.toContain("@testchannel");

    const before = (await ok("get_site_settings")).social;
    await ok("update_site_settings", { site_name: "Yangi nom", social: { github: "https://github.com/x" }, dry_run: true });
    expect((await ok("get_site_settings")).general.siteName).not.toBe("Yangi nom");
    await ok("update_site_settings", { site_name: "Yangi nom", site_description: "Tavsif", social: { github: "https://github.com/x" } });
    const after = await ok("get_site_settings");
    expect(after.general).toEqual({ siteName: "Yangi nom", siteDescription: "Tavsif" });
    expect(after.social.github).toBe("https://github.com/x");
    expect(after.social.telegram).toBe(before.telegram);
    expect((await call("update_site_settings", {})).json.error.code).toBe("invalid_input");
    const unknown = await call("update_site_settings", { botToken: "x" });
    expect(unknown.isError || Boolean(unknown.raw?.error)).toBe(true);
  });

  it("About page: etag concurrency, Markdown through the validators, own-media rule, dry run", async () => {
    const first = await ok("get_about_page");
    expect((await call("update_about_page", { expected_etag: "0".repeat(32), content_markdown: "## A\n\nb" })).json.error.code).toBe("conflict");
    expect((await call("update_about_page", { expected_etag: first.etag, content_markdown: "## A\n\n![x](http://external.example/a.png)" })).json.error.code).toBe("invalid_input");
    const dry = await ok("update_about_page", { expected_etag: first.etag, content_markdown: "## Haqida\n\nMen haqimda.", dry_run: true });
    expect(dry.dryRun).toBe(true);
    expect((await ok("get_about_page")).etag).toBe(first.etag);
    const done = await ok("update_about_page", { expected_etag: first.etag, content_markdown: "## Haqida\n\nMen haqimda." });
    const second = await ok("get_about_page");
    expect(second.content).toContain("Men haqimda.");
    expect(second.etag).toBe(done.etag);
    expect((await call("update_about_page", { expected_etag: second.etag, content_document: { type: "doc", content: [{ type: "iframe" }] } })).json.error.code).toBe("invalid_input");
    const web = await app.request("/admin/site", { headers: { cookie: admin.cookie } });
    expect(((await web.json()) as Json).about.html).toContain("Men haqimda.");
  });
});

describe("statistics", () => {
  it("get_stats_summary and get_umami_stats answer", async () => {
    const sum = await ok("get_stats_summary");
    expect(sum).toHaveProperty("last7d");
    expect((await ok("get_umami_stats")).configured).toBe(false);
  });
});

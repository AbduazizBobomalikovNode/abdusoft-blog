import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD, type TestUser } from "../../test/auth-test-helpers.js";
import { ALL_BLOG_SCOPES, API, authorize, callTool, connect, exchangeCode, mcpCall, type Json } from "../../test/mcp-harness.js";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_WRITE_TOOLS_ENABLED = "true";
  process.env.DISTRIBUTION_ENABLED = "true";
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
});

let app: Hono;
let admin: TestUser;
let full: string;
let readOnly: string;
let telegramOnly: string;
let socialOnly: string;
let db: typeof import("../../db/index.js").db;
let s: typeof import("../../db/schema.js");
let fx: typeof import("../distribution/service/fixtures.js");
let sup: typeof import("../distribution/service/test-support.js");
let env: typeof import("../distribution/service/env.js");
let runner: typeof import("../distribution/service/runner.js");
let mock: ReturnType<typeof import("../distribution/service/test-support.js").createPlatformMock>;
const NOW = new Date("2026-11-26T10:00:00Z");

const WRITE_NAMES = ["save_distribution_text", "send_distribution", "schedule_distribution", "cancel_distribution", "retry_distribution", "remove_distribution_from_platform"];
const READ_NAMES = ["list_distribution_channels", "preview_distribution", "list_post_distributions", "get_distribution_status"];

const call = (name: string, args: Record<string, unknown> = {}, t = full) => callTool(app, t, name, args);
const ok = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await call(name, args);
  expect(r.isError, `${name}: ${r.text}`).toBe(false);
  return r.json as Json;
};
const fails = async (name: string, args: Record<string, unknown>, code: string, t = full) => {
  const r = await call(name, args, t);
  expect(r.isError, `${name} should fail: ${r.text}`).toBe(true);
  expect(r.json.error.code, r.text).toBe(code);
  return r.json.error as Json;
};

/** Sxema darajasidagi (SDK) rad etish: `isError` true, har qanday xabar bilan. */
const rejected = async (name: string, args: Record<string, unknown>) => {
  const r = await call(name, args);
  expect(r.isError, `${name} should be rejected: ${r.text}`).toBe(true);
};

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  ({ db } = await import("../../db/index.js"));
  s = await import("../../db/schema.js");
  fx = await import("../distribution/service/fixtures.js");
  sup = await import("../distribution/service/test-support.js");
  env = await import("../distribution/service/env.js");
  runner = await import("../distribution/service/runner.js");
  const images = await import("../distribution/service/images.js");
  mock = sup.createPlatformMock();
  env.setDistributionFetch(mock.fetch);
  env.setDistributionClock(() => NOW);
  images.setSocialImageLoader((url) => sup.fakePreparedImage(url));
  admin = await createTestUser({ role: "admin" });
  const creds = { email: admin.email, password: TEST_USER_PASSWORD };
  // `social:post` — ijtimoiy tarmoqqa post chiqarishning ALOHIDA ruxsati (Telegram `channels:send`dan mustaqil).
  full = (await connect(app, creds, { scope: `${ALL_BLOG_SCOPES} social:post` })).tokens.access_token;
  telegramOnly = (await connect(app, creds, { scope: ALL_BLOG_SCOPES })).tokens.access_token; // channels:send BOR, social:post YO'Q
  socialOnly = (await connect(app, creds, { scope: "blog:read posts:publish social:post offline_access" })).tokens.access_token; // channels:send YO'Q
  readOnly = (await connect(app, { email: admin.email, password: TEST_USER_PASSWORD }, { scope: "blog:read offline_access" })).tokens.access_token;
  // Provayderlar maqola havolasi https bo'lishini talab qiladi; ulanish oqimi (localhost) tugagach veb-origin almashtiriladi.
  const { config } = await import("../../config.js");
  config.WEB_ORIGIN = "https://blog.example.test";
});

afterAll(() => {
  env.setDistributionFetch(null);
  env.setDistributionClock(null);
});

beforeEach(async () => {
  mock.reset();
  await fx.clearAll();
});

describe("registry", () => {
  it("lists the 4 read and 6 write distribution tools; nothing about connecting accounts, credentials or tokens", async () => {
    const tools = (await mcpCall(app, full, "tools/list")).body.result.tools as Json[];
    const names = tools.map((t) => t.name);
    for (const n of [...READ_NAMES, ...WRITE_NAMES]) expect(names).toContain(n);
    const dist = tools.filter((t) => [...READ_NAMES, ...WRITE_NAMES].includes(t.name));
    expect(dist.map((t) => t.name).filter((n) => /connect|credential|token|account|secret/i.test(n))).toEqual([]);
    for (const t of dist) {
      const props = Object.keys((t.inputSchema as Json).properties ?? {});
      expect(props.filter((p) => /token|secret|credential|client/i.test(p)), t.name).toEqual([]);
      expect((t.inputSchema as Json).additionalProperties, t.name).toBe(false);
    }
  });
  it("annotations: read tools are closed-world read-only; send/schedule/retry/remove act on the open (public) world", async () => {
    const tools = (await mcpCall(app, full, "tools/list")).body.result.tools as Json[];
    const by = (n: string) => tools.find((t) => t.name === n)!.annotations as Json;
    for (const n of READ_NAMES) expect(by(n), n).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    for (const n of ["send_distribution", "schedule_distribution", "retry_distribution", "remove_distribution_from_platform"]) expect(by(n).openWorldHint, n).toBe(true);
    expect(by("remove_distribution_from_platform").destructiveHint).toBe(true);
    expect(by("send_distribution").readOnlyHint).toBe(false);
    const send = tools.find((t) => t.name === "send_distribution")!;
    expect(send.description).toMatch(/PUBLIC INTERNET/);
    expect(send.description).toMatch(/EVERY TIME/);
    expect(send.description).toMatch(/Nothing is ever sent automatically/);
  });
  it("is gated by the write switch for write tools (read tools stay with the flag)", async () => {
    const { config } = await import("../../config.js");
    const { getTools } = await import("./tools/index.js");
    config.MCP_WRITE_TOOLS_ENABLED = false;
    try {
      const names = getTools().map((t) => t.name);
      for (const n of READ_NAMES) expect(names).toContain(n);
      for (const n of WRITE_NAMES) expect(names).not.toContain(n);
    } finally {
      config.MCP_WRITE_TOOLS_ENABLED = true;
    }
  });
});

describe("read tools", () => {
  it("list_distribution_channels: state per channel, Telegram read-only, no token fields", async () => {
    await fx.insertAccount("linkedin", NOW);
    const r = await call("list_distribution_channels");
    expect(r.isError).toBe(false);
    const j = r.json as Json;
    expect(j.autoPost).toBe(false);
    expect(j.channels.map((c: Json) => c.id)).toEqual(["linkedin", "x", "threads", "instagram", "github", "telegram"]);
    expect(j.channels[0]).toMatchObject({ connected: true, ready: true, account: { displayName: "Test Owner", tokenState: "ok" } });
    expect(j.channels[1]).toMatchObject({ connected: false, ready: false });
    expect(j.channels.at(-1)).toMatchObject({ id: "telegram", readOnly: true });
    for (const t of Object.values(sup.TOKENS)) expect(r.text).not.toContain(t);
    expect(r.text).not.toMatch(/accessToken|refreshToken|clientSecret/);
  });
  it("preview_distribution: text, platform-counted length, image, checks; read-only (nothing saved, no platform call)", async () => {
    const post = await fx.insertPost();
    await fx.insertAccount("x", NOW);
    const j = await ok("preview_distribution", { post_id: post.id, channel: "x", text: "Salom https://blog.example.test/x" });
    expect(j).toMatchObject({ canSend: true, limit: 280, unit: "weighted", length: 29 });
    expect(j.image.source).toBe("cover");
    expect(j.checks.some((c: Json) => c.message && c.status)).toBe(true);
    expect(j.untrusted).toBe(true);
    expect(j.untrustedFields).toContain("text");
    expect(await db.select().from(s.distributions)).toHaveLength(0);
    expect(mock.calls).toHaveLength(0);
    const over = await ok("preview_distribution", { post_id: post.id, channel: "x", text: "a".repeat(281) });
    expect(over.canSend).toBe(false);
  });
  it("list_post_distributions and get_distribution_status; needs_checking tells the assistant not to retry", async () => {
    const post = await fx.insertPost();
    const [d] = await db.insert(s.distributions).values({ postId: post.id, provider: "x", status: "needs_checking", lastErrorKind: "outcome_unknown", lastErrorMessage: "noaniq" }).returning();
    const list = await ok("list_post_distributions", { post_id: post.id });
    expect(list.distributions).toHaveLength(1);
    const st = await ok("get_distribution_status", { distribution_id: d!.id });
    expect(st.distribution.status).toBe("needs_checking");
    expect(st.needsHuman).toMatch(/owner must verify/);
    expect(st.untrusted).toBe(true);
    await fails("get_distribution_status", { distribution_id: "00000000-0000-4000-8000-000000000000" }, "not_found");
    await rejected("get_distribution_status", { distribution_id: "nope" });
  });
});

describe("permissions", () => {
  it("write tools need social:post (not the Telegram channels:send); read tools only blog:read", async () => {
    const post = await fx.insertPost();
    await ok("list_distribution_channels");
    expect((await call("list_distribution_channels", {}, readOnly)).isError).toBe(false);
    // Salohiyatsiz token: yozuv vositalari ro'yxatda ham yo'q, chaqirsa ham rad
    const r = await call("send_distribution", { post_id: post.id, channel: "x", expected_updated_at: post.updatedAt.toISOString() }, readOnly);
    expect(r.isError).toBe(true);
  });
});

describe("write tools", () => {
  async function ready(provider: "x" | "linkedin" = "x") {
    const post = await fx.insertPost();
    await fx.insertAccount(provider, NOW);
    return post;
  }

  it("send_distribution: strict inputs, expected_updated_at required, queued in the background (no platform call in the request), audit via mcp", async () => {
    const post = await ready();
    await rejected("send_distribution", { post_id: post.id, channel: "x" });
    await rejected("send_distribution", { post_id: post.id, channel: "x", expected_updated_at: post.updatedAt.toISOString(), surprise: 1 });
    await rejected("send_distribution", { post_id: post.id, channel: "myspace", expected_updated_at: post.updatedAt.toISOString() });
    await fails("send_distribution", { post_id: post.id, channel: "x", expected_updated_at: "2020-01-01T00:00:00.000Z" }, "conflict");
    const j = await ok("send_distribution", { post_id: post.id, channel: "x", expected_updated_at: post.updatedAt.toISOString(), text: "Assistent yozgan matn" });
    expect(j.distribution).toMatchObject({ status: "scheduled", text: "Assistent yozgan matn", createdVia: "mcp" });
    expect(j.summary).toMatch(/background/);
    expect(j.untrusted).toBe(true);
    expect(mock.calls).toHaveLength(0);
    const audit = (await db.select().from(s.auditLog).where(eq(s.auditLog.action, "distribution.send")))[0]!;
    expect(audit.via).toBe("mcp");
    expect(audit.meta).toMatchObject({ tool: "send_distribution" });
    expect((audit.meta as Json).client).toBeTruthy();
    // keyin scheduler yuboradi
    expect(await runner.runDistribution(j.distribution.id)).toBe("sent");
  });

  it("dry_run reports checks and what would happen; nothing queued, not counted by the limit", async () => {
    const post = await ready();
    const j = await ok("send_distribution", { post_id: post.id, channel: "x", expected_updated_at: post.updatedAt.toISOString(), dry_run: true });
    expect(j).toMatchObject({ dryRun: true, canSend: true });
    expect(j.wouldDo).toMatch(/publicly/);
    expect(await db.select().from(s.distributions)).toHaveLength(0);
    expect(await db.select().from(s.auditLog).where(eq(s.auditLog.action, "distribution.send"))).toHaveLength(0);
    const blocked = await ok("send_distribution", { post_id: post.id, channel: "linkedin", expected_updated_at: post.updatedAt.toISOString(), dry_run: true });
    expect(blocked.canSend).toBe(false);
    expect(blocked.failingChecks.length).toBeGreaterThan(0);
  });

  it("preflight failure: unprocessable with the checklist, nothing queued", async () => {
    const post = await fx.insertPost();
    const e = await fails("send_distribution", { post_id: post.id, channel: "linkedin", expected_updated_at: post.updatedAt.toISOString() }, "unprocessable");
    expect(e.failingChecks.length).toBeGreaterThan(0);
    expect(await db.select().from(s.distributions)).toHaveLength(0);
  });

  it("idempotency_key: the same call twice queues once; a different payload with the same key is rejected", async () => {
    const post = await ready();
    const args = { post_id: post.id, channel: "x", expected_updated_at: post.updatedAt.toISOString(), idempotency_key: "send-key-0001" };
    const a = await ok("send_distribution", args);
    const b = await ok("send_distribution", args);
    expect(b.idempotentReplay).toBe(true);
    expect(b.distribution.id).toBe(a.distribution.id);
    expect(await db.select().from(s.distributions)).toHaveLength(1);
    await fails("send_distribution", { ...args, text: "boshqa" }, "invalid_input");
  });

  it("only a published post; unknown post", async () => {
    const draft = await fx.insertPost({ status: "draft", publishedAt: null });
    await fx.insertAccount("x", NOW);
    await fails("send_distribution", { post_id: draft.id, channel: "x", expected_updated_at: draft.updatedAt.toISOString() }, "conflict");
    await fails("send_distribution", { post_id: "00000000-0000-4000-8000-000000000000", channel: "x", expected_updated_at: NOW.toISOString() }, "not_found");
  });

  it("schedule_distribution: needs a future time; cancel_distribution cancels; save_distribution_text keeps a draft", async () => {
    const post = await ready();
    const base = { post_id: post.id, channel: "x", expected_updated_at: post.updatedAt.toISOString() };
    await rejected("schedule_distribution", base);
    await fails("schedule_distribution", { ...base, scheduled_at: "2020-01-01T00:00:00Z" }, "invalid_input");
    const saved = await ok("save_distribution_text", { post_id: post.id, channel: "x", text: "qoralama matn" });
    expect(saved.distribution).toMatchObject({ status: "draft", text: "qoralama matn" });
    expect(saved.summary).toMatch(/Nothing was sent/);
    const sch = await ok("schedule_distribution", { ...base, scheduled_at: "2026-12-01T09:00:00+05:00" });
    expect(sch.distribution).toMatchObject({ status: "scheduled", scheduledAt: "2026-12-01T04:00:00.000Z", text: "qoralama matn" });
    const dry = await ok("cancel_distribution", { distribution_id: sch.distribution.id, dry_run: true });
    expect(dry.canCancel).toBe(true);
    const c = await ok("cancel_distribution", { distribution_id: sch.distribution.id });
    expect(c.distribution.status).toBe("cancelled");
    expect(mock.calls).toHaveLength(0);
  });

  it("retry_distribution works for failed (resumes) and REFUSES needs_checking", async () => {
    const post = await ready("linkedin");
    mock.use((c) => (c.path === "/rest/posts" && c.method === "POST" ? new Response("{}", { status: 403 }) : undefined));
    const q = await ok("send_distribution", { post_id: post.id, channel: "linkedin", expected_updated_at: post.updatedAt.toISOString() });
    await runner.runDistribution(q.distribution.id);
    const st = await ok("get_distribution_status", { distribution_id: q.distribution.id });
    expect(st.distribution).toMatchObject({ status: "failed", lastErrorKind: "permission_missing", canResume: true });
    expect((await ok("retry_distribution", { distribution_id: q.distribution.id, dry_run: true })).canRetry).toBe(true);
    const r = await ok("retry_distribution", { distribution_id: q.distribution.id });
    expect(r.distribution.status).toBe("scheduled");

    const post2 = await ready("linkedin");
    const [nc] = await db.insert(s.distributions).values({ postId: post2.id, provider: "x", status: "needs_checking" }).returning();
    const e = await fails("retry_distribution", { distribution_id: nc!.id }, "conflict");
    expect(e.message).toMatch(/needs-checking|«hal qilish»|tekshiring|avval/i);
  });

  it("remove_distribution_from_platform: destructive, only for sent posts, supported platforms", async () => {
    const post = await ready("linkedin");
    const q = await ok("send_distribution", { post_id: post.id, channel: "linkedin", expected_updated_at: post.updatedAt.toISOString() });
    await fails("remove_distribution_from_platform", { distribution_id: q.distribution.id }, "conflict");
    await runner.runDistribution(q.distribution.id);
    mock.calls.length = 0;
    const dry = await ok("remove_distribution_from_platform", { distribution_id: q.distribution.id, dry_run: true });
    expect(dry.dryRun).toBe(true);
    expect(mock.calls).toHaveLength(0);
    const r = await ok("remove_distribution_from_platform", { distribution_id: q.distribution.id });
    expect(r.distribution.status).toBe("cancelled");
    expect(mock.calls.map((c) => c.method)).toEqual(["DELETE"]);
  });

  it("write limits: the social-send limit counts distribution sends (dry runs excluded)", async () => {
    const { config } = await import("../../config.js");
    const before = config.MCP_WRITE_LIMIT_SOCIAL_SENDS_PER_DAY;
    config.MCP_WRITE_LIMIT_SOCIAL_SENDS_PER_DAY = 1;
    try {
      const p1 = await ready();
      const p2 = await fx.insertPost();
      await ok("send_distribution", { post_id: p1.id, channel: "x", expected_updated_at: p1.updatedAt.toISOString(), dry_run: true });
      await ok("send_distribution", { post_id: p1.id, channel: "x", expected_updated_at: p1.updatedAt.toISOString() });
      const e = await fails("send_distribution", { post_id: p2.id, channel: "x", expected_updated_at: p2.updatedAt.toISOString() }, "rate_limited");
      expect(e.limit.category).toBe("social");
      expect(e.hint).toContain("MCP_WRITE_LIMIT_SOCIAL_SENDS_PER_DAY");
    } finally {
      config.MCP_WRITE_LIMIT_SOCIAL_SENDS_PER_DAY = before;
    }
  });

  it("no tool output ever contains a token or secret", async () => {
    const post = await ready();
    const q = await call("send_distribution", { post_id: post.id, channel: "x", expected_updated_at: post.updatedAt.toISOString() });
    await runner.runDistribution((q.json as Json).distribution.id);
    const outputs = [q.text, (await call("list_distribution_channels")).text, (await call("list_post_distributions", { post_id: post.id })).text];
    for (const o of outputs) for (const t of Object.values(sup.TOKENS)) expect(o).not.toContain(t);
  });
});

describe("separate social-posting permission (social:post)", () => {
  async function ready(provider: "x" | "linkedin" = "x") {
    const post = await fx.insertPost();
    await fx.insertAccount(provider, NOW);
    return post;
  }
  const writeArgs = (postId: string, distId: string): Record<string, Record<string, unknown>> => ({
    save_distribution_text: { post_id: postId, channel: "x", text: "Salom" },
    send_distribution: { post_id: postId, channel: "x", expected_updated_at: new Date().toISOString() },
    schedule_distribution: { post_id: postId, channel: "x", expected_updated_at: new Date().toISOString(), scheduled_at: "2027-01-01T09:00:00+05:00" },
    cancel_distribution: { distribution_id: distId },
    retry_distribution: { distribution_id: distId },
    remove_distribution_from_platform: { distribution_id: distId },
  });

  it("a connection approved only for the Telegram channel (channels:send) cannot use ANY social write tool; nothing is created or contacted", async () => {
    const post = await ready();
    const [d] = await db.insert(s.distributions).values({ postId: post.id, provider: "x", status: "sent", externalId: "123", externalUrl: "https://x.com/a/status/123" }).returning();
    const before = await db.select().from(s.distributions);
    for (const name of WRITE_NAMES) {
      const e = await fails(name, writeArgs(post.id, d!.id)[name]!, "insufficient_scope", telegramOnly);
      expect(e.requiredScope, name).toBe("social:post");
      expect(e.grantedScopes, name).toContain("channels:send");
      expect(e.grantedScopes, name).not.toContain("social:post");
    }
    expect(await db.select().from(s.distributions)).toEqual(before);
    expect(mock.calls).toHaveLength(0);
  });

  it("the same Telegram-only connection still uses the read tools (blog:read) and Telegram's own tool keeps its permission", async () => {
    await ready();
    for (const n of READ_NAMES) {
      const r = await call(n, n === "list_distribution_channels" ? {} : n === "get_distribution_status" ? { distribution_id: "00000000-0000-4000-8000-000000000000" } : { post_id: "00000000-0000-4000-8000-000000000000", channel: "x" }, telegramOnly);
      expect(r.json?.error?.code, n).not.toBe("insufficient_scope");
      expect(r.text, n).not.toMatch(/requires the 'social:post'/);
    }
    // Telegram tomoni o'zgarmagan: send_to_channel hamon `channels:send`ni talab qiladi, social:post unga yetmaydi.
    const post = await fx.insertPost();
    const r = await call("send_to_channel", { id: post.id, expected_updated_at: post.updatedAt.toISOString() }, socialOnly);
    expect(r.json.error).toMatchObject({ code: "insufficient_scope", requiredScope: "channels:send" });
  });

  it("a connection with social:post but WITHOUT channels:send can post socially", async () => {
    const post = await ready();
    const j = (await call("send_distribution", { post_id: post.id, channel: "x", expected_updated_at: post.updatedAt.toISOString(), text: "Faqat ijtimoiy" }, socialOnly)).json as Json;
    expect(j.ok).toBe(true);
    expect(j.distribution).toMatchObject({ status: "scheduled", text: "Faqat ijtimoiy" });
    const who = (await call("whoami", {}, socialOnly)).json as Json;
    expect(who.grantedScopes.map((g: Json) => g.id)).toEqual(expect.arrayContaining(["social:post"]));
    expect(who.grantedScopes.map((g: Json) => g.id)).not.toContain("channels:send");
  });

  it("whoami: the permission has its own description; the social limit is reported (flag on)", async () => {
    const who = (await call("whoami")).json as Json;
    const social = who.grantedScopes.find((g: Json) => g.id === "social:post");
    expect(social.description).toMatch(/LinkedIn.*X.*Threads.*Instagram/s);
    expect(who.server.writeLimits).toMatchObject({ channelSendsPerDay: 10, socialPostsPerDay: 5 });
  });

  it("limits are separate: exhausting the Telegram channel limit does not block social sends, and social sends do not use up Telegram's", async () => {
    const { config } = await import("../../config.js");
    const { WRITE_LIMITS } = await import("./write-limits.js");
    expect(config.MCP_WRITE_LIMIT_CHANNEL_SENDS_PER_DAY).toBe(10);
    expect(config.MCP_WRITE_LIMIT_SOCIAL_SENDS_PER_DAY).toBe(5);
    expect(WRITE_LIMITS.social.envName).toBe("MCP_WRITE_LIMIT_SOCIAL_SENDS_PER_DAY");
    expect(WRITE_LIMITS.channel.actions).toEqual(["post.channel_send", "post.channel_replace"]);
    expect(WRITE_LIMITS.social.actions).toEqual(["distribution.send", "distribution.schedule", "distribution.retry"]);
    const beforeCh = config.MCP_WRITE_LIMIT_CHANNEL_SENDS_PER_DAY;
    const beforeSo = config.MCP_WRITE_LIMIT_SOCIAL_SENDS_PER_DAY;
    config.MCP_WRITE_LIMIT_CHANNEL_SENDS_PER_DAY = 1;
    config.MCP_WRITE_LIMIT_SOCIAL_SENDS_PER_DAY = 2;
    try {
      const posts = [await ready(), await fx.insertPost(), await fx.insertPost()];
      // Telegram limiti 1 bo'lsa ham, ikkita ijtimoiy yuborish o'tadi (hisoblar alohida); uchinchisi ijtimoiy limitga uradi.
      await ok("send_distribution", { post_id: posts[0]!.id, channel: "x", expected_updated_at: posts[0]!.updatedAt.toISOString() });
      await ok("send_distribution", { post_id: posts[1]!.id, channel: "x", expected_updated_at: posts[1]!.updatedAt.toISOString() });
      const e = await fails("send_distribution", { post_id: posts[2]!.id, channel: "x", expected_updated_at: posts[2]!.updatedAt.toISOString() }, "rate_limited");
      expect(e.limit).toMatchObject({ category: "social", max: 2, used: 2 });
    } finally {
      config.MCP_WRITE_LIMIT_CHANNEL_SENDS_PER_DAY = beforeCh;
      config.MCP_WRITE_LIMIT_SOCIAL_SENDS_PER_DAY = beforeSo;
    }
  });

  it("asking for social:post later forces a fresh consent (a Telegram-only approval does not cover it) and it is not pre-ticked-by-default server side", async () => {
    const creds = { email: admin.email, password: TEST_USER_PASSWORD };
    const first = await connect(app, creds, { scope: ALL_BLOG_SCOPES });
    expect(first.tokens.scope.split(" ")).not.toContain("social:post");
    const again = await authorize(app, { clientId: first.clientId, ...creds, scope: `${ALL_BLOG_SCOPES} social:post`, browser: first.authorize.browser, stopAtConsent: true });
    expect(again.steps).toContain("consent-page");
    expect(again.consentUrl).toContain("social%3Apost");
    // Ruxsat berilganda ham faqat tanlangani beriladi:
    const picked = await authorize(app, { clientId: first.clientId, ...creds, scope: `${ALL_BLOG_SCOPES} social:post`, browser: first.authorize.browser, consentScope: "blog:read channels:send offline_access" });
    const tok = await exchangeCode(app, picked);
    expect(tok.body.scope.split(" ")).not.toContain("social:post");
    expect(tok.body.scope.split(" ")).toContain("channels:send");
  });

  it("is advertised in discovery and in the 401 challenge when both switches are on", async () => {
    const meta = (await (await app.request(`${API}/.well-known/oauth-authorization-server/api/auth`)).json()) as Json;
    expect(meta.scopes_supported).toContain("social:post");
    expect(Object.keys(meta.scope_descriptions)).toContain("social:post");
    const ch = await mcpCall(app, undefined, "initialize");
    expect(ch.www).toContain("social:post");
  });
});

describe("untrusted-field labelling covers every platform-/third-party-originated string", () => {
  it("preview_distribution labels previouslySent.url and checks[].value (and the old fields)", async () => {
    const post = await fx.insertPost();
    await fx.insertAccount("x", NOW);
    await db.insert(s.distributions).values({ postId: post.id, provider: "x", status: "sent", externalId: "t9", externalUrl: "https://x.com/o/status/t9", sentAt: NOW });
    const j = await ok("preview_distribution", { post_id: post.id, channel: "x" });
    expect(j.previouslySent.url).toBe("https://x.com/o/status/t9");
    expect(j.checks.some((c: Json) => c.value === "https://x.com/o/status/t9")).toBe(true); // "Avval yuborilgan" tekshiruvi qiymati
    expect(j.untrusted).toBe(true);
    expect(j.untrustedFields).toEqual(expect.arrayContaining(["post.title", "text", "defaultText", "checks[].value", "previouslySent.url", "distribution.text", "distribution.lastErrorMessage"]));
  });
});

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { startMockTelegram } from "../../scripts/mock-telegram.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { posts, telegramRefs } from "../db/schema.js";
import { publishDuePosts } from "../lib/scheduler.js";
import { uploadsDir } from "../lib/media/store.js";
import { invalidateSettingsCache, saveSettings } from "../lib/settings.js";
import { reconfigureBot } from "../telegram/client.js";
import { recoverInterruptedChannelSends, runDueChannelSends } from "../telegram/channel-plan.js";
import { sendPostToChannel } from "../telegram/channel-send.js";
import { registerTelegramPublishing } from "../telegram/publish.js";
import { createTestUser, type TestUser } from "../test/auth-test-helpers.js";
import { migrateTestDb } from "../test/migrate-test-db.js";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

let MOCK_ROOT = "";
let mockServer: { url: string; close: () => Promise<void> } | null = null;
let app: Hono;
let admin: TestUser;
let staff: TestUser;
let coverUrl = "";
let imageUrl = "";
let counter = 0;

type Call = { method: string; body: Record<string, unknown> };

async function mockCalls(): Promise<Call[]> {
  const res = await fetch(`${MOCK_ROOT}/__calls`);
  return ((await res.json()) as { calls: Call[] }).calls;
}
const sendCalls = (calls: Call[]) => calls.filter((c) => ["sendMessage", "sendPhoto", "sendMediaGroup"].includes(c.method));
const adminNotices = (calls: Call[], marker: string) =>
  calls.filter((c) => c.method === "sendMessage" && String(c.body.chat_id) === "777" && String(c.body.text).includes(marker));

async function req(urlPath: string, cookie: string, init: RequestInit = {}) {
  return app.request(urlPath, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie, ...(init.body ? { "content-type": "application/json" } : {}) },
  });
}
const send = (method: string, urlPath: string, cookie: string, body?: unknown) =>
  req(urlPath, cookie, { method, body: body !== undefined ? JSON.stringify(body) : undefined });

async function writeUpload(name: string): Promise<string> {
  const key = `test-plan/${name}`;
  const filePath = path.join(uploadsDir, key);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, TINY_PNG);
  return `${config.API_ORIGIN}/uploads/${key}`;
}

async function createPost(opts: { withMedia: boolean; createdBy?: string }): Promise<string> {
  counter += 1;
  const content: unknown[] = [{ type: "paragraph", content: [{ type: "text", text: "Kirish paragrafi." }] }];
  if (opts.withMedia) content.push({ type: "image", attrs: { src: imageUrl, alt: "rasm" } });
  const [row] = await db
    .insert(posts)
    .values({
      slug: `plan-test-${Date.now()}-${counter}`,
      title: `Reja sinovi ${counter}`,
      coverUrl: opts.withMedia ? coverUrl : null,
      contentJson: { type: "doc", content: content },
      contentHtml: "<p>Kirish paragrafi.</p>",
      contentText: "Kirish paragrafi.",
      toc: [],
      status: "draft",
      createdBy: opts.createdBy ?? null,
    })
    .returning();
  return row!.id;
}

const PAST = () => new Date(Date.now() - 60_000).toISOString();

async function schedule(id: string, channelPlan: unknown, when = PAST()) {
  return send("POST", `/admin/posts/${id}/schedule`, admin.cookie, { scheduledAt: when, channelPlan });
}
async function loadPost(id: string) {
  const [row] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
  return row!;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

beforeAll(async () => {
  mockServer = await startMockTelegram();
  MOCK_ROOT = mockServer.url;
  await migrateTestDb();
  ({ app } = await import("../app.js"));
  admin = await createTestUser({ role: "admin", name: "Admin" });
  staff = await createTestUser({ role: "staff", name: "Staff" });
  registerTelegramPublishing();

  delete process.env.TELEGRAM_API_ROOT;
  delete process.env.TELEGRAPH_ENABLED;
  delete process.env.SITE_NAME;
  invalidateSettingsCache();
  config.TELEGRAPH_API_ROOT = MOCK_ROOT;
  config.TELEGRAPH_ACCESS_TOKEN = "test-telegraph-token";

  await saveSettings({
    general: { siteName: "Sinov Sayt" },
    telegraph: { enabled: true },
    telegram: {
      botToken: "test-bot-token",
      webhookSecret: "0123456789abcdef",
      channelId: "@testchannel",
      adminChatId: "777",
      apiRoot: MOCK_ROOT,
    },
  });
  reconfigureBot("test-bot-token", MOCK_ROOT);

  coverUrl = await writeUpload("cover.png");
  imageUrl = await writeUpload("inline.png");
});

afterAll(async () => {
  await mockServer?.close();
  await rm(path.join(uploadsDir, "test-plan"), { recursive: true, force: true });
});

beforeEach(async () => {
  await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
  await fetch(`${MOCK_ROOT}/__fail`, { method: "POST", body: JSON.stringify({ method: "sendMessage", count: 0 }) });
});

describe("schedule with a channel plan", () => {
  it("stores the plan, publishes via the scheduler, mirrors to Telegraph FIRST, then sends exactly once", async () => {
    const id = await createPost({ withMedia: true });
    const res = await schedule(id, { mode: "media", variant: "m", delayMinutes: 0 });
    expect(res.status).toBe(200);
    expect((await loadPost(id)).channelPlan).toEqual({ mode: "media", variant: "m", delayMinutes: 0 });

    const detail = (await (await req(`/admin/posts/${id}`, admin.cookie)).json()) as { channelPlan: unknown };
    expect(detail.channelPlan).toEqual({ mode: "media", variant: "m", delayMinutes: 0 });

    await publishDuePosts();
    const afterPublish = await loadPost(id);
    expect(afterPublish.status).toBe("published");
    expect(afterPublish.channelSendAt).toBeTruthy();

    await runDueChannelSends();
    // ikkinchi tick — qayta yubormaydi
    await runDueChannelSends();
    await settle();

    const calls = await mockCalls();
    const sends = calls.filter((c) => c.method === "sendMediaGroup" || c.method === "sendPhoto");
    expect(sends.length).toBe(1);
    // Telegraph sahifasi kanal xabaridan OLDIN yaratilgan, muallif = sayt nomi, birinchi tugun = kover.
    const pageIdx = calls.findIndex((c) => c.method === "createPage");
    const sendIdx = calls.findIndex((c) => c.method === "sendMediaGroup" || c.method === "sendPhoto");
    expect(pageIdx).toBeGreaterThanOrEqual(0);
    expect(pageIdx).toBeLessThan(sendIdx);
    const page = calls[pageIdx]!.body as { author_name: string; author_url: string; content: { tag: string; children: { attrs: { src: string } }[] }[] };
    expect(page.author_name).toBe("Sinov Sayt");
    expect(page.author_url).toBe(config.WEB_ORIGIN);
    expect(page.content[0]!.tag).toBe("figure");
    expect(page.content[0]!.children[0]!.attrs.src).toBe(coverUrl);

    const done = await loadPost(id);
    expect(done.channelPlan).toBeNull();
    expect(done.channelSendAt).toBeNull();
    const [ref] = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, id));
    expect(ref?.channelMode).toBe("media");
    expect(ref?.channelVariant).toBe("m");
    expect(adminNotices(calls, "✅ Kanalga yuborildi").length).toBe(1);
  });

  it("respects the delay (not sent before due, sent once after)", async () => {
    const id = await createPost({ withMedia: false });
    await schedule(id, { mode: "text", variant: "l", delayMinutes: 30 });
    await publishDuePosts();
    const published = await loadPost(id);
    const expected = published.publishedAt!.getTime() + 30 * 60_000;
    expect(Math.abs(published.channelSendAt!.getTime() - expected)).toBeLessThan(1000);

    await runDueChannelSends();
    expect(sendCalls(await mockCalls()).length).toBe(0);

    await runDueChannelSends(new Date(Date.now() + 31 * 60_000));
    const sends = sendCalls(await mockCalls()).filter((c) => !String(c.body.text).includes("Kanalga yuborildi"));
    expect(sends.length).toBe(1);
    expect((await loadPost(id)).channelPlan).toBeNull();
  });

  it("re-queues a send that was claimed but interrupted by a restart, and sends it once", async () => {
    const id = await createPost({ withMedia: false });
    await schedule(id, { mode: "text", variant: "m", delayMinutes: 0 });
    await publishDuePosts();
    await settle();
    // Simulate a crash right after the atomic claim: plan kept, channel_send_at nulled.
    await db.update(posts).set({ channelSendAt: null }).where(eq(posts.id, id));
    await runDueChannelSends();
    expect(sendCalls(await mockCalls()).length).toBe(0);

    expect(await recoverInterruptedChannelSends()).toBeGreaterThanOrEqual(1);
    await runDueChannelSends();
    const sends = sendCalls(await mockCalls()).filter((c) => !String(c.body.text).includes("Kanalga yuborildi"));
    expect(sends.length).toBe(1);
    expect((await loadPost(id)).channelPlan).toBeNull();

    // Nothing left to recover afterwards.
    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    await recoverInterruptedChannelSends();
    await runDueChannelSends();
    expect(sendCalls(await mockCalls()).filter((c) => !String(c.body.text).includes("Kanalga yuborildi")).length).toBe(0);
  });

  it("does not double-send when the post is already in the channel (silently clears)", async () => {
    const id = await createPost({ withMedia: false });
    await schedule(id, { mode: "text", variant: "m", delayMinutes: 0 });
    await publishDuePosts();
    await settle();
    expect((await sendPostToChannel(id, "text", "s")).ok).toBe(true);
    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });

    await runDueChannelSends();
    const calls = await mockCalls();
    expect(sendCalls(calls).length).toBe(0);
    const done = await loadPost(id);
    expect(done.channelPlan).toBeNull();
    expect(done.channelSendAt).toBeNull();
  });

  it("falls back to text with the same variant when a media plan has no cover/images", async () => {
    const id = await createPost({ withMedia: false });
    await schedule(id, { mode: "media", variant: "m", delayMinutes: 0 });
    await publishDuePosts();
    await runDueChannelSends();
    await settle();

    const calls = await mockCalls();
    expect(calls.some((c) => c.method === "sendPhoto" || c.method === "sendMediaGroup")).toBe(false);
    const [ref] = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, id));
    expect(ref?.channelMode).toBe("text");
    expect(ref?.channelVariant).toBe("m");
    expect(adminNotices(calls, "✅ Kanalga yuborildi").length).toBe(1);
  });

  it("retries on following ticks and gives up after 5 failures with an admin notice", async () => {
    const id = await createPost({ withMedia: false });
    await schedule(id, { mode: "text", variant: "m", delayMinutes: 0 });
    await publishDuePosts();
    await settle();
    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    await fetch(`${MOCK_ROOT}/__fail`, { method: "POST", body: JSON.stringify({ method: "sendMessage", count: 5 }) });

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await runDueChannelSends();
      const row = await loadPost(id);
      expect((row.channelPlan as { attempts?: number }).attempts).toBe(attempt);
      expect(row.channelSendAt).toBeTruthy();
    }
    await runDueChannelSends();

    const done = await loadPost(id);
    expect(done.channelPlan).toBeNull();
    expect(done.channelSendAt).toBeNull();
    const calls = await mockCalls();
    expect(adminNotices(calls, "⚠️ Kanalga yuborilmadi").length).toBe(1);
    const [ref] = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, id));
    expect(ref?.channelSentAt ?? null).toBeNull();
  });
});

describe("channel plan validation, permissions and cleanup", () => {
  it("rejects an invalid mode/variant combination and an out-of-range delay", async () => {
    const id = await createPost({ withMedia: true });
    expect((await schedule(id, { mode: "media", variant: "s", delayMinutes: 0 })).status).toBe(400);
    expect((await schedule(id, { mode: "text", variant: "m", delayMinutes: 10081 })).status).toBe(400);
    expect((await schedule(id, { mode: "text", variant: "m", delayMinutes: -1 })).status).toBe(400);
  });

  it("scheduling without a plan (or null) stores no plan", async () => {
    const id = await createPost({ withMedia: false });
    expect((await schedule(id, null)).status).toBe(200);
    expect((await loadPost(id)).channelPlan).toBeNull();
    await publishDuePosts();
    expect((await loadPost(id)).channelSendAt).toBeNull();
    await runDueChannelSends();
    expect(sendCalls(await mockCalls()).length).toBe(0);
  });

  it("admin can set/clear the plan via PATCH on a scheduled post; staff cannot", async () => {
    const id = await createPost({ withMedia: true });
    await schedule(id, null, new Date(Date.now() + 3600_000).toISOString());

    const set = await send("PATCH", `/admin/posts/${id}`, admin.cookie, {
      channelPlan: { mode: "text", variant: "xl", delayMinutes: 15, attempts: 4 },
    });
    expect(set.status).toBe(200);
    expect((await loadPost(id)).channelPlan).toEqual({ mode: "text", variant: "xl", delayMinutes: 15 });

    const staffPostId = await createPost({ withMedia: false, createdBy: staff.id });
    const denied = await send("PATCH", `/admin/posts/${staffPostId}`, staff.cookie, {
      channelPlan: { mode: "text", variant: "m", delayMinutes: 0 },
    });
    expect(denied.status).toBe(403);
    expect((await loadPost(staffPostId)).channelPlan).toBeNull();

    const cleared = await send("PATCH", `/admin/posts/${id}`, admin.cookie, { channelPlan: null });
    expect(cleared.status).toBe(200);
    expect((await loadPost(id)).channelPlan).toBeNull();
  });

  it("PATCH cannot set a plan on a non-scheduled post (409)", async () => {
    const id = await createPost({ withMedia: false });
    const res = await send("PATCH", `/admin/posts/${id}`, admin.cookie, {
      channelPlan: { mode: "text", variant: "m", delayMinutes: 0 },
    });
    expect(res.status).toBe(409);
  });

  it("un-scheduling (scheduledAt: null) clears the plan; unpublish clears a pending channel_send_at", async () => {
    const id = await createPost({ withMedia: false });
    await schedule(id, { mode: "text", variant: "m", delayMinutes: 60 }, new Date(Date.now() + 3600_000).toISOString());
    await send("PATCH", `/admin/posts/${id}`, admin.cookie, { scheduledAt: null });
    expect((await loadPost(id)).channelPlan).toBeNull();

    const id2 = await createPost({ withMedia: false });
    await schedule(id2, { mode: "text", variant: "m", delayMinutes: 60 });
    await publishDuePosts();
    expect((await loadPost(id2)).channelSendAt).toBeTruthy();
    const res = await send("POST", `/admin/posts/${id2}/unpublish`, admin.cookie);
    expect(res.status).toBe(200);
    const row = await loadPost(id2);
    expect(row.channelPlan).toBeNull();
    expect(row.channelSendAt).toBeNull();
  });

  it("list items flag scheduled posts that have a channel plan", async () => {
    const id = await createPost({ withMedia: false });
    await schedule(id, { mode: "text", variant: "m", delayMinutes: 0 }, new Date(Date.now() + 3600_000).toISOString());
    const res = await req("/admin/posts?status=scheduled", admin.cookie);
    const body = (await res.json()) as { items: { id: string; hasChannelPlan: boolean }[] };
    expect(body.items.find((p) => p.id === id)?.hasChannelPlan).toBe(true);
  });
});

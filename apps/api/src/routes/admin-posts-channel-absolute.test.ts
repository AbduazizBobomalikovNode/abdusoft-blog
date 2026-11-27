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
import { runChannelPlanFor, runDueChannelSends, sendMarkedChoiceNow } from "../telegram/channel-plan.js";
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

async function req(urlPath: string, cookie: string, init: RequestInit = {}) {
  return app.request(urlPath, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie, ...(init.body ? { "content-type": "application/json" } : {}) },
  });
}
const send = (method: string, urlPath: string, cookie: string, body?: unknown) =>
  req(urlPath, cookie, { method, body: body !== undefined ? JSON.stringify(body) : undefined });

async function writeUpload(name: string): Promise<string> {
  const key = `test-abs/${name}`;
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
      slug: `abs-test-${Date.now()}-${counter}`,
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
  await rm(path.join(uploadsDir, "test-abs"), { recursive: true, force: true });
});

beforeEach(async () => {
  await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
  await fetch(`${MOCK_ROOT}/__fail`, { method: "POST", body: JSON.stringify({ method: "sendMessage", count: 0 }) });
});

const HOUR = 3_600_000;
const inH = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

/** Rejalashtirilgan postni "vaqti kelgan" qilib chop etadi (scheduler yo'li). */
async function publishViaScheduler(id: string) {
  await db.update(posts).set({ scheduledAt: new Date(Date.now() - 1000) }).where(eq(posts.id, id));
  await publishDuePosts();
}
/** Chop etilgan postni (rejasiz) tayyorlaydi. */
async function publishedPost(): Promise<string> {
  const id = await createPost({ withMedia: false });
  expect((await schedule(id, null, inH(1))).status).toBe(200);
  await publishViaScheduler(id);
  expect((await loadPost(id)).status).toBe("published");
  return id;
}
const putSchedule = (id: string, body: unknown, cookie = admin.cookie) => send("PUT", `/admin/posts/${id}/channel/schedule`, cookie, body);
async function wasSent(id: string): Promise<boolean> {
  const [ref] = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, id));
  return ref?.channelSentAt != null;
}
const textSends = async () => sendCalls(await mockCalls()).filter((c) => !String(c.body.text).includes("Kanalga yuborildi"));

describe("absolute channel time: scheduled posts", () => {
  it("stores sendAt (delay 0), keeps it on scheduled publish, sends exactly once at the due time", async () => {
    const id = await createPost({ withMedia: false });
    const sendAt = inH(3);
    const res = await schedule(id, { mode: "text", variant: "m", delayMinutes: 0, sendAt }, inH(1));
    expect(res.status).toBe(200);
    const stored = (await loadPost(id)).channelPlan as { sendAt?: string; delayMinutes: number };
    expect(stored.sendAt).toBe(new Date(sendAt).toISOString());
    expect(stored.delayMinutes).toBe(0);
    expect((await loadPost(id)).channelSendAt).toBeNull();

    await publishViaScheduler(id);
    const published = await loadPost(id);
    expect(published.channelSendAt?.toISOString()).toBe(new Date(sendAt).toISOString());

    await runDueChannelSends();
    expect((await textSends()).length).toBe(0);
    await runDueChannelSends(new Date(Date.now() + 4 * HOUR));
    await runDueChannelSends(new Date(Date.now() + 4 * HOUR));
    await settle();
    expect((await textSends()).length).toBe(1);
    const done = await loadPost(id);
    expect(done.channelPlan).toBeNull();
    expect(done.channelSendAt).toBeNull();
  });

  it("rejects sendAt before the publish time, in the past, beyond 1 year, and sendAt together with a delay", async () => {
    const id = await createPost({ withMedia: false });
    const base = { mode: "text", variant: "m", delayMinutes: 0 };
    expect((await schedule(id, { ...base, sendAt: inH(1) }, inH(2))).status).toBe(400); // yuborish chop etishdan oldin
    expect((await schedule(id, { ...base, sendAt: new Date(Date.now() - HOUR).toISOString() }, inH(-2))).status).toBe(400); // o'tgan
    expect((await schedule(id, { ...base, sendAt: inH(24 * 400) }, inH(1))).status).toBe(400); // 1 yildan uzoq
    expect((await schedule(id, { ...base, delayMinutes: 5, sendAt: inH(3) }, inH(1))).status).toBe(400); // ikkalasi
    expect((await loadPost(id)).status).toBe("draft");
  });

  it("PATCH validates sendAt against the scheduled time too", async () => {
    const id = await createPost({ withMedia: false });
    await schedule(id, null, inH(2));
    const bad = await send("PATCH", `/admin/posts/${id}`, admin.cookie, { channelPlan: { mode: "text", variant: "m", delayMinutes: 0, sendAt: inH(1) } });
    expect(bad.status).toBe(400);
    const good = await send("PATCH", `/admin/posts/${id}`, admin.cookie, { channelPlan: { mode: "text", variant: "m", delayMinutes: 0, sendAt: inH(5) } });
    expect(good.status).toBe(200);
    expect(((await loadPost(id)).channelPlan as { sendAt?: string }).sendAt).toBeTruthy();
  });

  it("manual publish keeps a FUTURE absolute plan (queued for sendAt) and now materialises a delay plan from the publish time", async () => {
    const abs = await createPost({ withMedia: false });
    const sendAt = inH(5);
    await schedule(abs, { mode: "text", variant: "m", delayMinutes: 0, sendAt }, inH(1));
    expect((await send("POST", `/admin/posts/${abs}/publish`, admin.cookie)).status).toBe(200);
    const kept = await loadPost(abs);
    expect(kept.status).toBe("published");
    expect(kept.channelSendAt?.toISOString()).toBe(new Date(sendAt).toISOString());
    expect((kept.channelPlan as { sendAt?: string }).sendAt).toBe(new Date(sendAt).toISOString());

    const delayed = await createPost({ withMedia: false });
    await schedule(delayed, { mode: "text", variant: "m", delayMinutes: 30 }, inH(1));
    const before = Date.now();
    await send("POST", `/admin/posts/${delayed}/publish`, admin.cookie);
    const armed = await loadPost(delayed);
    expect(armed.channelPlan).toMatchObject({ delayMinutes: 30 });
    expect(armed.channelSendAt!.getTime()).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(armed.channelSendAt!.getTime()).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
    // Keyingi testlarga ta'sir qilmasligi uchun navbatni tozalaymiz.
    await db.update(posts).set({ channelPlan: null, channelSendAt: null }).where(eq(posts.id, delayed));
    await db.update(posts).set({ channelPlan: null, channelSendAt: null }).where(eq(posts.id, abs));

    // O'tib ketgan aniq vaqt (masalan rejalashtirish uzoq kutgan) — darhol yuborilmaydi, reja bekor.
    const stale = await createPost({ withMedia: false });
    await schedule(stale, { mode: "text", variant: "m", delayMinutes: 0, sendAt: inH(5) }, inH(1));
    await db.update(posts).set({ channelPlan: { mode: "text", variant: "m", delayMinutes: 0, sendAt: new Date(Date.now() - HOUR).toISOString() } }).where(eq(posts.id, stale));
    await send("POST", `/admin/posts/${stale}/publish`, admin.cookie);
    expect((await loadPost(stale)).channelPlan).toBeNull();
  });

  it("unpublish KEEPS an absolute plan (send_at removed from the queue)", async () => {
    const id = await createPost({ withMedia: false });
    await schedule(id, { mode: "text", variant: "m", delayMinutes: 0, sendAt: inH(5) }, inH(1));
    await send("POST", `/admin/posts/${id}/publish`, admin.cookie);
    expect((await send("POST", `/admin/posts/${id}/unpublish`, admin.cookie)).status).toBe(200);
    const row = await loadPost(id);
    expect((row.channelPlan as { sendAt?: string }).sendAt).toBeTruthy();
    expect(row.channelSendAt).toBeNull();
  });
});

describe("absolute channel time: published posts (PUT/DELETE /channel/schedule)", () => {
  it("sets channel_send_at + plan, reports status, sends once at due time, then reports sent", async () => {
    const id = await publishedPost();
    const sendAt = inH(2);
    const res = await putSchedule(id, { sendAt, mode: "text", variant: "m" });
    expect(res.status).toBe(200);
    const row = await loadPost(id);
    expect(row.channelSendAt?.toISOString()).toBe(new Date(sendAt).toISOString());
    expect((row.channelPlan as { sendAt?: string; delayMinutes: number }).sendAt).toBe(new Date(sendAt).toISOString());

    const planned = (await (await req(`/admin/posts/${id}/channel/status`, admin.cookie)).json()) as { state: string; plan: { kind: string } | null; sendAt: string | null };
    expect(planned.state).toBe("planned");
    expect(planned.plan?.kind).toBe("at");
    expect(planned.sendAt).toBe(new Date(sendAt).toISOString());

    await runDueChannelSends();
    expect((await textSends()).length).toBe(0);
    const due = new Date(Date.now() + 3 * HOUR);
    await runDueChannelSends(due);
    await runDueChannelSends(due);
    await settle();
    expect((await textSends()).length).toBe(1);

    const sent = (await (await req(`/admin/posts/${id}/channel/status`, admin.cookie)).json()) as { state: string; sentAt: string | null; messageIds: number[]; plan: unknown };
    expect(sent.state).toBe("sent");
    expect(sent.sentAt).toBeTruthy();
    expect(sent.messageIds.length).toBeGreaterThan(0);
    expect(sent.plan).toBeNull();
  });

  it("defaults to the marked version (useChoice) when no selection is given", async () => {
    const id = await publishedPost();
    expect((await putSchedule(id, { sendAt: inH(2) })).status).toBe(200);
    expect((await loadPost(id)).channelPlan).toMatchObject({ useChoice: true, delayMinutes: 0 });
  });

  it("rejects a past time, a time over 1 year, and invalid bodies", async () => {
    const id = await publishedPost();
    expect((await putSchedule(id, { sendAt: new Date(Date.now() - 60_000).toISOString(), mode: "text", variant: "m" })).status).toBe(400);
    expect((await putSchedule(id, { sendAt: inH(24 * 400), mode: "text", variant: "m" })).status).toBe(400);
    expect((await putSchedule(id, { sendAt: "ertaga", mode: "text", variant: "m" })).status).toBe(400);
    expect((await loadPost(id)).channelSendAt).toBeNull();
  });

  it("rejects draft / scheduled posts (their plan is set with the schedule), unknown posts and staff", async () => {
    const draft = await createPost({ withMedia: false });
    expect((await putSchedule(draft, { sendAt: inH(2), mode: "text", variant: "m" })).status).toBe(409);
    await schedule(draft, null, inH(1));
    expect((await putSchedule(draft, { sendAt: inH(2), mode: "text", variant: "m" })).status).toBe(409);
    expect((await putSchedule("00000000-0000-4000-8000-000000000000", { sendAt: inH(2), mode: "text", variant: "m" })).status).toBe(404);
    const id = await publishedPost();
    expect((await putSchedule(id, { sendAt: inH(2), mode: "text", variant: "m" }, staff.cookie)).status).toBe(403);
  });

  it("rejects when the post was already sent to the channel (no double send)", async () => {
    const id = await publishedPost();
    expect((await sendPostToChannel(id, "text", "s")).ok).toBe(true);
    const res = await putSchedule(id, { sendAt: inH(2), mode: "text", variant: "m" });
    expect(res.status).toBe(409);
    const row = await loadPost(id);
    expect(row.channelPlan).toBeNull();
    expect(row.channelSendAt).toBeNull();
  });

  it("refuses to touch a send that is running right now (plan present, channel_send_at claimed)", async () => {
    const id = await publishedPost();
    await db.update(posts).set({ channelPlan: { useChoice: true, delayMinutes: 0 }, channelSendAt: null }).where(eq(posts.id, id));
    expect((await putSchedule(id, { sendAt: inH(2), mode: "text", variant: "m" })).status).toBe(409);
    expect((await send("DELETE", `/admin/posts/${id}/channel/schedule`, admin.cookie)).status).toBe(409);
    const status = (await (await req(`/admin/posts/${id}/channel/status`, admin.cookie)).json()) as { state: string };
    expect(status.state).toBe("sending");
  });

  it("replaces an earlier plan and DELETE cancels it (nothing is sent afterwards)", async () => {
    const id = await publishedPost();
    await putSchedule(id, { sendAt: inH(2), mode: "text", variant: "m" });
    const second = inH(4);
    expect((await putSchedule(id, { sendAt: second, mode: "text", variant: "l" })).status).toBe(200);
    expect((await loadPost(id)).channelSendAt?.toISOString()).toBe(new Date(second).toISOString());

    expect((await send("DELETE", `/admin/posts/${id}/channel/schedule`, admin.cookie)).status).toBe(200);
    const row = await loadPost(id);
    expect(row.channelPlan).toBeNull();
    expect(row.channelSendAt).toBeNull();
    await runDueChannelSends(new Date(Date.now() + 5 * HOUR));
    expect(await wasSent(id)).toBe(false);
    // Takroriy bekor qilish zararsiz.
    expect((await send("DELETE", `/admin/posts/${id}/channel/schedule`, admin.cookie)).status).toBe(200);
  });

  it("unpublish keeps the plan (no queued time) and a sweep afterwards sends nothing", async () => {
    const id = await publishedPost();
    await putSchedule(id, { sendAt: inH(2), mode: "text", variant: "m" });
    expect((await send("POST", `/admin/posts/${id}/unpublish`, admin.cookie)).status).toBe(200);
    const row = await loadPost(id);
    expect(row.channelPlan).not.toBeNull();
    expect(row.channelSendAt).toBeNull();
    await runDueChannelSends(new Date(Date.now() + 5 * HOUR));
    expect(await wasSent(id)).toBe(false);
  });

  it("preflight runs at send time: a plan whose preflight fails is retried, not sent", async () => {
    const id = await publishedPost();
    await putSchedule(id, { sendAt: inH(2), mode: "text", variant: "m" });
    await db.update(posts).set({ contentText: "" }).where(eq(posts.id, id));
    // Telegram yuborishi muvaffaqiyatsiz bo'lsa ham reja saqlanib, qayta uriniladi (mavjud ishchi xatti-harakati).
    await fetch(`${MOCK_ROOT}/__fail`, { method: "POST", body: JSON.stringify({ method: "sendMessage", count: 1 }) });
    await runDueChannelSends(new Date(Date.now() + 3 * HOUR));
    const row = await loadPost(id);
    expect((row.channelPlan as { attempts?: number } | null)?.attempts).toBe(1);
    expect((row.channelPlan as { sendAt?: string } | null)?.sendAt).toBeTruthy();
  });

  it("claim race: a row selected as due but rescheduled to the future is NOT sent early; it sends at the new time", async () => {
    const id = await publishedPost();
    await putSchedule(id, { sendAt: inH(1), mode: "text", variant: "m" });
    // Ishchi ro'yxatni "vaqti keldi" deb tanlagan paytga o'xshatamiz (now = +2h), so'ng admin kelajakka ko'chiradi.
    const selectedAt = new Date(Date.now() + 2 * HOUR);
    const later = inH(10);
    expect((await putSchedule(id, { sendAt: later, mode: "text", variant: "m" })).status).toBe(200);
    expect(await runChannelPlanFor(id, selectedAt)).toEqual({ state: "skipped" });
    expect(await wasSent(id)).toBe(false);
    const row = await loadPost(id);
    expect(row.channelSendAt?.toISOString()).toBe(new Date(later).toISOString());
    expect((await runChannelPlanFor(id, new Date(Date.now() + 11 * HOUR))).state).toBe("sent");
    expect(await wasSent(id)).toBe(true);
  });

  it("sendMarkedChoiceNow still claims (channel_send_at = now)", async () => {
    const id = await publishedPost();
    expect((await sendMarkedChoiceNow(id)).state).toBe("sent");
    expect(await wasSent(id)).toBe(true);
  });
});

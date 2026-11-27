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
import { previewChannelOnPublish, publishPost, schedulePost, updatePost } from "../lib/posts/index.js";
import type { Actor } from "../lib/posts/types.js";
import { recordChannelError } from "../telegram/channel-last-error.js";
import { sendPostToChannel } from "../telegram/channel-send.js";
import { CHANNEL_LAST_ERROR_MAX, sanitizeChannelError } from "../telegram/channel-last-error.js";
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
  const key = `test-surv/${name}`;
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
      slug: `surv-test-${Date.now()}-${counter}`,
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
  await rm(path.join(uploadsDir, "test-surv"), { recursive: true, force: true });
});

beforeEach(async () => {
  await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
  await fetch(`${MOCK_ROOT}/__fail`, { method: "POST", body: JSON.stringify({ method: "sendMessage", count: 0 }) });
});

const HOUR = 3_600_000;
const MIN = 60_000;
const inH = (h: number) => new Date(Date.now() + h * HOUR).toISOString();
const delayPlan = (delayMinutes: number) => ({ mode: "text", variant: "m", delayMinutes });
const publish = (id: string) => send("POST", `/admin/posts/${id}/publish`, admin.cookie);
const unpublish = (id: string) => send("POST", `/admin/posts/${id}/unpublish`, admin.cookie);
const statusOf = async (id: string) => (await (await req(`/admin/posts/${id}/channel/status`, admin.cookie)).json()) as {
  state: string;
  sendAt: string | null;
  lastError: { message: string; at: string | null } | null;
  plan: { kind: string; delayMinutes: number | null } | null;
};
const textSends = async () => sendCalls(await mockCalls()).filter((c) => !String(c.body.text).includes("Kanalga yuborildi"));
async function wasSent(id: string): Promise<boolean> {
  const [ref] = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, id));
  return ref?.channelSentAt != null;
}
/** Qoralamaga kechikishli reja qo'yadi (PATCH — web avtosaqlash yo'li). */
async function draftWithPlan(plan: unknown): Promise<string> {
  const id = await createPost({ withMedia: false });
  expect((await send("PATCH", `/admin/posts/${id}`, admin.cookie, { channelPlan: plan })).status).toBe(200);
  return id;
}
async function publishViaScheduler(id: string) {
  await db.update(posts).set({ scheduledAt: new Date(Date.now() - 1000) }).where(eq(posts.id, id));
  await publishDuePosts();
}
const near = (d: Date | null, expectedMs: number, slack = 30_000) => d !== null && Math.abs(d.getTime() - expectedMs) < slack;

describe("Telegram plan survives unpublish (parity with distribution plans)", () => {
  it("unpublish keeps the delay plan and nulls channel_send_at; re-publish arms it from the NEW publish time", async () => {
    const id = await draftWithPlan(delayPlan(30));
    expect((await publish(id)).status).toBe(200);
    const first = await loadPost(id);
    expect(near(first.channelSendAt, Date.now() + 30 * MIN)).toBe(true);

    expect((await unpublish(id)).status).toBe(200);
    const kept = await loadPost(id);
    expect(kept.status).toBe("draft");
    expect(kept.channelPlan).toMatchObject({ delayMinutes: 30 });
    expect(kept.channelSendAt).toBeNull();
    const st = await statusOf(id);
    expect(st.state).toBe("planned");
    expect(st.plan).toMatchObject({ kind: "delay", delayMinutes: 30 });

    // Vaqt o'tgan deb o'ylaymiz: eski publishedAt ancha oldin edi.
    await db.update(posts).set({ publishedAt: new Date(Date.now() - 5 * HOUR) }).where(eq(posts.id, id));
    expect((await publish(id)).status).toBe(200);
    const again = await loadPost(id);
    expect(again.channelPlan).toMatchObject({ delayMinutes: 30, attempts: 0 });
    expect(near(again.channelSendAt, Date.now() + 30 * MIN)).toBe(true); // eski publishedAt'dan emas, haqiqiy chop etishdan
    await runDueChannelSends();
    expect((await textSends()).length).toBe(0);
  });

  it("first manual publish of a draft with a delay plan now schedules the send (it used to wipe the plan)", async () => {
    const id = await draftWithPlan(delayPlan(10));
    await publish(id);
    const row = await loadPost(id);
    expect(row.channelPlan).toMatchObject({ delayMinutes: 10 });
    expect(near(row.channelSendAt, Date.now() + 10 * MIN)).toBe(true);
    await runDueChannelSends(new Date(Date.now() + 11 * MIN));
    await settle();
    expect((await textSends()).length).toBe(1);
    expect((await loadPost(id)).channelPlan).toBeNull();
  });

  it("approve-publish arms the plan too; scheduler publish arms it from the scheduler's publish time", async () => {
    const reviewed = await draftWithPlan(delayPlan(20));
    await db.update(posts).set({ status: "in_review" }).where(eq(posts.id, reviewed));
    expect((await send("POST", `/admin/posts/${reviewed}/approve`, admin.cookie)).status).toBe(200);
    expect(near((await loadPost(reviewed)).channelSendAt, Date.now() + 20 * MIN)).toBe(true);

    const scheduled = await createPost({ withMedia: false });
    expect((await schedule(scheduled, delayPlan(15), inH(1))).status).toBe(200);
    await publishViaScheduler(scheduled);
    expect(near((await loadPost(scheduled)).channelSendAt, Date.now() + 15 * MIN)).toBe(true);
  });

  it("absolute plans: a future sendAt is kept on manual re-publish; a past one is dropped on manual publish but kept (sent at once) by the scheduler", async () => {
    const future = inH(6);
    const id = await draftWithPlan({ ...delayPlan(0), sendAt: future });
    await publish(id);
    expect((await loadPost(id)).channelSendAt?.toISOString()).toBe(new Date(future).toISOString());
    await unpublish(id);
    const kept = await loadPost(id);
    expect(kept.channelSendAt).toBeNull();
    expect((kept.channelPlan as { sendAt?: string }).sendAt).toBe(new Date(future).toISOString());
    await publish(id);
    expect((await loadPost(id)).channelSendAt?.toISOString()).toBe(new Date(future).toISOString());

    // O'tgan aniq vaqt, QO'LDA chop etish: reja tashlanadi, darhol yuborilmaydi.
    const stale = await draftWithPlan({ ...delayPlan(0), sendAt: inH(6) });
    await db.update(posts).set({ channelPlan: { ...delayPlan(0), sendAt: new Date(Date.now() - HOUR).toISOString() } }).where(eq(posts.id, stale));
    await publish(stale);
    const dropped = await loadPost(stale);
    expect(dropped.channelPlan).toBeNull();
    expect(dropped.channelSendAt).toBeNull();

    // Scheduler (PR #37): kech chop etilsa — darhol yuboriladigan qilib qo'yiladi.
    const late = await createPost({ withMedia: false });
    await schedule(late, { ...delayPlan(0), sendAt: inH(6) }, inH(1));
    await db.update(posts).set({ channelPlan: { ...delayPlan(0), sendAt: new Date(Date.now() - HOUR).toISOString() } }).where(eq(posts.id, late));
    await publishViaScheduler(late);
    expect(near((await loadPost(late)).channelSendAt, Date.now())).toBe(true);
    for (const x of [id, late]) await db.update(posts).set({ channelPlan: null, channelSendAt: null }).where(eq(posts.id, x));
  });

  it("an already-sent post: publish clears the plan and nothing is sent twice", async () => {
    const id = await createPost({ withMedia: false });
    await publish(id);
    expect((await sendPostToChannel(id, "text", "m")).ok).toBe(true);
    await settle();
    const idsOf = async () => (await db.select().from(telegramRefs).where(eq(telegramRefs.postId, id)))[0]?.channelMessageIds;
    const idsBefore = await idsOf();
    expect(idsBefore?.length).toBeGreaterThan(0);
    // Qoralamaga qaytgan, lekin kanal xabari qolgan (masalan `channels:send`siz aktyor) + saqlangan reja.
    await db.update(posts).set({ status: "draft", channelPlan: delayPlan(0), channelSendAt: null }).where(eq(posts.id, id));
    expect(await wasSent(id)).toBe(true);
    await publish(id);
    const row = await loadPost(id);
    expect(row.channelPlan).toBeNull();
    expect(row.channelSendAt).toBeNull();
    await runDueChannelSends(new Date(Date.now() + HOUR));
    await settle();
    expect(await idsOf()).toEqual(idsBefore); // yangi xabar yuborilmadi
  });

  it("archive still clears the plan", async () => {
    const id = await draftWithPlan(delayPlan(30));
    await publish(id);
    expect((await send("POST", `/admin/posts/${id}/archive`, admin.cookie)).status).toBe(200);
    const row = await loadPost(id);
    expect(row.status).toBe("archived");
    expect(row.channelPlan).toBeNull();
    expect(row.channelSendAt).toBeNull();
  });

  it("recovery ignores a kept plan on an unpublished post and never fires a re-published post immediately", async () => {
    const id = await draftWithPlan(delayPlan(45));
    await publish(id);
    await unpublish(id);
    await recoverInterruptedChannelSends();
    const draft = await loadPost(id);
    expect(draft.status).toBe("draft");
    expect(draft.channelSendAt).toBeNull();

    await publish(id);
    const live = await loadPost(id);
    expect(near(live.channelSendAt, Date.now() + 45 * MIN)).toBe(true);
    await recoverInterruptedChannelSends(); // channel_send_at to'ldirilgan — tegilmaydi
    await runDueChannelSends();
    await settle();
    expect(await wasSent(id)).toBe(false);
    expect((await loadPost(id)).channelSendAt?.getTime()).toBe(live.channelSendAt?.getTime());
  });

  it("a send in flight (plan, send_at NULL) survives unpublish untouched: plan kept, worker does not run it", async () => {
    const id = await draftWithPlan(delayPlan(0));
    await publish(id);
    await db.update(posts).set({ channelSendAt: null }).where(eq(posts.id, id)); // ishchi claim qilgan
    expect((await statusOf(id)).state).toBe("sending");
    await unpublish(id);
    await runDueChannelSends(new Date(Date.now() + HOUR));
    expect(await wasSent(id)).toBe(false);
    const row = await loadPost(id);
    expect(row.status).toBe("draft");
    expect(row.channelPlan).not.toBeNull();
    expect(row.channelSendAt).toBeNull();
  });

  it("schedule without a plan keeps the saved plan; the web's explicit null still clears it", async () => {
    const id = await draftWithPlan(delayPlan(25));
    expect((await send("POST", `/admin/posts/${id}/schedule`, admin.cookie, { scheduledAt: inH(2) })).status).toBe(200);
    expect((await loadPost(id)).channelPlan).toMatchObject({ delayMinutes: 25 });
    expect((await schedule(id, null, inH(3))).status).toBe(200);
    expect((await loadPost(id)).channelPlan).toBeNull();
  });
});

describe("last send error", () => {
  it("is recorded on each failed attempt, exposed by /channel/status, and cleared after a successful send", async () => {
    const id = await draftWithPlan(delayPlan(0));
    await publish(id);
    await fetch(`${MOCK_ROOT}/__fail`, { method: "POST", body: JSON.stringify({ method: "sendMessage", count: 2 }) });
    await db.update(posts).set({ channelSendAt: new Date(Date.now() - 1000) }).where(eq(posts.id, id));

    await runDueChannelSends();
    let row = await loadPost(id);
    expect(row.channelLastError).toBeTruthy();
    expect(row.channelLastErrorAt).toBeInstanceOf(Date);
    expect((row.channelPlan as { attempts?: number }).attempts).toBe(1);
    let st = await statusOf(id);
    expect(st.state).toBe("planned");
    expect(st.lastError?.message).toBe(row.channelLastError);
    expect(st.lastError?.at).toBe(row.channelLastErrorAt!.toISOString());

    await runDueChannelSends();
    expect((await loadPost(id)).channelLastError).toBeTruthy();
    expect(((await loadPost(id)).channelPlan as { attempts?: number }).attempts).toBe(2);

    await runDueChannelSends(); // endi muvaffaqiyatli
    await settle();
    row = await loadPost(id);
    expect(row.channelLastError).toBeNull();
    expect(row.channelLastErrorAt).toBeNull();
    expect(row.channelPlan).toBeNull();
    st = await statusOf(id);
    expect(st.state).toBe("sent");
    expect(st.lastError).toBeNull();
  });

  it("final give-up keeps the error visible (nothing pending) and a manual cancel clears it", async () => {
    const id = await draftWithPlan(delayPlan(0));
    await publish(id);
    await fetch(`${MOCK_ROOT}/__fail`, { method: "POST", body: JSON.stringify({ method: "sendMessage", count: 50 }) });
    await db.update(posts).set({ channelPlan: { ...delayPlan(0), attempts: 4 }, channelSendAt: new Date(Date.now() - 1000) }).where(eq(posts.id, id));
    await runDueChannelSends();
    const row = await loadPost(id);
    expect(row.channelPlan).toBeNull();
    expect(row.channelLastError).toBeTruthy();
    const st = await statusOf(id);
    expect(st.state).toBe("none");
    expect(st.lastError).not.toBeNull();
    await fetch(`${MOCK_ROOT}/__fail`, { method: "POST", body: JSON.stringify({ method: "sendMessage", count: 0 }) });

    await db.update(posts).set({ channelPlan: delayPlan(0), channelSendAt: new Date(Date.now() + HOUR) }).where(eq(posts.id, id));
    expect((await send("DELETE", `/admin/posts/${id}/channel/schedule`, admin.cookie)).status).toBe(200);
    expect((await loadPost(id)).channelLastError).toBeNull();
  });

  it("a failed MANUAL send is recorded too", async () => {
    const id = await createPost({ withMedia: false });
    await publish(id);
    await fetch(`${MOCK_ROOT}/__fail`, { method: "POST", body: JSON.stringify({ method: "sendMessage", count: 1 }) });
    const res = await send("POST", `/admin/posts/${id}/channel/send`, admin.cookie, { mode: "text", variant: "m" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await loadPost(id)).channelLastError).toBeTruthy();
    // Keyingi muvaffaqiyatli qo'lda yuborish tozalaydi.
    expect((await send("POST", `/admin/posts/${id}/channel/send`, admin.cookie, { mode: "text", variant: "m" })).status).toBe(200);
    expect((await loadPost(id)).channelLastError).toBeNull();
  });

  it("sanitizeChannelError hides tokens, collapses whitespace and caps the length", () => {
    const token = "123456789:AAEhBOweik6ad9r_QXMENQjcrTu-oQE8Gi";
    const out = sanitizeChannelError(new Error(`Call to https://api.telegram.org/bot${token}/sendMessage failed\n\n  Bearer abc.def-123-abc.def-123 token=xyz Basic auth failed token: expired`));
    expect(out).not.toContain(token);
    expect(out).not.toContain("abc.def-123-abc.def-123");
    expect(out).toContain("Basic auth failed"); // oddiy matn qirqilmaydi
    expect(out).toContain("token: expired");
    expect(out).not.toContain("xyz");
    expect(out).not.toMatch(/\s{2,}/);
    expect(sanitizeChannelError("x".repeat(2000)).length).toBe(CHANNEL_LAST_ERROR_MAX);
    const emoji = Array.from(sanitizeChannelError("😀".repeat(900)));
    expect(emoji.length).toBe(CHANNEL_LAST_ERROR_MAX); // Unicode belgi bo'yicha, juft surrogat bo'linmaydi
    expect(emoji.slice(0, -1).every((c) => c === "😀")).toBe(true);
    expect(sanitizeChannelError("   ")).toBe("Noma'lum xato");
    expect(sanitizeChannelError("password: hunter2 secret: abc123 api_key: k authorization: x")).toBe("password: [yashirildi] secret: [yashirildi] api_key: [yashirildi] authorization: [yashirildi]");
    expect(sanitizeChannelError("password=hunter2")).toBe("password=[yashirildi]");
  });
});

const mcpActor = (channelsSend: boolean): Actor => ({ userId: admin.id, role: "admin", via: "mcp", mcp: { clientId: "c", clientName: "t", tool: "t", channelsSend } });

describe("channel permission and publish result", () => {
  it("setting/changing a plan needs channels:send (PATCH service and schedule); omitted plan and clearing are fine", async () => {
    const id = await createPost({ withMedia: false });
    const denied = await updatePost(mcpActor(false), id, { channelPlan: delayPlan(5) as never });
    expect(denied.ok).toBe(false);
    expect((await loadPost(id)).channelPlan).toBeNull();
    const deniedSchedule = await schedulePost(mcpActor(false), id, { scheduledAt: inH(2), channelPlan: delayPlan(5) as never });
    expect(deniedSchedule.ok).toBe(false);
    expect((await loadPost(id)).status).toBe("draft");
    expect((await updatePost(mcpActor(true), id, { channelPlan: delayPlan(5) as never })).ok).toBe(true);
    expect((await updatePost(mcpActor(false), id, { title: "Yangi sarlavha" })).ok).toBe(true); // reja berilmagan — tegilmaydi
    expect((await loadPost(id)).channelPlan).toMatchObject({ delayMinutes: 5 });
    expect((await schedulePost(mcpActor(false), id, { scheduledAt: inH(2) })).ok).toBe(true); // omitted = keep
    expect((await loadPost(id)).channelPlan).toMatchObject({ delayMinutes: 5 });
    expect((await updatePost(mcpActor(false), id, { channelPlan: null })).ok).toBe(true);
    expect((await loadPost(id)).channelPlan).toBeNull();
  });

  it("publish by an actor without channels:send drops the plan (never plan + NULL send_at on a published post) and says so", async () => {
    const id = await draftWithPlan(delayPlan(10));
    const preview = await previewChannelOnPublish(mcpActor(false), await loadPost(id));
    expect(preview).toEqual({ state: "dropped", reason: "no_permission" });
    expect((await loadPost(id)).channelPlan).not.toBeNull(); // dry-run hech narsa yozmaydi
    const res = await publishPost(mcpActor(false), id);
    expect(res.ok && res.data.channel).toEqual({ state: "dropped", reason: "no_permission" });
    const row = await loadPost(id);
    expect(row.status).toBe("published");
    expect(row.channelPlan).toBeNull();
    expect(row.channelSendAt).toBeNull();
    await recoverInterruptedChannelSends();
    expect((await loadPost(id)).channelSendAt).toBeNull();
  });

  it("HTTP publish and approve return channel: armed / dropped; dry-run preview matches", async () => {
    const id = await draftWithPlan(delayPlan(10));
    const body = (await (await publish(id)).json()) as { channel: { state: string; at?: string } };
    expect(body.channel.state).toBe("armed");
    expect(near(new Date(body.channel.at!), Date.now() + 10 * MIN)).toBe(true);

    const past = await draftWithPlan(delayPlan(10));
    await db.update(posts).set({ channelPlan: { ...delayPlan(0), sendAt: new Date(Date.now() - HOUR).toISOString() } }).where(eq(posts.id, past));
    expect(((await (await publish(past)).json()) as { channel: unknown }).channel).toEqual({ state: "dropped", reason: "past_time" });

    const reviewed = await draftWithPlan(delayPlan(20));
    await db.update(posts).set({ status: "in_review" }).where(eq(posts.id, reviewed));
    const approved = (await (await send("POST", `/admin/posts/${reviewed}/approve`, admin.cookie)).json()) as { channel: { state: string } };
    expect(approved.channel.state).toBe("armed");

    const none = await createPost({ withMedia: false });
    expect(((await (await publish(none)).json()) as { channel: unknown }).channel).toEqual({ state: "none" });
  });

  it("unpublish and archive clear the last error; a failure recorded for an unpublished post is ignored", async () => {
    const id = await draftWithPlan(delayPlan(10));
    await publish(id);
    await db.update(posts).set({ channelLastError: "xato", channelLastErrorAt: new Date() }).where(eq(posts.id, id));
    await unpublish(id);
    expect((await loadPost(id)).channelLastError).toBeNull();
    await recordChannelError(id, "kech xato", new Date(), { onlyIfPublished: true }); // post qoralama — yozilmaydi
    expect((await loadPost(id)).channelLastError).toBeNull();
    await publish(id);
    await db.update(posts).set({ channelLastError: "xato", channelLastErrorAt: new Date() }).where(eq(posts.id, id));
    await send("POST", `/admin/posts/${id}/archive`, admin.cookie);
    expect((await loadPost(id)).channelLastError).toBeNull();
  });

});

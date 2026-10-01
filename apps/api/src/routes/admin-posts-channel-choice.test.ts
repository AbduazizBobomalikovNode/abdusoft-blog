import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { ChannelPreflightResponse, ChannelVersion, ResolvedChannelChoice } from "@blog/shared";
import { startMockTelegram } from "../../scripts/mock-telegram.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { channelPostVersions, posts, telegramRefs } from "../db/schema.js";
import { publishDuePosts } from "../lib/scheduler.js";
import { uploadsDir } from "../lib/media/store.js";
import { invalidateSettingsCache, saveSettings } from "../lib/settings.js";
import { reconfigureBot } from "../telegram/client.js";
import { runDueChannelSends } from "../telegram/channel-plan.js";
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
let staffA: TestUser;
let staffB: TestUser;
let coverUrl = "";
let counter = 0;

type Call = { method: string; body: Record<string, unknown> };
async function mockCalls(): Promise<Call[]> {
  return ((await (await fetch(`${MOCK_ROOT}/__calls`)).json()) as { calls: Call[] }).calls;
}
/** Haqiqiy kanalga (`@testchan`) ketgan yuborishlar. */
const channelSends = (calls: Call[]) =>
  calls.filter((c) => ["sendMessage", "sendPhoto", "sendMediaGroup"].includes(c.method) && String(c.body.chat_id) === "@testchan");
const adminNotices = (calls: Call[], marker: string) =>
  calls.filter((c) => c.method === "sendMessage" && String(c.body.chat_id) === "777" && String(c.body.text).includes(marker));

async function api(method: string, urlPath: string, cookie: string | null, body?: unknown) {
  return app.request(urlPath, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function writeUpload(name: string): Promise<string> {
  const key = `test-choice/${name}`;
  const filePath = path.join(uploadsDir, key);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, TINY_PNG);
  return `${config.API_ORIGIN}/uploads/${key}`;
}

async function makePost(opts: { withMedia?: boolean; createdBy?: string; status?: "draft" | "in_review" | "changes_requested" | "published" } = {}): Promise<string> {
  counter += 1;
  const [row] = await db
    .insert(posts)
    .values({
      slug: `choice-test-${Date.now()}-${counter}`,
      title: `Belgi sinovi ${counter}`,
      coverUrl: opts.withMedia ? coverUrl : null,
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Kirish paragrafi." }] }] },
      contentHtml: "<p>Kirish paragrafi.</p>",
      contentText: "Kirish paragrafi.",
      toc: [],
      status: opts.status ?? "draft",
      publishedAt: opts.status === "published" ? new Date() : null,
      createdBy: opts.createdBy ?? null,
    })
    .returning();
  return row!.id;
}
async function loadPost(id: string) {
  const [row] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
  return row!;
}
async function loadRef(id: string) {
  const [row] = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, id)).limit(1);
  return row;
}
async function mkVersion(cookie: string, postId: string, body: Record<string, unknown> = { mode: "text", fromVariant: "m" }): Promise<ChannelVersion> {
  const res = await api("POST", `/admin/posts/${postId}/channel/versions`, cookie, body);
  expect(res.status).toBe(201);
  return json<ChannelVersion>(res);
}
const mark = (cookie: string, postId: string, body: unknown) => api("PUT", `/admin/posts/${postId}/channel/choice`, cookie, body);
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
const PAST = () => new Date(Date.now() - 60_000).toISOString();

beforeAll(async () => {
  mockServer = await startMockTelegram();
  MOCK_ROOT = mockServer.url;
  await migrateTestDb();
  ({ app } = await import("../app.js"));
  admin = await createTestUser({ role: "admin", name: "Admin" });
  staffA = await createTestUser({ role: "staff", name: "Xodim A" });
  staffB = await createTestUser({ role: "staff", name: "Xodim B" });
  registerTelegramPublishing();

  delete process.env.TELEGRAM_API_ROOT;
  delete process.env.TELEGRAPH_ENABLED;
  invalidateSettingsCache();
  config.TELEGRAPH_API_ROOT = MOCK_ROOT;
  config.TELEGRAPH_ACCESS_TOKEN = "test-telegraph-token";

  await saveSettings({
    general: { siteName: "Sinov Sayt" },
    telegraph: { enabled: true },
    telegram: {
      botToken: "test-bot-token",
      webhookSecret: "0123456789abcdef",
      channelId: "@testchan",
      adminChatId: "777",
      apiRoot: MOCK_ROOT,
    },
  });
  reconfigureBot("test-bot-token", MOCK_ROOT);
  coverUrl = await writeUpload("cover.png");
});

afterAll(async () => {
  await mockServer?.close();
  await rm(path.join(uploadsDir, "test-choice"), { recursive: true, force: true });
});

beforeEach(async () => {
  await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
  await fetch(`${MOCK_ROOT}/__fail`, { method: "POST", body: JSON.stringify({ method: "sendMessage", count: 0 }) });
});

describe("prepare mode — an unpublished post can prepare versions", () => {
  it("version CRUD, preview and preflight work on a draft; forPlan preflight has no 'published' error", async () => {
    const id = await makePost();
    const v = await mkVersion(admin.cookie, id);
    expect((await api("GET", `/admin/posts/${id}/channel/versions`, admin.cookie)).status).toBe(200);
    expect((await api("PATCH", `/admin/posts/${id}/channel/versions/${v.id}`, admin.cookie, { name: "Qoralama versiyasi" })).status).toBe(200);
    expect((await api("POST", `/admin/posts/${id}/channel/preview`, admin.cookie, { versionId: v.id })).status).toBe(200);

    const forPlan = await json<ChannelPreflightResponse>(await api("POST", `/admin/posts/${id}/channel/preflight`, admin.cookie, { versionId: v.id, forPlan: true }));
    expect(forPlan.checks.find((c) => c.id === "config.published")).toBeUndefined();
    expect(forPlan.canSend).toBe(true);
    const strict = await json<ChannelPreflightResponse>(await api("POST", `/admin/posts/${id}/channel/preflight`, admin.cookie, { versionId: v.id }));
    expect(strict.checks.find((c) => c.id === "config.published")?.status).toBe("error");

    // Faqat `/channel/send` chop etilgan postni talab qiladi.
    expect((await api("POST", `/admin/posts/${id}/channel/send`, admin.cookie, { versionId: v.id })).status).toBe(409);
    expect((await api("DELETE", `/admin/posts/${id}/channel/versions/${v.id}`, admin.cookie)).status).toBe(200);
  });
});

describe("channel choice (mark) — CRUD + validation", () => {
  it("sets, returns (versions + detail + list flag), replaces and clears the mark", async () => {
    const id = await makePost();
    const empty = await json<{ choice: unknown }>(await api("GET", `/admin/posts/${id}/channel/versions`, admin.cookie));
    expect(empty.choice).toBeNull();

    const res = await mark(admin.cookie, id, { kind: "auto", mode: "text", variant: "m" });
    expect(res.status).toBe(200);
    const { choice } = await json<{ choice: ResolvedChannelChoice }>(res);
    expect(choice.label).toBe("Rasmsiz · O'rtacha");
    expect(choice.mode).toBe("text");
    expect(choice.passes).toBe(true);
    expect(choice.limit).toBe(4096);
    expect(choice.setBy?.id).toBe(admin.id);
    expect(choice.suggestedByStaff).toBe(false);

    const list = await json<{ choice: ResolvedChannelChoice | null }>(await api("GET", `/admin/posts/${id}/channel/versions`, admin.cookie));
    expect(list.choice?.choice).toEqual({ kind: "auto", mode: "text", variant: "m" });
    const detail = await json<{ channelChoice: ResolvedChannelChoice | null }>(await api("GET", `/admin/posts/${id}`, admin.cookie));
    expect(detail.channelChoice?.label).toBe("Rasmsiz · O'rtacha");
    const posts_ = await json<{ items: { id: string; hasChannelChoice: boolean }[] }>(await api("GET", "/admin/posts?limit=100", admin.cookie));
    expect(posts_.items.find((p) => p.id === id)?.hasChannelChoice).toBe(true);

    const v = await mkVersion(admin.cookie, id, { mode: "text", fromVariant: "l", name: "Mening matnim" });
    const replaced = await json<{ choice: ResolvedChannelChoice }>(await mark(admin.cookie, id, { kind: "version", versionId: v.id }));
    expect(replaced.choice.label).toBe("Mening matnim");
    expect(replaced.choice.visibleLength).toBe(v.visibleLength);

    expect((await api("DELETE", `/admin/posts/${id}/channel/choice`, admin.cookie)).status).toBe(200);
    const after = await loadPost(id);
    expect(after.channelChoice).toBeNull();
    expect(after.channelChoiceBy).toBeNull();
    expect(after.channelChoiceAt).toBeNull();
    const cleared = await json<{ items: { id: string; hasChannelChoice: boolean }[] }>(await api("GET", "/admin/posts?limit=100", admin.cookie));
    expect(cleared.items.find((p) => p.id === id)?.hasChannelChoice).toBe(false);
  });

  it("validates combos and ownership of the version", async () => {
    const id = await makePost();
    const other = await makePost();
    const foreign = await mkVersion(admin.cookie, other);
    expect((await mark(admin.cookie, id, { kind: "auto", mode: "media", variant: "s" })).status).toBe(400); // media + s mos emas
    expect((await mark(admin.cookie, id, { kind: "auto", mode: "media", variant: "xl" })).status).toBe(400);
    expect((await mark(admin.cookie, id, { kind: "auto", mode: "text" })).status).toBe(400);
    expect((await mark(admin.cookie, id, { kind: "wat" })).status).toBe(400);
    expect((await mark(admin.cookie, id, { kind: "version", versionId: "not-a-uuid" })).status).toBe(400);
    expect((await mark(admin.cookie, id, { kind: "version", versionId: foreign.id })).status).toBe(404); // boshqa postniki
    expect((await mark(admin.cookie, id, { kind: "version", versionId: "11111111-1111-4111-8111-111111111111" })).status).toBe(404);
    expect((await loadPost(id)).channelChoice).toBeNull();
    expect((await mark(admin.cookie, "11111111-1111-4111-8111-111111111111", { kind: "auto", mode: "text", variant: "m" })).status).toBe(404);
  });

  it("deleting the marked version clears the mark and says so (other deletes do not)", async () => {
    const id = await makePost();
    const a = await mkVersion(admin.cookie, id);
    const b = await mkVersion(admin.cookie, id);
    await mark(admin.cookie, id, { kind: "version", versionId: a.id });

    const delB = await json<{ ok: boolean; clearedChoice: boolean }>(await api("DELETE", `/admin/posts/${id}/channel/versions/${b.id}`, admin.cookie));
    expect(delB.clearedChoice).toBe(false);
    expect((await loadPost(id)).channelChoice).toEqual({ kind: "version", versionId: a.id });

    const delA = await json<{ ok: boolean; clearedChoice: boolean }>(await api("DELETE", `/admin/posts/${id}/channel/versions/${a.id}`, admin.cookie));
    expect(delA).toEqual({ ok: true, clearedChoice: true });
    expect((await loadPost(id)).channelChoice).toBeNull();
    expect((await json<{ choice: unknown }>(await api("GET", `/admin/posts/${id}/channel/versions`, admin.cookie))).choice).toBeNull();
  });

  it("reports passes=false when the marked version no longer satisfies Telegram limits", async () => {
    const id = await makePost();
    const v = await mkVersion(admin.cookie, id);
    await mark(admin.cookie, id, { kind: "version", versionId: v.id });
    await db.update(channelPostVersions).set({ textHtml: "", visibleLength: 0 }).where(eq(channelPostVersions.id, v.id));
    const list = await json<{ choice: ResolvedChannelChoice }>(await api("GET", `/admin/posts/${id}/channel/versions`, admin.cookie));
    expect(list.choice.passes).toBe(false);
  });
});

describe("scheduling plan with useChoice — resolves the CURRENT mark at send time", () => {
  it("stores { useChoice, delayMinutes } and sends whichever version is marked when it is sent", async () => {
    const id = await makePost();
    const a = await mkVersion(admin.cookie, id, { mode: "text", fromVariant: "m", name: "A versiya" });
    const b = await mkVersion(admin.cookie, id, { mode: "text", fromVariant: "l", name: "B versiya" });
    await mark(admin.cookie, id, { kind: "version", versionId: a.id });

    const res = await api("POST", `/admin/posts/${id}/schedule`, admin.cookie, {
      scheduledAt: PAST(),
      channelPlan: { useChoice: true, delayMinutes: 0, mode: "media", variant: "s", attempts: 3 },
    });
    expect(res.status).toBe(200);
    expect((await loadPost(id)).channelPlan).toEqual({ useChoice: true, delayMinutes: 0 });

    // Rejalashtirilgandan KEYIN belgi o'zgartiriladi — yangi belgi yuboriladi.
    await mark(admin.cookie, id, { kind: "version", versionId: b.id });

    await publishDuePosts();
    await runDueChannelSends();
    await runDueChannelSends();
    await settle();

    const sends = channelSends(await mockCalls());
    expect(sends.length).toBe(1);
    const ref = await loadRef(id);
    expect(ref?.channelVersionId).toBe(b.id);
    expect((await loadPost(id)).channelPlan).toBeNull();
    expect(adminNotices(await mockCalls(), "✅ Kanalga yuborildi").length).toBe(1);
    expect(adminNotices(await mockCalls(), "Belgilangan versiya yo'q").length).toBe(0);
  });

  it("an auto mark is used too (marked auto text/s)", async () => {
    const id = await makePost();
    await mark(admin.cookie, id, { kind: "auto", mode: "text", variant: "s" });
    await api("POST", `/admin/posts/${id}/schedule`, admin.cookie, { scheduledAt: PAST(), channelPlan: { useChoice: true, delayMinutes: 0 } });
    await publishDuePosts();
    await runDueChannelSends();
    await settle();
    const ref = await loadRef(id);
    expect(ref?.channelMode).toBe("text");
    expect(ref?.channelVariant).toBe("s");
  });

  it("falls back to media/m (post has a cover) or text/m (no images) when there is no mark, and says so", async () => {
    const withMedia = await makePost({ withMedia: true });
    const plain = await makePost();
    for (const id of [withMedia, plain]) {
      const res = await api("POST", `/admin/posts/${id}/schedule`, admin.cookie, { scheduledAt: PAST(), channelPlan: { useChoice: true, delayMinutes: 0 } });
      expect(res.status).toBe(200);
    }
    await publishDuePosts();
    await runDueChannelSends();
    await settle();

    const refMedia = await loadRef(withMedia);
    expect([refMedia?.channelMode, refMedia?.channelVariant]).toEqual(["media", "m"]);
    const refPlain = await loadRef(plain);
    expect([refPlain?.channelMode, refPlain?.channelVariant]).toEqual(["text", "m"]);
    expect(adminNotices(await mockCalls(), "Belgilangan versiya yo'q edi").length).toBe(2);
  });

  it("a mark deleted after scheduling falls back instead of failing", async () => {
    const id = await makePost();
    const v = await mkVersion(admin.cookie, id);
    await mark(admin.cookie, id, { kind: "version", versionId: v.id });
    await api("POST", `/admin/posts/${id}/schedule`, admin.cookie, { scheduledAt: PAST(), channelPlan: { useChoice: true, delayMinutes: 0 } });
    // Rejada aniq versiya YO'Q (faqat useChoice) — shu sabab o'chirish 409 bermaydi, belgi tozalanadi.
    expect((await api("DELETE", `/admin/posts/${id}/channel/versions/${v.id}`, admin.cookie)).status).toBe(200);
    await publishDuePosts();
    await runDueChannelSends();
    await settle();
    const ref = await loadRef(id);
    expect([ref?.channelMode, ref?.channelVariant]).toEqual(["text", "m"]);
  });

  it("preflight on save uses the resolved mark: a failing marked version is rejected with 422", async () => {
    const id = await makePost();
    const v = await mkVersion(admin.cookie, id);
    await mark(admin.cookie, id, { kind: "version", versionId: v.id });
    await db.update(channelPostVersions).set({ textHtml: "", visibleLength: 0 }).where(eq(channelPostVersions.id, v.id));
    const res = await api("POST", `/admin/posts/${id}/schedule`, admin.cookie, { scheduledAt: PAST(), channelPlan: { useChoice: true, delayMinutes: 0 } });
    expect(res.status).toBe(422);
    expect((await loadPost(id)).status).toBe("draft");
  });

  it("explicit variant / versionId plans keep working", async () => {
    const id = await makePost();
    const v = await mkVersion(admin.cookie, id);
    const r1 = await api("POST", `/admin/posts/${id}/schedule`, admin.cookie, { scheduledAt: PAST(), channelPlan: { mode: "text", variant: "m", delayMinutes: 5 } });
    expect(r1.status).toBe(200);
    expect((await loadPost(id)).channelPlan).toEqual({ mode: "text", variant: "m", delayMinutes: 5 });
    const r2 = await api("POST", `/admin/posts/${id}/schedule`, admin.cookie, { scheduledAt: PAST(), channelPlan: { mode: "text", versionId: v.id, delayMinutes: 0 } });
    expect(r2.status).toBe(200);
    expect((await loadPost(id)).channelPlan).toEqual({ mode: "text", versionId: v.id, delayMinutes: 0 });
    expect((await api("POST", `/admin/posts/${id}/schedule`, admin.cookie, { scheduledAt: PAST(), channelPlan: { delayMinutes: 0 } })).status).toBe(400);
  });
});

describe("manual publish with 'also send to channel'", () => {
  it("does NOT auto-send by default, even with a mark", async () => {
    const id = await makePost();
    await mark(admin.cookie, id, { kind: "auto", mode: "text", variant: "m" });
    const res = await api("POST", `/admin/posts/${id}/publish`, admin.cookie);
    expect(res.status).toBe(200);
    expect((await json<{ channelSend?: unknown }>(res)).channelSend).toBeUndefined();
    await settle();
    await runDueChannelSends();
    expect(channelSends(await mockCalls()).length).toBe(0);
    expect((await loadRef(id))?.channelSentAt ?? null).toBeNull();
  });

  it("sendToChannel: sends the mark exactly once, AFTER the Telegraph mirror, and reports the result", async () => {
    const id = await makePost();
    await mark(admin.cookie, id, { kind: "auto", mode: "text", variant: "m" });
    const res = await api("POST", `/admin/posts/${id}/publish`, admin.cookie, { sendToChannel: true });
    expect(res.status).toBe(200);
    const body = await json<{ status: string; channelSend: { state: string; messageUrl: string | null } }>(res);
    expect(body.status).toBe("published");
    expect(body.channelSend.state).toBe("sent");
    expect(body.channelSend.messageUrl).toContain("https://t.me/testchan/");

    await runDueChannelSends(); // ikkinchi tick qayta yubormaydi
    await settle();
    const calls = await mockCalls();
    expect(channelSends(calls).length).toBe(1);
    const pageIdx = calls.findIndex((c) => c.method === "createPage");
    const sendIdx = calls.findIndex((c) => ["sendMessage", "sendPhoto", "sendMediaGroup"].includes(c.method) && String(c.body.chat_id) === "@testchan");
    expect(pageIdx).toBeGreaterThanOrEqual(0);
    expect(pageIdx).toBeLessThan(sendIdx);
    expect(adminNotices(calls, "✅ Kanalga yuborildi").length).toBe(1);
    const post = await loadPost(id);
    expect(post.channelPlan).toBeNull();
    expect((await loadRef(id))?.channelVariant).toBe("m");
  });

  it("sendToChannel without a mark is rejected (400) and the post is NOT published", async () => {
    const id = await makePost();
    const res = await api("POST", `/admin/posts/${id}/publish`, admin.cookie, { sendToChannel: true });
    expect(res.status).toBe(400);
    expect((await loadPost(id)).status).toBe("draft");
  });

  it("approving a staff post with sendToChannel sends the staff's suggested mark", async () => {
    const id = await makePost({ createdBy: staffA.id });
    const v = await mkVersion(staffA.cookie, id, { mode: "text", fromVariant: "m", name: "Xodim taklifi" });
    expect((await mark(staffA.cookie, id, { kind: "version", versionId: v.id })).status).toBe(200);
    expect((await api("POST", `/admin/posts/${id}/submit`, staffA.cookie)).status).toBe(200);
    await settle();
    const res = await api("POST", `/admin/posts/${id}/approve`, admin.cookie, { sendToChannel: true });
    expect(res.status).toBe(200);
    expect((await json<{ channelSend: { state: string } }>(res)).channelSend.state).toBe("sent");
    expect((await loadRef(id))?.channelVersionId).toBe(v.id);
    expect(channelSends(await mockCalls()).length).toBe(1);
  });
});

describe("staff can prepare and suggest — never send", () => {
  it("own draft: versions CRUD, preview, preflight, set/clear mark are allowed; admin sees the suggestion until it changes", async () => {
    const id = await makePost({ createdBy: staffA.id });
    const v = await mkVersion(staffA.cookie, id);
    expect((await api("GET", `/admin/posts/${id}/channel/versions`, staffA.cookie)).status).toBe(200);
    expect((await api("PATCH", `/admin/posts/${id}/channel/versions/${v.id}`, staffA.cookie, { name: "Yangi nom" })).status).toBe(200);
    expect((await api("POST", `/admin/posts/${id}/channel/preview`, staffA.cookie, { versionId: v.id })).status).toBe(200);
    expect((await api("POST", `/admin/posts/${id}/channel/preflight`, staffA.cookie, { versionId: v.id, forPlan: true })).status).toBe(200);
    expect((await mark(staffA.cookie, id, { kind: "version", versionId: v.id })).status).toBe(200);

    const seenByAdmin = await json<{ channelChoice: ResolvedChannelChoice }>(await api("GET", `/admin/posts/${id}`, admin.cookie));
    expect(seenByAdmin.channelChoice.suggestedByStaff).toBe(true);
    expect(seenByAdmin.channelChoice.setBy?.id).toBe(staffA.id);
    const seenByStaff = await json<{ channelChoice: ResolvedChannelChoice }>(await api("GET", `/admin/posts/${id}`, staffA.cookie));
    expect(seenByStaff.channelChoice.label).toBe("Yangi nom");

    // Admin tasdiqlaydi (bir xil belgini qayta qo'yadi) — endi taklif emas.
    const confirmed = await json<{ choice: ResolvedChannelChoice }>(await mark(admin.cookie, id, { kind: "version", versionId: v.id }));
    expect(confirmed.choice.suggestedByStaff).toBe(false);
    expect(confirmed.choice.setBy?.id).toBe(admin.id);

    expect((await api("DELETE", `/admin/posts/${id}/channel/choice`, staffA.cookie)).status).toBe(200);
    expect((await api("DELETE", `/admin/posts/${id}/channel/versions/${v.id}`, staffA.cookie)).status).toBe(200);
  });

  it("403 matrix: send / schedule / plan / publish are admin-only; another staff's post is untouchable", async () => {
    const own = await makePost({ createdBy: staffA.id });
    const v = await mkVersion(staffA.cookie, own);
    const ownedByA = `/admin/posts/${own}`;

    // Staff hech qachon yubora olmaydi.
    expect((await api("POST", `${ownedByA}/channel/send`, staffA.cookie, { versionId: v.id })).status).toBe(403);
    expect((await api("POST", `${ownedByA}/channel/resync-caption`, staffA.cookie)).status).toBe(403);
    expect((await api("POST", `${ownedByA}/schedule`, staffA.cookie, { scheduledAt: PAST(), channelPlan: { useChoice: true, delayMinutes: 0 } })).status).toBe(403);
    expect((await api("PATCH", ownedByA, staffA.cookie, { channelPlan: { useChoice: true, delayMinutes: 0 } })).status).toBe(403);
    expect((await api("POST", `${ownedByA}/publish`, staffA.cookie, { sendToChannel: true })).status).toBe(403);
    expect((await api("POST", `${ownedByA}/approve`, staffA.cookie, { sendToChannel: true })).status).toBe(403);

    // Boshqa xodimning posti — hamma yo'l 403.
    const checks: [string, string, unknown?][] = [
      ["GET", `${ownedByA}/channel/versions`],
      ["POST", `${ownedByA}/channel/versions`, { mode: "text" }],
      ["PATCH", `${ownedByA}/channel/versions/${v.id}`, { name: "x" }],
      ["DELETE", `${ownedByA}/channel/versions/${v.id}`],
      ["POST", `${ownedByA}/channel/preview`, { versionId: v.id }],
      ["POST", `${ownedByA}/channel/preflight`, { versionId: v.id }],
      ["PUT", `${ownedByA}/channel/choice`, { kind: "auto", mode: "text", variant: "m" }],
      ["DELETE", `${ownedByA}/channel/choice`],
    ];
    for (const [method, url, body] of checks) {
      expect((await api(method, url, staffB.cookie, body)).status, `${method} ${url}`).toBe(403);
    }
    expect((await api("GET", `${ownedByA}/channel/versions`, null)).status).toBe(401);
  });

  it("in_review: versions are read-only for staff (reads OK, writes 409); admin can still edit/override", async () => {
    const id = await makePost({ createdBy: staffA.id });
    const v = await mkVersion(staffA.cookie, id);
    await mark(staffA.cookie, id, { kind: "version", versionId: v.id });
    expect((await api("POST", `/admin/posts/${id}/submit`, staffA.cookie)).status).toBe(200);
    const base = `/admin/posts/${id}`;

    expect((await api("GET", `${base}/channel/versions`, staffA.cookie)).status).toBe(200);
    expect((await api("POST", `${base}/channel/preview`, staffA.cookie, { versionId: v.id })).status).toBe(200);
    expect((await api("POST", `${base}/channel/preflight`, staffA.cookie, { versionId: v.id, forPlan: true })).status).toBe(200);
    expect((await api("POST", `${base}/channel/versions`, staffA.cookie, { mode: "text" })).status).toBe(409);
    expect((await api("PATCH", `${base}/channel/versions/${v.id}`, staffA.cookie, { name: "x" })).status).toBe(409);
    expect((await api("DELETE", `${base}/channel/versions/${v.id}`, staffA.cookie)).status).toBe(409);
    expect((await mark(staffA.cookie, id, { kind: "auto", mode: "text", variant: "s" })).status).toBe(409);
    expect((await api("DELETE", `${base}/channel/choice`, staffA.cookie)).status).toBe(409);
    expect((await loadPost(id)).channelChoice).toEqual({ kind: "version", versionId: v.id });

    // changes_requested — yana yoziladi.
    expect((await api("POST", `${base}/request-changes`, admin.cookie, { note: "Tuzating" })).status).toBe(200);
    expect((await mark(staffA.cookie, id, { kind: "auto", mode: "text", variant: "s" })).status).toBe(200);

    // Admin istalgan holatda tahrirlay oladi.
    await api("POST", `${base}/submit`, staffA.cookie);
    expect((await api("PATCH", `${base}/channel/versions/${v.id}`, admin.cookie, { name: "Admin tahriri" })).status).toBe(200);
    expect((await mark(admin.cookie, id, { kind: "version", versionId: v.id })).status).toBe(200);
  });
});

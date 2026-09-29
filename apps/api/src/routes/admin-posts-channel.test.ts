import { mkdir, rm, writeFile } from "node:fs/promises";
import { startMockTelegram } from "../../scripts/mock-telegram.js";
import path from "node:path";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { posts, telegramRefs } from "../db/schema.js";
import { uploadsDir } from "../lib/media/store.js";
import { invalidateSettingsCache, saveSettings } from "../lib/settings.js";
import { reconfigureBot } from "../telegram/client.js";
import { registerTelegramPublishing } from "../telegram/publish.js";
import { migrateTestDb } from "../test/migrate-test-db.js";
import { createTestUser, type TestUser } from "../test/auth-test-helpers.js";
import { eq } from "drizzle-orm";

let MOCK_ROOT = "";
let mockServer: { url: string; close: () => Promise<void> } | null = null;

// 1x1 shaffof PNG — sharp bemalol JPEG'ga aylantira oladigan minimal haqiqiy rasm.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

let app: Hono;
let admin: TestUser;
let postId: string;
let postSlug: string;

const testUploadKey = (name: string) => `test-channel/${name}`;

async function writeTestUpload(name: string): Promise<string> {
  const key = testUploadKey(name);
  const filePath = path.join(uploadsDir, key);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, TINY_PNG);
  return `${config.API_ORIGIN}/uploads/${key}`;
}

async function mockCalls(): Promise<{ method: string; body: Record<string, unknown> }[]> {
  const res = await fetch(`${MOCK_ROOT}/__calls`);
  const data = (await res.json()) as { calls: { method: string; body: Record<string, unknown> }[] };
  return data.calls;
}

async function mockUploads(): Promise<{ method: string; files: { field: string; filename: string; size: number }[] }[]> {
  const res = await fetch(`${MOCK_ROOT}/__uploads`);
  const data = (await res.json()) as {
    uploads: { method: string; files: { field: string; filename: string; size: number }[] }[];
  };
  return data.uploads;
}

async function req(path: string, cookie: string | null, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(cookie ? { cookie } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
}
function postJson(reqPath: string, cookie: string | null, body?: unknown) {
  return req(reqPath, cookie, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined });
}
async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

beforeAll(async () => {
  mockServer = await startMockTelegram();
  MOCK_ROOT = mockServer.url;
  await migrateTestDb();
  ({ app } = await import("../app.js"));
  admin = await createTestUser({ role: "admin", name: "Admin" });
  // `initTelegram()` (index.ts) hech qachon chaqirilmaydi testlarda — shu
  // sabab `post.published`/`post.updated` hodisalariga faqat shu funksiya
  // orqali obuna bo'lamiz (webhook/setMyCommands kabi network chaqiruvlarsiz).
  registerTelegramPublishing();

  // `.env`da `TELEGRAM_API_ROOT=https://api.telegram.org` bor — bu maydonni
  // "env'dan qulflangan" qilib qo'yadi (`assertNotEnvLocked`). `../app.js`
  // importi (yuqorida) `lib/auth.ts` orqali `getSettings()`ni allaqachon bir
  // marta chaqirib, shu env-qulflangan holatni KESHLAGAN — shu sabab avval
  // env o'zgaruvchini o'chiramiz, SO'NG keshni bekor qilamiz (aks holda
  // `saveSettings` hali ham eski (keshlangan) "env" manbasini ko'radi).
  delete process.env.TELEGRAM_API_ROOT;
  invalidateSettingsCache();

  // Telegram'ni mock serverga yo'naltiramiz — `getSettings()` (DB) + jonli `bot` bindingi ikkalasi ham kerak.
  await saveSettings({
    telegram: {
      botToken: "test-bot-token",
      webhookSecret: "0123456789abcdef",
      channelId: "@testchannel",
      apiRoot: MOCK_ROOT,
    },
  });
  reconfigureBot("test-bot-token", MOCK_ROOT);

  const coverUrl = await writeTestUpload("cover.png");
  const image1Url = await writeTestUpload("inline-1.png");
  const image2Url = await writeTestUpload("inline-2.png");

  postSlug = `channel-test-${Date.now()}`;
  const [created] = await db
    .insert(posts)
    .values({
      slug: postSlug,
      title: "Kanal sinov posti",
      coverUrl,
      contentJson: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Kirish paragrafi." }] },
          { type: "image", attrs: { src: image1Url, alt: "birinchi rasm" } },
          { type: "paragraph", content: [{ type: "text", text: "Ikkinchi paragraf matni." }] },
          { type: "image", attrs: { src: image2Url } },
          { type: "paragraph", content: [{ type: "text", text: "Yakuniy paragraf." }] },
        ],
      },
      contentHtml: "<p>Kirish paragrafi.</p>",
      contentText: "Kirish paragrafi. Ikkinchi paragraf matni. Yakuniy paragraf.",
      toc: [],
      status: "published",
      publishedAt: new Date(),
    })
    .returning();
  if (!created) throw new Error("post yaratilmadi");
  postId = created.id;
});

afterAll(async () => {
  await mockServer?.close();
  await rm(path.join(uploadsDir, "test-channel"), { recursive: true, force: true });
});

beforeEach(async () => {
  await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
});

describe("POST /admin/posts/:id/channel/preview", () => {
  it("returns caption + media (cover first, then in-range content images) for 🖼 media mode", async () => {
    const res = await postJson(`/admin/posts/${postId}/channel/preview`, admin.cookie, { mode: "media", variant: "m" });
    expect(res.status).toBe(200);
    const body = await json<{
      mode: string;
      variant: string;
      captionHtml: string;
      visibleLength: number;
      limit: number;
      truncated: boolean;
      media: { url: string; kind: string; alt: string | null }[];
      alreadySent: unknown;
    }>(res);

    expect(body.mode).toBe("media");
    expect(body.variant).toBe("m");
    expect(body.limit).toBe(650);
    expect(body.visibleLength).toBeLessThanOrEqual(650);
    expect(body.media[0]?.kind).toBe("cover");
    expect(body.media.length).toBeGreaterThanOrEqual(2);
    expect(body.alreadySent).toBeNull();
  });

  it("returns a plain-text preview (no media) for 📝 text mode", async () => {
    const res = await postJson(`/admin/posts/${postId}/channel/preview`, admin.cookie, { mode: "text", variant: "m" });
    expect(res.status).toBe(200);
    const body = await json<{ mode: string; limit: number; media: unknown[] }>(res);
    expect(body.mode).toBe("text");
    expect(body.limit).toBe(800);
    expect(body.media).toEqual([]);
  });

  it("400s without mode/variant", async () => {
    const res = await postJson(`/admin/posts/${postId}/channel/preview`, admin.cookie, {});
    expect(res.status).toBe(400);
  });

  it("400s for an invalid mode/variant combination (media+s)", async () => {
    const res = await postJson(`/admin/posts/${postId}/channel/preview`, admin.cookie, { mode: "media", variant: "s" });
    expect(res.status).toBe(400);
  });

  it("400s for 🖼 media mode on a post with no cover and no images", async () => {
    const createRes = await postJson("/admin/posts", admin.cookie, { title: "Rasmsiz post" });
    const created = await json<{ id: string }>(createRes);
    await req(`/admin/posts/${created.id}`, admin.cookie, {
      method: "PATCH",
      body: JSON.stringify({ contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Faqat matn." }] }] } }),
    });
    await postJson(`/admin/posts/${created.id}/publish`, admin.cookie);

    const res = await postJson(`/admin/posts/${created.id}/channel/preview`, admin.cookie, { mode: "media", variant: "m" });
    expect(res.status).toBe(400);
  });
});

describe("POST /admin/posts/:id/channel/send", () => {
  it("sends ONE sendMediaGroup with JPEG uploads and caption on item 0, no reply_markup (media mode)", async () => {
    const res = await postJson(`/admin/posts/${postId}/channel/send`, admin.cookie, { mode: "media", variant: "m" });
    expect(res.status).toBe(200);
    const body = await json<{ mode: string; messageType: string; messageIds: number[]; messageUrl: string | null }>(res);
    expect(body.mode).toBe("media");
    expect(body.messageType).toBe("album");
    expect(body.messageIds.length).toBeGreaterThanOrEqual(2);
    expect(body.messageUrl).toContain("https://t.me/testchannel/");

    const calls = await mockCalls();
    const mediaGroupCalls = calls.filter((c) => c.method === "sendMediaGroup");
    expect(mediaGroupCalls.length).toBe(1);
    expect(mediaGroupCalls[0]!.body.reply_markup).toBeUndefined();
    const mediaPayload = mediaGroupCalls[0]!.body.media as { caption?: string }[];
    expect(mediaPayload[0]!.caption).toBeTruthy();
    expect(mediaPayload[1]!.caption).toBeUndefined();

    const uploads = await mockUploads();
    const mediaGroupUploads = uploads.filter((u) => u.method === "sendMediaGroup");
    expect(mediaGroupUploads.length).toBe(1);
    expect(mediaGroupUploads[0]!.files.length).toBeGreaterThanOrEqual(2);
    for (const file of mediaGroupUploads[0]!.files) {
      expect(file.filename.endsWith(".jpg")).toBe(true);
      expect(file.size).toBeGreaterThan(0);
    }

    const ref = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, postId)).then((r) => r[0]);
    expect(ref?.channelMessageType).toBe("album");
    expect(ref?.channelVariant).toBe("m");
    expect(ref?.channelMode).toBe("media");
    expect(ref?.channelSentAt).toBeTruthy();
    expect(ref?.channelMessageIds?.length).toBeGreaterThanOrEqual(2);
  });

  it("second send -> 409 (already sent)", async () => {
    const res = await postJson(`/admin/posts/${postId}/channel/send`, admin.cookie, { mode: "media", variant: "l" });
    expect(res.status).toBe(409);
  });

  it("400s for an invalid mode/variant combination (text+xl is valid, media+xl is not)", async () => {
    const res = await postJson(`/admin/posts/${postId}/channel/send`, admin.cookie, {
      mode: "media",
      variant: "xl",
      replaceExisting: true,
    });
    expect(res.status).toBe(400);
  });

  it("preview now reports alreadySent with mode+variant and a messageUrl", async () => {
    const res = await postJson(`/admin/posts/${postId}/channel/preview`, admin.cookie, { mode: "media", variant: "m" });
    const body = await json<{
      alreadySent: { at: string; mode: string; variant: string; messageUrl: string | null } | null;
    }>(res);
    expect(body.alreadySent?.mode).toBe("media");
    expect(body.alreadySent?.variant).toBe("m");
    expect(body.alreadySent?.messageUrl).toContain("https://t.me/testchannel/");
  });

  it("replaceExisting -> deleteMessage for old ids then a fresh send", async () => {
    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });

    const res = await postJson(`/admin/posts/${postId}/channel/send`, admin.cookie, {
      mode: "media",
      variant: "l",
      replaceExisting: true,
    });
    expect(res.status).toBe(200);

    const calls = await mockCalls();
    const deleteCalls = calls.filter((c) => c.method === "deleteMessage");
    expect(deleteCalls.length).toBeGreaterThanOrEqual(2);
    const sendCalls = calls.filter((c) => c.method === "sendMediaGroup" || c.method === "sendPhoto");
    expect(sendCalls.length).toBe(1);

    const ref = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, postId)).then((r) => r[0]);
    expect(ref?.channelVariant).toBe("l");
    expect(ref?.channelMode).toBe("media");
  });

  it("post.updated after a channel send triggers editMessageCaption (not a new send), using the stored mode", async () => {
    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });

    const patchRes = await req(`/admin/posts/${postId}`, admin.cookie, {
      method: "PATCH",
      body: JSON.stringify({ excerpt: "Yangilangan tavsif" }),
    });
    expect(patchRes.status).toBe(200);

    // event emit — mikrotask navbatida ishlaydi, biroz kutamiz.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const calls = await mockCalls();
    expect(calls.some((c) => c.method === "editMessageCaption")).toBe(true);
    expect(calls.some((c) => c.method === "sendMediaGroup" || c.method === "sendPhoto")).toBe(false);
  });

  it("replaceExisting with mode: text -> sends a plain sendMessage (no media, link preview disabled) and resync uses text afterwards", async () => {
    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });

    const res = await postJson(`/admin/posts/${postId}/channel/send`, admin.cookie, {
      mode: "text",
      variant: "m",
      replaceExisting: true,
    });
    expect(res.status).toBe(200);
    const body = await json<{ mode: string; messageType: string }>(res);
    expect(body.mode).toBe("text");
    expect(body.messageType).toBe("text");

    const calls = await mockCalls();
    const sendMessageCalls = calls.filter((c) => c.method === "sendMessage");
    expect(sendMessageCalls.length).toBe(1);
    expect(sendMessageCalls[0]!.body.link_preview_options).toEqual({ is_disabled: true });
    expect(sendMessageCalls[0]!.body.reply_markup).toBeUndefined();
    expect(calls.some((c) => c.method === "sendMediaGroup" || c.method === "sendPhoto")).toBe(false);

    const uploads = await mockUploads();
    expect(uploads.length).toBe(0);

    const ref = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, postId)).then((r) => r[0]);
    expect(ref?.channelMode).toBe("text");
    expect(ref?.channelMessageType).toBe("text");

    // resync-caption endi saqlangan 'text' rejimidan foydalanadi -> editMessageText (editMessageCaption EMAS).
    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    const resyncRes = await postJson(`/admin/posts/${postId}/channel/resync-caption`, admin.cookie);
    expect(resyncRes.status).toBe(200);
    const resyncCalls = await mockCalls();
    expect(resyncCalls.some((c) => c.method === "editMessageText")).toBe(true);
    expect(resyncCalls.some((c) => c.method === "editMessageCaption")).toBe(false);
  });
});

describe("publishing a post no longer auto-sends to the channel", () => {
  it("a freshly published post has no channel message until explicitly sent", async () => {
    const createRes = await postJson("/admin/posts", admin.cookie, { title: "Avto yubormaslik sinovi" });
    expect(createRes.status).toBe(201);
    const created = await json<{ id: string }>(createRes);

    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    const publishRes = await postJson(`/admin/posts/${created.id}/publish`, admin.cookie);
    expect(publishRes.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 200));
    const calls = await mockCalls();
    expect(calls.some((c) => ["sendMessage", "sendPhoto", "sendMediaGroup"].includes(c.method))).toBe(false);

    const ref = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, created.id)).then((r) => r[0]);
    expect(ref?.channelSentAt ?? null).toBeNull();
  });
});

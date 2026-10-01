import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { ChannelPreflightResponse, ChannelVersion } from "@blog/shared";
import { startMockTelegram } from "../../scripts/mock-telegram.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { channelPostVersions, posts, telegramRefs } from "../db/schema.js";
import { publishDuePosts } from "../lib/scheduler.js";
import { uploadsDir } from "../lib/media/store.js";
import { invalidateSettingsCache, saveSettings } from "../lib/settings.js";
import { reconfigureBot } from "../telegram/client.js";
import { clearChannelInfoCache } from "../telegram/channel-info.js";
import { clearPreparedImageCache, getPreparedImage } from "../telegram/channel-media.js";
import { runDueChannelSends } from "../telegram/channel-plan.js";
import { registerTelegramPublishing } from "../telegram/publish.js";
import { createTestUser, type TestUser } from "../test/auth-test-helpers.js";
import { migrateTestDb } from "../test/migrate-test-db.js";

let MOCK_ROOT = "";
let mockServer: { url: string; close: () => Promise<void> } | null = null;
let app: Hono;
let admin: TestUser;
let staff: TestUser;
let counter = 0;

type Call = { method: string; body: Record<string, unknown> };
async function mockCalls(): Promise<Call[]> {
  return ((await (await fetch(`${MOCK_ROOT}/__calls`)).json()) as { calls: Call[] }).calls;
}
const sentCalls = (calls: Call[]) => calls.filter((c) => ["sendMessage", "sendPhoto", "sendMediaGroup"].includes(c.method));

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

const solid = (width: number, height: number, background = "#3366cc") =>
  sharp({ create: { width, height, channels: 3, background } });

async function upload(name: string, buffer: Buffer): Promise<string> {
  const key = `test-versions/${name}`;
  const filePath = path.join(uploadsDir, key);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, buffer);
  return `${config.API_ORIGIN}/uploads/${key}`;
}

let goodPng: Buffer;

/** `images` — URL (string) yoki yuklanadigan rasm. Birinchisi `cover` bo'ladi (`cover: true`). */
async function makePost(opts: { cover?: string | null; images?: string[]; status?: "published" | "draft"; text?: string } = {}) {
  counter += 1;
  const content: unknown[] = [{ type: "paragraph", content: [{ type: "text", text: opts.text ?? "Kirish paragrafi." }] }];
  for (const src of opts.images ?? []) content.push({ type: "image", attrs: { src } });
  const [row] = await db
    .insert(posts)
    .values({
      slug: `versions-test-${Date.now()}-${counter}`,
      title: `Versiya sinovi ${counter}`,
      coverUrl: opts.cover ?? null,
      contentJson: { type: "doc", content },
      contentHtml: "<p>x</p>",
      contentText: "x",
      toc: [],
      status: opts.status ?? "published",
      publishedAt: opts.status === "draft" ? null : new Date(),
    })
    .returning();
  return row!;
}

async function createVersion(postId: string, body: Record<string, unknown>): Promise<ChannelVersion> {
  const res = await api("POST", `/admin/posts/${postId}/channel/versions`, admin.cookie, body);
  expect(res.status).toBe(201);
  return json<ChannelVersion>(res);
}
async function preflight(postId: string, selection: unknown) {
  const res = await api("POST", `/admin/posts/${postId}/channel/preflight`, admin.cookie, selection);
  expect(res.status).toBe(200);
  return json<ChannelPreflightResponse>(res);
}
const findCheck = (pf: ChannelPreflightResponse, id: string) => pf.checks.find((c) => c.id === id);
const textVersionBody = (text: string) => ({
  contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
});

beforeAll(async () => {
  mockServer = await startMockTelegram();
  MOCK_ROOT = mockServer.url;
  await migrateTestDb();
  ({ app } = await import("../app.js"));
  admin = await createTestUser({ role: "admin", name: "Admin" });
  staff = await createTestUser({ role: "staff", name: "Staff" });
  registerTelegramPublishing();

  delete process.env.TELEGRAM_API_ROOT;
  invalidateSettingsCache();
  await saveSettings({
    telegram: {
      botToken: "test-bot-token",
      webhookSecret: "0123456789abcdef",
      channelId: "@testchannel",
      adminChatId: "777",
      apiRoot: MOCK_ROOT,
    },
  });
  reconfigureBot("test-bot-token", MOCK_ROOT);
  goodPng = await solid(1200, 800).png().toBuffer();
});

afterAll(async () => {
  await mockServer?.close();
  await rm(path.join(uploadsDir, "test-versions"), { recursive: true, force: true });
});

beforeEach(async () => {
  await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
  clearPreparedImageCache();
});

describe("preflight rules", () => {
  it("reports original vs sent for a normal image and passes", async () => {
    const cover = await upload("ok-cover.png", goodPng);
    const post = await makePost({ cover });
    const pf = await preflight(post.id, { mode: "media", variant: "m" });
    expect(pf.canSend).toBe(true);
    expect(pf.media).toHaveLength(1);
    expect(pf.media[0]!.original).toMatchObject({ width: 1200, height: 800, format: "png", animated: false });
    expect(pf.media[0]!.sent).toMatchObject({ width: 1200, height: 800, format: "jpeg" });
    expect(pf.text.limit).toBe(1024);
    expect(findCheck(pf, "media.aspect:0")?.status).toBe("ok");
    expect(findCheck(pf, "config.bot")?.status).toBe("ok");
    expect(findCheck(pf, "config.published")?.status).toBe("ok");
  });

  it("oversized dimensions: warns and shows from -> to, sent size/dims fit Telegram limits", async () => {
    const big = await upload("big.png", await solid(6000, 5000).png().toBuffer());
    const post = await makePost({ cover: big });
    const pf = await preflight(post.id, { mode: "media", variant: "m" });
    expect(pf.canSend).toBe(true);
    const down = findCheck(pf, "media.downscale:0");
    expect(down?.status).toBe("warn");
    expect(down?.message).toContain("6000×5000");
    expect(pf.media[0]!.sent!.width).toBeLessThanOrEqual(2560);
    expect(findCheck(pf, "media.dimensions:0")?.status).toBe("ok");
    expect(findCheck(pf, "media.size:0")?.status).toBe("ok");
  });

  it("extreme aspect ratio 25:1 is an error that suggests cropping", async () => {
    const wide = await upload("wide.png", await solid(2500, 100).png().toBuffer());
    const post = await makePost({ cover: wide });
    const pf = await preflight(post.id, { mode: "media", variant: "m" });
    expect(pf.canSend).toBe(false);
    const aspect = findCheck(pf, "media.aspect:0");
    expect(aspect?.status).toBe("error");
    expect(aspect?.message).toContain("25:1");
    expect(aspect?.message).toContain("qirqing");
  });

  it("unreachable image URL is an error naming the URL (auto variants too)", async () => {
    const badUrl = "http://127.0.0.1:1/missing.png";
    const cover = await upload("ok2.png", goodPng);
    const post = await makePost({ cover, images: [badUrl] });
    const pf = await preflight(post.id, { mode: "media", variant: "l" });
    expect(pf.canSend).toBe(false);
    const dl = findCheck(pf, "media.download:1");
    expect(dl?.status).toBe("error");
    expect(dl?.message).toContain(badUrl);
    expect(pf.media[1]!.error).toBeTruthy();
  });

  it("animated GIF warns that only the first frame is sent", async () => {
    const frames = [await solid(400, 300, "#f00").png().toBuffer(), await solid(400, 300, "#0f0").png().toBuffer()];
    const gif = await sharp(frames, { join: { animated: true } }).gif({ delay: [100, 100], loop: 0 }).toBuffer();
    const cover = await upload("anim.gif", gif);
    const post = await makePost({ cover });
    const pf = await preflight(post.id, { mode: "media", variant: "m" });
    expect(pf.canSend).toBe(true);
    expect(findCheck(pf, "media.animated:0")?.status).toBe("warn");
    expect(findCheck(pf, "media.animated:0")?.message).toContain("birinchi kadr");
  });

  it("tiny image warns", async () => {
    const tiny = await upload("tiny.png", await solid(100, 100).png().toBuffer());
    const post = await makePost({ cover: tiny });
    const pf = await preflight(post.id, { mode: "media", variant: "m" });
    expect(findCheck(pf, "media.tiny:0")?.status).toBe("warn");
    expect(pf.canSend).toBe(true);
  });

  it("11 images in a version is an error telling how many to remove", async () => {
    const urls: string[] = [];
    for (let i = 0; i < 11; i += 1) urls.push(await upload(`many-${i}.png`, goodPng));
    const post = await makePost({ cover: urls[0], images: urls.slice(1) });
    const [row] = await db
      .insert(channelPostVersions)
      .values({
        postId: post.id,
        name: "Ko'p rasm",
        mode: "media",
        contentJson: { type: "doc", content: [] },
        textHtml: "Matn",
        visibleLength: 4,
        imageUrls: urls,
      })
      .returning();
    const pf = await preflight(post.id, { versionId: row!.id });
    expect(pf.canSend).toBe(false);
    const count = findCheck(pf, "album.count");
    expect(count?.status).toBe("error");
    expect(count?.message).toContain("1 ta rasmni olib tashlang");
    expect(pf.totalUploadBytes).toBeGreaterThan(0);
  });

  it("caption 1024 ok / 1025 error; text 4096 ok / 4097 error; empty text error", async () => {
    const cover = await upload("cap.png", goodPng);
    const post = await makePost({ cover });
    const media = await createVersion(post.id, { mode: "media", fromVariant: "m" });
    const textV = await createVersion(post.id, { mode: "text", fromVariant: "s" });

    const patch = async (v: ChannelVersion, text: string) => {
      const res = await api("PATCH", `/admin/posts/${post.id}/channel/versions/${v.id}`, admin.cookie, textVersionBody(text));
      expect(res.status).toBe(200);
      return json<ChannelVersion>(res);
    };

    let updated = await patch(media, "a".repeat(1024));
    expect(updated.overLimit).toBe(false);
    expect(findCheck(await preflight(post.id, { versionId: media.id }), "text.length")?.status).toBe("ok");

    updated = await patch(media, "a".repeat(1025));
    expect(updated.overLimit).toBe(true); // saqlash ruxsat etiladi, lekin belgilanadi
    let pf = await preflight(post.id, { versionId: media.id });
    expect(pf.canSend).toBe(false);
    expect(findCheck(pf, "text.length")?.message).toContain("1 belgi ortiqcha");

    await patch(textV, "b".repeat(4096));
    expect(findCheck(await preflight(post.id, { versionId: textV.id }), "text.length")?.status).toBe("ok");
    await patch(textV, "b".repeat(4097));
    pf = await preflight(post.id, { versionId: textV.id });
    expect(pf.canSend).toBe(false);
    expect(findCheck(pf, "text.length")?.message).toContain("1 belgi ortiqcha");
    expect(pf.text).toEqual({ visibleLength: 4097, limit: 4096 });

    await patch(textV, "   ");
    pf = await preflight(post.id, { versionId: textV.id });
    expect(findCheck(pf, "text.empty")?.status).toBe("error");
  });

  it("draft posts fail the 'published' config check on preflight", async () => {
    const post = await makePost({ status: "draft" });
    const pf = await preflight(post.id, { mode: "text", variant: "m" });
    expect(findCheck(pf, "config.published")?.status).toBe("error");
    expect(pf.canSend).toBe(false);
  });

  it("forPlan skips the 'published' check and downgrades a missing-image media plan to a warning", async () => {
    const post = await makePost({ status: "draft" });
    const res = await api("POST", `/admin/posts/${post.id}/channel/preflight`, admin.cookie, { mode: "media", variant: "m", forPlan: true });
    const pf = await json<ChannelPreflightResponse>(res);
    expect(findCheck(pf, "config.published")).toBeUndefined();
    expect(findCheck(pf, "album.empty")?.status).toBe("warn");
    expect(pf.canSend).toBe(true);
  });

  it("caches converted images (same buffer object on the second call)", async () => {
    const url = await upload("cache.png", goodPng);
    const first = await getPreparedImage(url);
    const second = await getPreparedImage(url);
    expect(first.ok && second.ok && first.buffer === second.buffer).toBe(true);
    // fayl o'zgarsa (mtime/hajm) kesh yaroqsiz bo'ladi
    await new Promise((r) => setTimeout(r, 20));
    await upload("cache.png", await solid(300, 300).png().toBuffer());
    const third = await getPreparedImage(url);
    expect(third.ok && third.sent.width === 300).toBe(true);
  });
});

describe("send enforcement", () => {
  it("refuses with 422 + failing checks and sends NOTHING when preflight has errors (version)", async () => {
    const wide = await upload("wide2.png", await solid(2500, 100).png().toBuffer());
    const post = await makePost({ cover: wide });
    const v = await createVersion(post.id, { mode: "media", fromVariant: "m" });
    const res = await api("POST", `/admin/posts/${post.id}/channel/send`, admin.cookie, { versionId: v.id });
    expect(res.status).toBe(422);
    const body = await json<{ error: string; preflight: ChannelPreflightResponse }>(res);
    expect(body.preflight.canSend).toBe(false);
    expect(body.preflight.checks.some((c) => c.id === "media.aspect:0" && c.status === "error")).toBe(true);
    expect(sentCalls(await mockCalls())).toHaveLength(0);
  });

  it("an auto variant with a broken image is refused too (no silent skipping)", async () => {
    const cover = await upload("ok3.png", goodPng);
    const post = await makePost({ cover, images: ["http://127.0.0.1:1/broken.png"] });
    const res = await api("POST", `/admin/posts/${post.id}/channel/send`, admin.cookie, { mode: "media", variant: "l" });
    expect(res.status).toBe(422);
    expect(sentCalls(await mockCalls())).toHaveLength(0);
    const [ref] = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, post.id));
    expect(ref?.channelSentAt ?? null).toBeNull();
  });

  it("scheduling / PATCH with a failing plan is refused with 422", async () => {
    const wide = await upload("wide3.png", await solid(2500, 100).png().toBuffer());
    const post = await makePost({ cover: wide, status: "draft" });
    const v = await createVersion(post.id, { mode: "media", fromVariant: "m" });
    const when = new Date(Date.now() + 3_600_000).toISOString();

    const res = await api("POST", `/admin/posts/${post.id}/schedule`, admin.cookie, {
      scheduledAt: when,
      channelPlan: { mode: "media", versionId: v.id, delayMinutes: 0 },
    });
    expect(res.status).toBe(422);
    expect((await json<{ preflight: ChannelPreflightResponse }>(res)).preflight.canSend).toBe(false);
    const [row] = await db.select().from(posts).where(eq(posts.id, post.id));
    expect(row!.status).toBe("draft");

    // Ro'yxatga mos reja: schedule OK, keyin PATCH bilan buzuq versiyaga o'tish -> 422
    const textV = await createVersion(post.id, { mode: "text", fromVariant: "m" });
    const ok = await api("POST", `/admin/posts/${post.id}/schedule`, admin.cookie, {
      scheduledAt: when,
      channelPlan: { mode: "text", versionId: textV.id, delayMinutes: 0 },
    });
    expect(ok.status).toBe(200);
    const patch = await api("PATCH", `/admin/posts/${post.id}`, admin.cookie, {
      channelPlan: { mode: "media", versionId: v.id, delayMinutes: 0 },
    });
    expect(patch.status).toBe(422);
  });
});

describe("custom versions", () => {
  it("fork from auto variant, list, render, image subset validation, reorder, mode switch, delete", async () => {
    const cover = await upload("v-cover.png", goodPng);
    const img1 = await upload("v-img1.png", goodPng);
    const post = await makePost({ cover, images: [img1], text: "Birinchi paragraf." });

    const v1 = await createVersion(post.id, { mode: "media", fromVariant: "l" });
    expect(v1.name).toBe("Versiya 1");
    expect(v1.baseVariant).toBe("l");
    expect(v1.imageUrls).toEqual([cover, img1]); // kover birinchi
    expect(v1.textHtml).toContain("Birinchi paragraf.");
    expect(v1.textHtml).toContain("Blog saytida"); // footer tahrirlanadigan kontentning bir qismi
    expect(v1.limit).toBe(1024);
    const v2 = await createVersion(post.id, { mode: "text", fromVersionId: v1.id, name: "Nusxa" });
    expect(v2.name).toBe("Nusxa");
    expect(v2.imageUrls).toEqual([]);
    expect(v2.textHtml).toBe(v1.textHtml);

    const list = await json<{ versions: ChannelVersion[]; autoVariants: unknown[]; postImages: { url: string; kind: string }[] }>(
      await api("GET", `/admin/posts/${post.id}/channel/versions`, admin.cookie),
    );
    expect(list.versions.map((v) => v.id)).toEqual([v1.id, v2.id]);
    expect(list.autoVariants.length).toBe(6);
    expect(list.postImages.map((i) => i.url)).toEqual([cover, img1]);

    const url = `/admin/posts/${post.id}/channel/versions/${v1.id}`;
    // render: marks + list + link filtering
    const rich = await api("PATCH", url, admin.cookie, {
      contentJson: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "qalin", marks: [{ type: "bold" }] }] },
          { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "band" }] }] }] },
        ],
      },
    });
    expect(rich.status).toBe(200);
    expect((await json<ChannelVersion>(rich)).textHtml).toBe("<b>qalin</b>\n\n• band");

    // validation
    expect((await api("PATCH", url, admin.cookie, { imageUrls: ["https://evil.test/x.png"] })).status).toBe(400);
    expect((await api("PATCH", url, admin.cookie, { imageUrls: [cover, cover] })).status).toBe(400);
    expect((await api("PATCH", url, admin.cookie, { imageUrls: Array.from({ length: 11 }, () => cover) })).status).toBe(400);
    expect(
      (await api("PATCH", url, admin.cookie, { contentJson: { type: "doc", content: [{ type: "image", attrs: { src: cover } }] } })).status,
    ).toBe(400);
    const reordered = await api("PATCH", url, admin.cookie, { imageUrls: [img1, cover], name: "Qayta tartib" });
    expect((await json<ChannelVersion>(reordered)).imageUrls).toEqual([img1, cover]);
    const asText = await json<ChannelVersion>(await api("PATCH", url, admin.cookie, { mode: "text" }));
    expect(asText.mode).toBe("text");
    expect(asText.imageUrls).toEqual([]);
    expect(asText.limit).toBe(4096);

    // postChanged hint
    expect(asText.postChanged).toBe(false);
    await new Promise((r) => setTimeout(r, 15));
    await db.update(posts).set({ updatedAt: new Date() }).where(eq(posts.id, post.id));
    const after = await json<{ versions: ChannelVersion[] }>(await api("GET", `/admin/posts/${post.id}/channel/versions`, admin.cookie));
    expect(after.versions[0]!.postChanged).toBe(true);

    expect((await api("DELETE", `/admin/posts/${post.id}/channel/versions/${v2.id}`, admin.cookie)).status).toBe(200);
    expect((await api("GET", `/admin/posts/${post.id}/channel/versions`, admin.cookie).then((r) => r.json())) as { versions: unknown[] }).toMatchObject({ versions: [expect.anything()] });
    expect((await api("DELETE", `/admin/posts/${post.id}/channel/versions/${v2.id}`, admin.cookie)).status).toBe(404);
  });

  it("is admin-only and cascades on post delete", async () => {
    const post = await makePost({ status: "draft" });
    const v = await createVersion(post.id, { mode: "text", fromVariant: "m" });
    expect((await api("GET", `/admin/posts/${post.id}/channel/versions`, staff.cookie)).status).toBe(403);
    expect((await api("POST", `/admin/posts/${post.id}/channel/preflight`, staff.cookie, { versionId: v.id })).status).toBe(403);
    expect((await api("DELETE", `/admin/posts/${post.id}`, admin.cookie)).status).toBe(200);
    expect(await db.select().from(channelPostVersions).where(eq(channelPostVersions.id, v.id))).toHaveLength(0);
  });

  it("send from a custom version records channel_version_id and is NOT re-synced on post update", async () => {
    const cover = await upload("s-cover.png", goodPng);
    const img = await upload("s-img.png", goodPng);
    const post = await makePost({ cover, images: [img] });
    const v = await createVersion(post.id, { mode: "media", fromVariant: "m" });
    await api("PATCH", `/admin/posts/${post.id}/channel/versions/${v.id}`, admin.cookie, textVersionBody("Maxsus matn!"));

    const res = await api("POST", `/admin/posts/${post.id}/channel/send`, admin.cookie, { versionId: v.id });
    expect(res.status).toBe(200);
    const sent = await json<{ versionId: string; variant: unknown; messageType: string }>(res);
    expect(sent.versionId).toBe(v.id);
    expect(sent.variant).toBeNull();
    expect(sent.messageType).toBe("album");

    const calls = await mockCalls();
    const group = calls.find((c) => c.method === "sendMediaGroup")!;
    expect((group.body.media as { caption?: string }[])[0]!.caption).toBe("Maxsus matn!");

    const [ref] = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, post.id));
    expect(ref?.channelVersionId).toBe(v.id);
    expect(ref?.channelVariant).toBeNull();
    expect(ref?.channelMode).toBe("media");

    const preview = await json<{ alreadySent: { versionId: string; versionName: string } | null }>(
      await api("POST", `/admin/posts/${post.id}/channel/preview`, admin.cookie, { versionId: v.id }),
    );
    expect(preview.alreadySent?.versionId).toBe(v.id);

    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    const upd = await api("PATCH", `/admin/posts/${post.id}`, admin.cookie, { excerpt: "Yangi tavsif" });
    expect(upd.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    await api("POST", `/admin/posts/${post.id}/channel/resync-caption`, admin.cookie);
    const afterCalls = await mockCalls();
    expect(afterCalls.some((c) => c.method === "editMessageCaption" || c.method === "editMessageText")).toBe(false);

    // Avtomatik variant bilan qayta yuborilsa — version izi tozalanadi va resync yana ishlaydi.
    const re = await api("POST", `/admin/posts/${post.id}/channel/send`, admin.cookie, { mode: "media", variant: "m", replaceExisting: true });
    expect(re.status).toBe(200);
    const [ref2] = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, post.id));
    expect(ref2?.channelVersionId).toBeNull();
    expect(ref2?.channelVariant).toBe("m");
  });

  it("deleting a version used by a pending plan is refused (409); plan with versionId sends that version", async () => {
    const cover = await upload("p-cover.png", goodPng);
    const post = await makePost({ cover, status: "draft" });
    const v = await createVersion(post.id, { mode: "media", fromVariant: "m" });
    await api("PATCH", `/admin/posts/${post.id}/channel/versions/${v.id}`, admin.cookie, textVersionBody("Reja matni"));

    const past = new Date(Date.now() - 60_000).toISOString();
    const sched = await api("POST", `/admin/posts/${post.id}/schedule`, admin.cookie, {
      scheduledAt: past,
      channelPlan: { mode: "media", versionId: v.id, delayMinutes: 0 },
    });
    expect(sched.status).toBe(200);
    const [stored] = await db.select().from(posts).where(eq(posts.id, post.id));
    expect(stored!.channelPlan).toMatchObject({ versionId: v.id, mode: "media" });

    expect((await api("DELETE", `/admin/posts/${post.id}/channel/versions/${v.id}`, admin.cookie)).status).toBe(409);

    await publishDuePosts();
    await new Promise((r) => setTimeout(r, 150));
    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    await runDueChannelSends();

    const calls = await mockCalls();
    const photo = calls.find((c) => c.method === "sendPhoto");
    expect(photo?.body.caption).toBe("Reja matni");
    const [ref] = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, post.id));
    expect(ref?.channelVersionId).toBe(v.id);
    const [done] = await db.select().from(posts).where(eq(posts.id, post.id));
    expect(done!.channelPlan).toBeNull();

    // Reja bajarildi — endi o'chirish mumkin.
    expect((await api("DELETE", `/admin/posts/${post.id}/channel/versions/${v.id}`, admin.cookie)).status).toBe(200);
    const [ref3] = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, post.id));
    expect(ref3?.channelVersionId).toBeNull();
  });

  it("scheduler re-runs preflight at send time: a now-failing version is a failed attempt with the reason", async () => {
    const cover = await upload("r-cover.png", goodPng);
    const post = await makePost({ cover, status: "draft" });
    const v = await createVersion(post.id, { mode: "media", fromVariant: "m" });
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(
      (
        await api("POST", `/admin/posts/${post.id}/schedule`, admin.cookie, {
          scheduledAt: past,
          channelPlan: { mode: "media", versionId: v.id, delayMinutes: 0 },
        })
      ).status,
    ).toBe(200);
    await publishDuePosts();
    await new Promise((r) => setTimeout(r, 150));

    // Rasm yaroqsiz bo'lib qoladi (rejalashtirishdan keyin).
    await upload("r-cover.png", await solid(2500, 100).png().toBuffer());
    clearPreparedImageCache();
    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    await runDueChannelSends();

    const [row] = await db.select().from(posts).where(eq(posts.id, post.id));
    expect((row!.channelPlan as { attempts?: number }).attempts).toBe(1);
    expect(sentCalls(await mockCalls()).filter((c) => String(c.body.chat_id) !== "777")).toHaveLength(0);
  });
});

describe("preview channel header", () => {
  it("returns the channel title/username resolved via getChat", async () => {
    clearChannelInfoCache();
    const post = await makePost();
    const res = await api("POST", `/admin/posts/${post.id}/channel/preview`, admin.cookie, { mode: "text", variant: "m" });
    expect(res.status).toBe(200);
    const body = await json<{ channel: { title: string | null; username: string | null }; variant: string; versionId: string | null }>(res);
    expect(body.channel).toEqual({ title: "Mock kanal @testchannel", username: "testchannel" });
    expect(body.variant).toBe("m");
    expect(body.versionId).toBeNull();
    const calls = await mockCalls();
    expect(calls.filter((c) => c.method === "getChat")).toHaveLength(1);

    // keshdan: ikkinchi so'rov getChat'ni qayta chaqirmaydi
    await api("POST", `/admin/posts/${post.id}/channel/preview`, admin.cookie, { mode: "text", variant: "m" });
    expect((await mockCalls()).filter((c) => c.method === "getChat")).toHaveLength(1);
  });

  it("falls back to the configured id when getChat fails", async () => {
    clearChannelInfoCache();
    await fetch(`${MOCK_ROOT}/__fail`, { method: "POST", body: JSON.stringify({ method: "getChat", count: 1 }) });
    const post = await makePost();
    const res = await api("POST", `/admin/posts/${post.id}/channel/preview`, admin.cookie, { mode: "text", variant: "m" });
    const body = await json<{ channel: { title: string | null; username: string | null } }>(res);
    expect(body.channel).toEqual({ title: null, username: "testchannel" });
    clearChannelInfoCache();
  });
});

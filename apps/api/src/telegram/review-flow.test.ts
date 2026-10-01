import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { startMockTelegram } from "../../scripts/mock-telegram.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { channelPostVersions, posts, telegramRefs } from "../db/schema.js";
import { uploadsDir } from "../lib/media/store.js";
import { invalidateSettingsCache, saveSettings } from "../lib/settings.js";
import { initTelegram } from "./bot.js";
import { migrateTestDb } from "../test/migrate-test-db.js";
import { createTestUser, type TestUser } from "../test/auth-test-helpers.js";

// 1x1 shaffof PNG — sharp bemalol JPEG'ga aylantira oladigan minimal haqiqiy rasm (🖼 rejim sinovi uchun).
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function writeTestUpload(name: string): Promise<string> {
  const key = `test-review-flow/${name}`;
  const filePath = path.join(uploadsDir, key);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, TINY_PNG);
  return `${config.API_ORIGIN}/uploads/${key}`;
}

/**
 * "Telegram tasdiqlash oqimi" end-to-end sinovi (spec bandi #3): xodim
 * postni ko'rib chiqishga yuboradi -> admin "✅ Chop etish"ni "bosadi"
 * (webhook orqali soxta `callback_query`) -> bot variant tugmalarini
 * yuboradi -> admin variant tanlaydi -> bot AYNAN shu ko'rinishni admin
 * chatida oldindan ko'rsatadi va tasdiqlash so'raydi -> admin
 * "✅ Kanalga yuborish"ni bosadi -> post HAQIQATDA kanalga (mock serverga)
 * yuboriladi, ikkinchi marta bosilsa ikkilanmaydi (idempotent).
 */

let MOCK_ROOT = "";
let mockServer: { url: string; close: () => Promise<void> } | null = null;
const WEBHOOK_SECRET = "fedcba9876543210";
const ADMIN_TG_USER_ID = 555111222;
const ADMIN_CHAT_ID = 555111222; // shaxsiy chat — odatda user id bilan bir xil

let app: Hono;
let staff: TestUser;
let updateIdCounter = 1;

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
function postJson(path: string, cookie: string | null, body?: unknown) {
  return req(path, cookie, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined });
}
async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function callbackUpdate(data: string, messageId: number, text = "") {
  return {
    update_id: updateIdCounter++,
    callback_query: {
      id: String(updateIdCounter),
      from: { id: ADMIN_TG_USER_ID, is_bot: false, first_name: "Admin" },
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: ADMIN_CHAT_ID, type: "private", first_name: "Admin" },
        text,
      },
      chat_instance: "test-instance",
      data,
    },
  };
}

async function sendWebhookUpdate(update: unknown): Promise<Response> {
  return app.request("/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
    body: JSON.stringify(update),
  });
}

async function mockCalls(): Promise<{ method: string; body: Record<string, unknown> }[]> {
  const res = await fetch(`${MOCK_ROOT}/__calls`);
  const data = (await res.json()) as { calls: { method: string; body: Record<string, unknown> }[] };
  return data.calls;
}

beforeAll(async () => {
  mockServer = await startMockTelegram();
  MOCK_ROOT = mockServer.url;
  await migrateTestDb();
  ({ app } = await import("../app.js"));
  // `findAdminUser()` (review.ts) faqat DB'da BIRON BIR admin-rolli
  // foydalanuvchi borligini talab qiladi — Telegram user id bilan bog'liq emas.
  await createTestUser({ role: "admin", name: "Admin" });
  staff = await createTestUser({ role: "staff", name: "Xodim" });

  // `.env`dagi `TELEGRAM_API_ROOT` env-qulflashini bekor qilamiz (mock serverga
  // yo'naltirish uchun) — batafsil izoh: `admin-posts-channel.test.ts`.
  delete process.env.TELEGRAM_API_ROOT;
  invalidateSettingsCache();

  initTelegram();
  await saveSettings({
    telegram: {
      botToken: "test-bot-token-review-flow",
      webhookSecret: WEBHOOK_SECRET,
      adminChatId: String(ADMIN_CHAT_ID),
      adminUserIds: String(ADMIN_TG_USER_ID),
      channelId: "@testchannel2",
      apiRoot: MOCK_ROOT,
    },
  });

  await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
});

describe("Telegram approval -> variant -> preview -> send flow (fake webhook callbacks)", () => {
  it("runs end to end and is idempotent on double-send", async () => {
    // 1) Xodim post yaratadi va ko'rib chiqishga yuboradi.
    const createRes = await postJson("/admin/posts", staff.cookie, { title: "Telegram oqimi sinovi" });
    expect(createRes.status).toBe(201);
    const created = await json<{ id: string }>(createRes);
    const submitRes = await postJson(`/admin/posts/${created.id}/submit`, staff.cookie);
    expect(submitRes.status).toBe(200);

    // 2) Admin "✅ Chop etish"ni bosadi (`pr:ok:<postId>`).
    const approveUpdate = callbackUpdate(`pr:ok:${created.id}`, 9001, "📝 Ko'rib chiqish uchun yangi post");
    const approveRes = await sendWebhookUpdate(approveUpdate);
    expect(approveRes.status).toBe(200);

    const postAfterApprove = await db.select().from(posts).where(eq(posts.id, created.id)).then((r) => r[0]);
    expect(postAfterApprove?.status).toBe("published");

    const callsAfterApprove = await mockCalls();
    // Postda kover/rasm yo'q — faqat 📝 qatori ko'rsatiladi (🖼 tugmalari yo'q).
    const variantPrompt = callsAfterApprove.find(
      (c) =>
        c.method === "sendMessage" &&
        JSON.stringify(c.body.reply_markup ?? "").includes(`cs:ts:${created.id}`),
    );
    expect(variantPrompt).toBeTruthy();
    expect(JSON.stringify(variantPrompt?.body.reply_markup ?? "")).not.toContain(`cs:mm:${created.id}`);

    // 3) Admin "📝 O'rtacha" variantini tanlaydi (`cs:tm:<postId>`).
    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    const variantUpdate = callbackUpdate(`cs:tm:${created.id}`, 9002);
    const variantRes = await sendWebhookUpdate(variantUpdate);
    expect(variantRes.status).toBe(200);

    const callsAfterVariant = await mockCalls();
    // Kanalga yubormasdan OLDIN faqat oldindan ko'rish (admin chatiga, oddiy matn) + tasdiqlash so'rovi.
    expect(callsAfterVariant.some((c) => c.method === "sendMessage")).toBe(true);
    expect(callsAfterVariant.some((c) => c.method === "sendMediaGroup" || c.method === "sendPhoto")).toBe(false);
    const confirmPrompt = callsAfterVariant.find(
      (c) => c.method === "sendMessage" && JSON.stringify(c.body.reply_markup ?? "").includes(`cc:ok:tm:${created.id}`),
    );
    expect(confirmPrompt).toBeTruthy();

    const refBeforeSend = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, created.id)).then((r) => r[0]);
    expect(refBeforeSend?.channelSentAt ?? null).toBeNull(); // hali haqiqiy kanalga yuborilmagan — faqat preview edi

    // 4) Admin "✅ Kanalga yuborish"ni bosadi (`cc:ok:tm:<postId>`).
    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    const confirmUpdate = callbackUpdate(`cc:ok:tm:${created.id}`, 9003);
    const confirmRes = await sendWebhookUpdate(confirmUpdate);
    expect(confirmRes.status).toBe(200);

    const refAfterSend = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, created.id)).then((r) => r[0]);
    expect(refAfterSend?.channelSentAt).toBeTruthy();
    expect(refAfterSend?.channelVariant).toBe("m");
    expect(refAfterSend?.channelMode).toBe("text");
    expect(refAfterSend?.channelMessageType).toBe("text");
    const firstMessageIds = refAfterSend?.channelMessageIds ?? [];

    // 5) Xuddi shu tasdiqlashni yana bosadi — IKKINCHI marta yubormasligi kerak (idempotent).
    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    const confirmAgainRes = await sendWebhookUpdate(callbackUpdate(`cc:ok:tm:${created.id}`, 9004));
    expect(confirmAgainRes.status).toBe(200);

    const callsAfterSecondConfirm = await mockCalls();
    expect(
      callsAfterSecondConfirm.some((c) => c.method === "sendMediaGroup" || c.method === "sendPhoto" || c.method === "sendMessage"),
    ).toBe(false);

    const refAfterSecondConfirm = await db
      .select()
      .from(telegramRefs)
      .where(eq(telegramRefs.postId, created.id))
      .then((r) => r[0]);
    expect(refAfterSecondConfirm?.channelMessageIds).toEqual(firstMessageIds);
  });

  it("supports a 🖼 media-mode callback flow end-to-end (cover-only post)", async () => {
    const coverUrl = await writeTestUpload("cover.png");
    const createRes = await postJson("/admin/posts", staff.cookie, { title: "Rasmli oqim sinovi" });
    expect(createRes.status).toBe(201);
    const created = await json<{ id: string }>(createRes);

    const patchRes = await req(`/admin/posts/${created.id}`, staff.cookie, {
      method: "PATCH",
      body: JSON.stringify({ coverUrl }),
    });
    expect(patchRes.status).toBe(200);
    await postJson(`/admin/posts/${created.id}/submit`, staff.cookie);

    // 1) Admin "✅ Chop etish"ni bosadi — postda kover bor, shu sabab 🖼 qatori ko'rsatilishi kerak.
    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    const approveUpdate = callbackUpdate(`pr:ok:${created.id}`, 9201, "📝 Ko'rib chiqish uchun yangi post");
    const approveRes = await sendWebhookUpdate(approveUpdate);
    expect(approveRes.status).toBe(200);

    const callsAfterApprove = await mockCalls();
    const variantPrompt = callsAfterApprove.find(
      (c) => c.method === "sendMessage" && JSON.stringify(c.body.reply_markup ?? "").includes(`cs:mm:${created.id}`),
    );
    expect(variantPrompt).toBeTruthy();

    // 2) Admin "🖼 O'rtacha"ni tanlaydi (`cs:mm:<postId>`).
    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    const variantRes = await sendWebhookUpdate(callbackUpdate(`cs:mm:${created.id}`, 9202));
    expect(variantRes.status).toBe(200);

    const callsAfterVariant = await mockCalls();
    // Faqat kover bor -> preview bitta sendPhoto (albom emas).
    expect(callsAfterVariant.some((c) => c.method === "sendPhoto")).toBe(true);
    const confirmPrompt = callsAfterVariant.find(
      (c) => c.method === "sendMessage" && JSON.stringify(c.body.reply_markup ?? "").includes(`cc:ok:mm:${created.id}`),
    );
    expect(confirmPrompt).toBeTruthy();

    // 3) Admin "✅ Kanalga yuborish"ni bosadi (`cc:ok:mm:<postId>`).
    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    const confirmRes = await sendWebhookUpdate(callbackUpdate(`cc:ok:mm:${created.id}`, 9203));
    expect(confirmRes.status).toBe(200);

    const ref = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, created.id)).then((r) => r[0]);
    expect(ref?.channelSentAt).toBeTruthy();
    expect(ref?.channelMode).toBe("media");
    expect(ref?.channelVariant).toBe("m");
    expect(ref?.channelMessageType).toBe("photo");
  });

  it("rejects a callback from a Telegram user id that is not in adminUserIds", async () => {
    const createRes = await postJson("/admin/posts", staff.cookie, { title: "Ruxsatsiz foydalanuvchi sinovi" });
    const created = await json<{ id: string }>(createRes);
    await postJson(`/admin/posts/${created.id}/submit`, staff.cookie);

    const rogueUpdate = {
      update_id: updateIdCounter++,
      callback_query: {
        id: String(updateIdCounter),
        from: { id: 999999999999, is_bot: false, first_name: "Notanish" },
        message: {
          message_id: 9100,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 999999999999, type: "private", first_name: "Notanish" },
          text: "",
        },
        chat_instance: "test-instance",
        data: `pr:ok:${created.id}`,
      },
    };

    const res = await sendWebhookUpdate(rogueUpdate);
    expect(res.status).toBe(200); // webhook har doim 200 qaytaradi (Telegram qayta urinmasin uchun)

    const post = await db.select().from(posts).where(eq(posts.id, created.id)).then((r) => r[0]);
    // Admin-gate middleware yo'lni to'sgani sababli post HALI HAM `in_review`da qolishi kerak.
    expect(post?.status).toBe("in_review");
  });
});

type MockCall = { method: string; body: Record<string, unknown> };

/** `reply_markup`dagi barcha inline tugmalar (qatorlar bo'yicha). */
function buttonRows(call: MockCall | undefined): { text: string; callback_data?: string }[][] {
  const markup = call?.body.reply_markup as { inline_keyboard?: { text: string; callback_data?: string }[][] } | undefined;
  return markup?.inline_keyboard ?? [];
}

function findPrompt(calls: MockCall[], needle: string): MockCall | undefined {
  return calls.find((c) => c.method === "sendMessage" && JSON.stringify(c.body.reply_markup ?? "").includes(needle));
}

async function createPublishedViaReview(title: string, patch: Record<string, unknown> = {}): Promise<string> {
  const createRes = await postJson("/admin/posts", staff.cookie, { title });
  expect(createRes.status).toBe(201);
  const created = await json<{ id: string }>(createRes);
  if (Object.keys(patch).length > 0) {
    const patchRes = await req(`/admin/posts/${created.id}`, staff.cookie, { method: "PATCH", body: JSON.stringify(patch) });
    expect(patchRes.status).toBe(200);
  }
  expect((await postJson(`/admin/posts/${created.id}/submit`, staff.cookie)).status).toBe(200);
  return created.id;
}

async function insertTextVersion(postId: string, name: string, textHtml: string, createdAt: Date) {
  const [row] = await db
    .insert(channelPostVersions)
    .values({
      postId,
      name,
      mode: "text",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: name }] }] },
      textHtml,
      visibleLength: textHtml.replace(/<[^>]+>/g, "").length,
      imageUrls: [],
      createdAt,
      updatedAt: createdAt,
    })
    .returning();
  return row!;
}

describe("custom versions in the Telegram approval flow", () => {
  it("shows version buttons only when versions exist (newest first, max 6, callback data <= 64 bytes)", async () => {
    // Versiyasiz post — `cv:` tugmalari YO'Q.
    const plainId = await createPublishedViaReview("Versiyasiz post");
    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    await sendWebhookUpdate(callbackUpdate(`pr:ok:${plainId}`, 9301, "📝 Ko'rib chiqish uchun yangi post"));
    const plainPrompt = findPrompt(await mockCalls(), `cs:ts:${plainId}`);
    expect(plainPrompt).toBeTruthy();
    expect(JSON.stringify(plainPrompt?.body.reply_markup)).not.toContain('"cv:');

    // 8 ta versiyali post — eng yangi 6 tasi, har biri alohida qatorda, "Yubormaslik"dan oldin.
    const id = await createPublishedViaReview("Versiyali post");
    const base = Date.now() - 100_000;
    const created: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const long = i === 7 ? "Juda uzun nomli maxsus versiya — kanal uchun mo'ljallangan variant" : `Versiya ${i + 1}`;
      const v = await insertTextVersion(id, long, `Matn ${i + 1}`, new Date(base + i * 1000));
      created.push(v.id);
    }
    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    await sendWebhookUpdate(callbackUpdate(`pr:ok:${id}`, 9302, "📝 Ko'rib chiqish uchun yangi post"));
    const prompt = findPrompt(await mockCalls(), `cs:ts:${id}`);
    expect(prompt).toBeTruthy();
    const rows = buttonRows(prompt);
    const versionRows = rows.filter((r) => r[0]?.callback_data?.startsWith("cv:"));
    expect(versionRows).toHaveLength(6);
    expect(versionRows.every((r) => r.length === 1)).toBe(true);
    expect(versionRows.map((r) => r[0]!.callback_data)).toEqual(created.slice(2).reverse().map((vid) => `cv:${vid}`));
    expect(versionRows[0]![0]!.text.startsWith("✍️ ")).toBe(true);
    expect(versionRows[0]![0]!.text.length).toBeLessThanOrEqual(2 + 1 + 28);
    // "Yubormaslik" oxirgi qator, versiyalardan keyin.
    const lastRow = rows[rows.length - 1]!;
    expect(lastRow[0]?.callback_data).toBe(`cs:no:${id}`);
    for (const row of rows) for (const b of row) expect(Buffer.byteLength(b.callback_data ?? "", "utf8")).toBeLessThanOrEqual(64);
  });

  it("previews a chosen version, confirms, sends it (records channel_version_id) and is idempotent", async () => {
    const id = await createPublishedViaReview("Versiya yuborish sinovi");
    const v = await insertTextVersion(id, "Maxsus matn", "Maxsus <b>versiya</b> matni", new Date());
    await sendWebhookUpdate(callbackUpdate(`pr:ok:${id}`, 9311, "📝"));

    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    expect((await sendWebhookUpdate(callbackUpdate(`cv:${v.id}`, 9312))).status).toBe(200);
    const afterPick = await mockCalls();
    // Oldindan ko'rish (admin chatiga) + tasdiqlash tugmalari; hali kanalga yuborilmagan.
    const confirm = findPrompt(afterPick, `cvc:ok:${v.id}`);
    expect(confirm).toBeTruthy();
    const confirmData = buttonRows(confirm).flat().map((b) => b.callback_data ?? "");
    expect(confirmData).toEqual([`cvc:ok:${v.id}`, `cvc:back:${v.id}`, `cvc:cancel:${v.id}`]);
    for (const d of confirmData) expect(Buffer.byteLength(d, "utf8")).toBeLessThanOrEqual(64);
    expect(afterPick.some((c) => c.method === "sendMessage" && String(c.body.text).includes("Maxsus"))).toBe(true);
    const refBefore = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, id)).then((r) => r[0]);
    expect(refBefore?.channelSentAt ?? null).toBeNull();

    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    expect((await sendWebhookUpdate(callbackUpdate(`cvc:ok:${v.id}`, 9313))).status).toBe(200);
    const ref = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, id)).then((r) => r[0]);
    expect(ref?.channelSentAt).toBeTruthy();
    expect(ref?.channelVersionId).toBe(v.id);
    expect(ref?.channelVariant ?? null).toBeNull();
    const ids = ref?.channelMessageIds ?? [];

    // Ikkinchi tasdiqlash — qayta yubormaydi.
    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    await sendWebhookUpdate(callbackUpdate(`cvc:ok:${v.id}`, 9314));
    expect((await mockCalls()).some((c) => c.method === "sendMessage" && String(c.body.chat_id).startsWith("@"))).toBe(false);
    const again = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, id)).then((r) => r[0]);
    expect(again?.channelMessageIds).toEqual(ids);
  });

  it("reports preflight reasons for a failing version and does not send it", async () => {
    const id = await createPublishedViaReview("Versiya xato sinovi");
    const bad = await insertTextVersion(id, "Bo'sh <versiya>", "", new Date());
    await sendWebhookUpdate(callbackUpdate(`pr:ok:${id}`, 9321, "📝"));

    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    await sendWebhookUpdate(callbackUpdate(`cv:${bad.id}`, 9322));
    const calls = await mockCalls();
    expect(findPrompt(calls, `cvc:ok:${bad.id}`)).toBeUndefined();
    const reasons = calls.find((c) => c.method === "sendMessage" && String(c.body.text).includes("Telegram cheklovi"));
    expect(reasons).toBeTruthy();
    expect(String(reasons?.body.text)).toContain("Matn bo'sh");
    expect(reasons?.body.parse_mode).toBe("HTML");

    // To'g'ridan-to'g'ri tasdiqlash ham yubormaydi (server preflight), sabablar chiqadi.
    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    await sendWebhookUpdate(callbackUpdate(`cvc:ok:${bad.id}`, 9323));
    const ref = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, id)).then((r) => r[0]);
    expect(ref?.channelSentAt ?? null).toBeNull();
    expect((await mockCalls()).some((c) => c.method === "sendMessage" && String(c.body.text).includes("Matn bo'sh"))).toBe(true);
  });

  it("an auto variant that fails preflight shows the reasons instead of a generic error", async () => {
    // Kover URL'i mavjud emas — 🖼 rejim preflight'da rasm xatosi beradi.
    const missing = `${config.API_ORIGIN}/uploads/test-review-flow/missing-${Date.now()}.png`;
    const id = await createPublishedViaReview("Avto xato sinovi", { coverUrl: missing });
    await sendWebhookUpdate(callbackUpdate(`pr:ok:${id}`, 9331, "📝"));

    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    await sendWebhookUpdate(callbackUpdate(`cs:mm:${id}`, 9332));
    const calls = await mockCalls();
    expect(findPrompt(calls, `cc:ok:mm:${id}`)).toBeUndefined();
    expect(calls.some((c) => c.method === "sendMessage" && String(c.body.text).includes("Telegram cheklovi"))).toBe(true);
    expect(calls.some((c) => c.method === "sendMessage" && String(c.body.text).includes("xatolik yuz berdi"))).toBe(false);
  });
});

describe("⭐ marked channel version in the Telegram approval flow", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  it("mentions the prepared version in the review notification, shows it as the first button row, previews and sends it once", async () => {
    const createRes = await postJson("/admin/posts", staff.cookie, { title: "Belgilangan versiya oqimi" });
    const { id } = await json<{ id: string }>(createRes);
    const vRes = await postJson(`/admin/posts/${id}/channel/versions`, staff.cookie, { mode: "text", fromVariant: "m", name: "Xodim versiyasi" });
    expect(vRes.status).toBe(201);
    const version = await json<{ id: string }>(vRes);
    const markRes = await req(`/admin/posts/${id}/channel/choice`, staff.cookie, {
      method: "PUT",
      body: JSON.stringify({ kind: "version", versionId: version.id }),
    });
    expect(markRes.status).toBe(200);

    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    expect((await postJson(`/admin/posts/${id}/submit`, staff.cookie)).status).toBe(200);
    await settle();
    const notice = (await mockCalls()).find((c) => c.method === "sendMessage" && String(c.body.text).includes("Ko'rib chiqish uchun yangi post"));
    expect(String(notice?.body.text)).toContain("⭐ Kanal versiyasi tayyorlangan: Xodim versiyasi");

    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    await sendWebhookUpdate(callbackUpdate(`pr:ok:${id}`, 9401, "📝"));
    const prompt = findPrompt(await mockCalls(), `cm:${id}`);
    expect(prompt).toBeTruthy();
    const rows = buttonRows(prompt);
    expect(rows[0]).toHaveLength(1);
    expect(rows[0]![0]!.callback_data).toBe(`cm:${id}`);
    expect(rows[0]![0]!.text).toBe("⭐ Belgilangan: Xodim versiyasi");
    for (const row of rows) for (const b of row) expect(Buffer.byteLength(b.callback_data ?? "", "utf8")).toBeLessThanOrEqual(64);

    // ⭐ bosiladi -> preflight -> aniq preview -> tasdiqlash (maxsus versiya oqimi).
    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    expect((await sendWebhookUpdate(callbackUpdate(`cm:${id}`, 9402))).status).toBe(200);
    const afterPick = await mockCalls();
    expect(findPrompt(afterPick, `cvc:ok:${version.id}`)).toBeTruthy();
    expect(afterPick.some((c) => c.method === "sendMessage" && String(c.body.chat_id).startsWith("@"))).toBe(false);

    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    await sendWebhookUpdate(callbackUpdate(`cvc:ok:${version.id}`, 9403));
    const ref = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, id)).then((r) => r[0]);
    expect(ref?.channelSentAt).toBeTruthy();
    expect(ref?.channelVersionId).toBe(version.id);
    const ids = ref?.channelMessageIds ?? [];

    // Idempotent: ⭐ -> tasdiqlash qayta bosilsa ikkinchi marta yuborilmaydi.
    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    await sendWebhookUpdate(callbackUpdate(`cvc:ok:${version.id}`, 9404));
    expect((await mockCalls()).some((c) => c.method === "sendMessage" && String(c.body.chat_id).startsWith("@"))).toBe(false);
    const again = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, id)).then((r) => r[0]);
    expect(again?.channelMessageIds).toEqual(ids);
  });

  it("an auto mark goes through the same auto confirm flow; no mark -> no ⭐ row", async () => {
    const id = await createPublishedViaReview("Avto belgi oqimi");
    const markRes = await req(`/admin/posts/${id}/channel/choice`, staff.cookie, { method: "PUT", body: JSON.stringify({ kind: "auto", mode: "text", variant: "s" }) });
    // `createPublishedViaReview` allaqachon `in_review` — xodim endi belgilay olmaydi (faqat o'qish).
    expect(markRes.status).toBe(409);
    const [row] = await db.select().from(posts).where(eq(posts.id, id));
    await db.update(posts).set({ channelChoice: { kind: "auto", mode: "text", variant: "s" }, channelChoiceBy: row!.createdBy }).where(eq(posts.id, id));

    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    await sendWebhookUpdate(callbackUpdate(`pr:ok:${id}`, 9411, "📝"));
    const prompt = findPrompt(await mockCalls(), `cm:${id}`);
    expect(buttonRows(prompt)[0]![0]!.text).toBe("⭐ Belgilangan: Rasmsiz · Qisqa");

    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    await sendWebhookUpdate(callbackUpdate(`cm:${id}`, 9412));
    expect(findPrompt(await mockCalls(), `cc:ok:ts:${id}`)).toBeTruthy();
    await sendWebhookUpdate(callbackUpdate(`cc:ok:ts:${id}`, 9413));
    const ref = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, id)).then((r) => r[0]);
    expect(ref?.channelVariant).toBe("s");

    const plainId = await createPublishedViaReview("Belgisiz post");
    await fetch(`${MOCK_ROOT}/__calls`, { method: "DELETE" });
    await sendWebhookUpdate(callbackUpdate(`pr:ok:${plainId}`, 9414, "📝"));
    expect(findPrompt(await mockCalls(), `cs:ts:${plainId}`)).toBeTruthy();
    expect(JSON.stringify(findPrompt(await mockCalls(), `cs:ts:${plainId}`)?.body.reply_markup)).not.toContain('"cm:');
  });
});

afterAll(async () => {
  await mockServer?.close();
  await rm(path.join(uploadsDir, "test-review-flow"), { recursive: true, force: true });
});

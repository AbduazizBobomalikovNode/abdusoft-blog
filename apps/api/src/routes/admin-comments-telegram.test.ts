import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startMockTelegram } from "../../scripts/mock-telegram.js";
import { db } from "../db/index.js";
import { comments, posts } from "../db/schema.js";
import { invalidateSettingsCache, saveSettings } from "../lib/settings.js";
import { reconfigureBot } from "../telegram/client.js";
import { createTestUser, type TestUser } from "../test/auth-test-helpers.js";
import { migrateTestDb } from "../test/migrate-test-db.js";

const GROUP = -1009876543210;

let mock: { url: string; close: () => Promise<void> };
let app: Hono;
let admin: TestUser;
let postId: string;
let seq = 7000;

type Call = { method: string; body: Record<string, unknown> };
async function calls(method?: string): Promise<Call[]> {
  const res = await fetch(`${mock.url}/__calls`);
  const all = ((await res.json()) as { calls: Call[] }).calls;
  return method ? all.filter((c) => c.method === method) : all;
}
async function resetMock() {
  await fetch(`${mock.url}/__calls`, { method: "DELETE" });
  await fetch(`${mock.url}/__fail`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "sendMessage", count: 0 }),
  });
}
function failNext(method: string) {
  return fetch(`${mock.url}/__fail`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, count: 1 }),
  });
}
function post(path: string, body?: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { cookie: admin.cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
function patch(path: string, body: unknown) {
  return app.request(path, {
    method: "PATCH",
    headers: { cookie: admin.cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function tgComment(opts: { tgUserId?: number | null; tgMessageId?: number | null } = {}) {
  const messageId = opts.tgMessageId === undefined ? ++seq : opts.tgMessageId;
  const [row] = await db
    .insert(comments)
    .values({
      postId,
      path: String(++seq).padStart(4, "0"),
      depth: 0,
      authorName: "Ali",
      body: "TG izoh",
      bodyHtml: "<p>TG izoh</p>",
      source: "telegram",
      tgChatId: GROUP,
      tgMessageId: messageId,
      tgUserId: opts.tgUserId === undefined ? 111 : opts.tgUserId,
    })
    .returning();
  return row!;
}
async function rowsOf(parentId: string) {
  return db.select().from(comments).where(eq(comments.parentId, parentId));
}
async function counters() {
  const [p] = await db.select().from(posts).where(eq(posts.id, postId));
  return { web: p!.commentsCount, tg: p!.tgCommentsCount };
}

beforeAll(async () => {
  mock = await startMockTelegram();
  await migrateTestDb();
  ({ app } = await import("../app.js"));
  admin = await createTestUser({ role: "admin", name: "Muallif" });
  delete process.env.TELEGRAM_API_ROOT;
  invalidateSettingsCache();
  await saveSettings({
    telegram: { botToken: "test-bot-token", webhookSecret: "0123456789abcdef", channelId: "@testchannel", apiRoot: mock.url },
  });
  reconfigureBot("test-bot-token", mock.url);

  const [p] = await db
    .insert(posts)
    .values({
      slug: `tg-reply-${Date.now()}`,
      title: "T",
      contentJson: { type: "doc", content: [] },
      contentHtml: "<p></p>",
      contentText: "",
      toc: [],
      status: "published",
    })
    .returning();
  postId = p!.id;
});

afterAll(async () => {
  reconfigureBot("", "");
  await mock.close();
});

beforeEach(resetMock);

describe("admin reply to a Telegram comment", () => {
  it("sends one sendMessage into the group as a reply and stores a telegram row", async () => {
    const parent = await tgComment();
    const res = await post(`/admin/comments/${parent.id}/reply`, { body: "Rahmat!" });
    expect(res.status).toBe(201);

    const sent = await calls("sendMessage");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.chat_id).toBe(GROUP);
    expect(sent[0]!.body.text).toBe("Rahmat!");
    expect((sent[0]!.body.reply_parameters as { message_id: number }).message_id).toBe(parent.tgMessageId);
    expect(sent[0]!.body.parse_mode).toBeUndefined();

    const [reply] = await rowsOf(parent.id);
    expect(reply).toMatchObject({
      source: "telegram",
      tgChatId: GROUP,
      tgUserId: null,
      authorUserId: admin.id,
      authorName: "Muallif",
      status: "visible",
      parentId: parent.id,
    });
    expect(reply!.tgMessageId).toBeGreaterThan(1000);
    expect((await counters()).tg).toBeGreaterThanOrEqual(2);
  });

  it("stores nothing and returns 502 with an Uzbek message when Telegram fails", async () => {
    const parent = await tgComment();
    await failNext("sendMessage");
    const res = await post(`/admin/comments/${parent.id}/reply`, { body: "Xato" });
    expect(res.status).toBe(502);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Telegram guruhiga yuborib bo'lmadi");
    expect(await rowsOf(parent.id)).toHaveLength(0);
  });

  it("returns 409 when the bot is not configured", async () => {
    const parent = await tgComment();
    reconfigureBot("", "");
    try {
      const res = await post(`/admin/comments/${parent.id}/reply`, { body: "Bot yo'q" });
      expect(res.status).toBe(409);
      expect(await rowsOf(parent.id)).toHaveLength(0);
    } finally {
      reconfigureBot("test-bot-token", mock.url);
    }
  });

  it("returns 409 for a Telegram comment without tg_message_id", async () => {
    const parent = await tgComment({ tgMessageId: null });
    const res = await post(`/admin/comments/${parent.id}/reply`, { body: "x" });
    expect(res.status).toBe(409);
    expect(await calls("sendMessage")).toHaveLength(0);
    expect(await rowsOf(parent.id)).toHaveLength(0);
  });

  it("a later user reply to the bot's message threads under it", async () => {
    const parent = await tgComment();
    await post(`/admin/comments/${parent.id}/reply`, { body: "Javob" });
    const [reply] = await rowsOf(parent.id);

    const { tryHandleGroupComment } = await import("../telegram/discussion.js");
    const ok = await tryHandleGroupComment({
      message: {
        message_id: ++seq,
        text: "Yana savol",
        reply_to_message: { message_id: reply!.tgMessageId },
      },
      from: { id: 222, is_bot: false, first_name: "Vali" },
      chat: { id: GROUP, type: "supergroup" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal grammY Context fixture
    } as any);
    expect(ok).toBe(true);
    const [child] = await rowsOf(reply!.id);
    expect(child).toMatchObject({ source: "telegram", tgUserId: 222, parentId: reply!.id });
  });

  it("hiding the bot's reply deletes its group message; ban is unavailable", async () => {
    const parent = await tgComment();
    await post(`/admin/comments/${parent.id}/reply`, { body: "Javob" });
    const [reply] = await rowsOf(parent.id);

    const banRes = await post(`/admin/comments/${reply!.id}/ban`, {});
    expect(banRes.status).toBe(409);
    expect(await calls("banChatMember")).toHaveLength(0);

    const list = (await (await app.request(`/admin/comments?postId=${postId}&limit=100`, { headers: { cookie: admin.cookie } })).json()) as {
      items: { id: string; canBan: boolean; authorIsAdmin: boolean; source: string }[];
    };
    const item = list.items.find((i) => i.id === reply!.id)!;
    expect(item).toMatchObject({ canBan: false, authorIsAdmin: true, source: "telegram" });
    expect(list.items.find((i) => i.id === parent.id)!.canBan).toBe(true);

    const res = await patch(`/admin/comments/${reply!.id}`, { status: "hidden" });
    expect(res.status).toBe(200);
    const del = await calls("deleteMessage");
    expect(del).toHaveLength(1);
    expect(del[0]!.body).toMatchObject({ chat_id: GROUP, message_id: reply!.tgMessageId });
  });

  it("bulk hide deletes the group messages of Telegram comments too", async () => {
    const a = await tgComment();
    const b = await tgComment();
    const res = await post(`/admin/comments/bulk`, { ids: [a.id, b.id], status: "hidden" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { updated: number }).updated).toBe(2);
    const del = await calls("deleteMessage");
    expect(del.map((d) => (d.body as { message_id: number }).message_id).sort()).toEqual([a.tgMessageId, b.tgMessageId].sort());
    const rows = await db.select().from(comments).where(eq(comments.id, a.id));
    expect(rows[0]!.status).toBe("hidden");
  });

  it("ban is unavailable for a channel/anonymous comment without tg_user_id", async () => {
    const c = await tgComment({ tgUserId: null });
    expect((await post(`/admin/comments/${c.id}/ban`, {})).status).toBe(409);
  });
});

describe("admin reply to a web comment", () => {
  it("is unchanged — no Telegram call, source web", async () => {
    const [web] = await db
      .insert(comments)
      .values({ postId, path: String(++seq).padStart(4, "0"), depth: 0, authorName: "Web", body: "w", bodyHtml: "<p>w</p>" })
      .returning();
    const res = await post(`/admin/comments/${web!.id}/reply`, { body: "Salom" });
    expect(res.status).toBe(201);
    expect(await calls("sendMessage")).toHaveLength(0);
    const [reply] = await rowsOf(web!.id);
    expect(reply).toMatchObject({ source: "web", tgChatId: null, tgMessageId: null, authorUserId: admin.id });
  });
});

describe("POST /admin/comments/:id/send-to-telegram", () => {
  async function legacyWebReply(parent: { id: string; path: string }) {
    const [row] = await db
      .insert(comments)
      .values({
        postId,
        parentId: parent.id,
        path: `${parent.path}.0001`,
        depth: 1,
        authorName: "Muallif",
        authorUserId: admin.id,
        body: "Eski javob",
        bodyHtml: "<p>Eski javob</p>",
      })
      .returning();
    return row!;
  }

  it("converts a legacy web admin reply once, then 409", async () => {
    const parent = await tgComment();
    const legacy = await legacyWebReply(parent);

    const res = await post(`/admin/comments/${legacy.id}/send-to-telegram`);
    expect(res.status).toBe(200);
    const sent = await calls("sendMessage");
    expect(sent).toHaveLength(1);
    expect((sent[0]!.body.reply_parameters as { message_id: number }).message_id).toBe(parent.tgMessageId);

    const [after] = await db.select().from(comments).where(eq(comments.id, legacy.id));
    expect(after).toMatchObject({ source: "telegram", tgChatId: GROUP, tgUserId: null });
    expect(after!.tgMessageId).toBeGreaterThan(1000);

    const again = await post(`/admin/comments/${legacy.id}/send-to-telegram`);
    expect(again.status).toBe(409);
    expect(await calls("sendMessage")).toHaveLength(1);
  });

  it("409 when the parent is not a Telegram comment; stores nothing on failure", async () => {
    const [web] = await db
      .insert(comments)
      .values({ postId, path: String(++seq).padStart(4, "0"), depth: 0, authorName: "Web", body: "w", bodyHtml: "<p>w</p>" })
      .returning();
    const reply = await legacyWebReply(web!);
    expect((await post(`/admin/comments/${reply.id}/send-to-telegram`)).status).toBe(409);

    const parent = await tgComment();
    const legacy = await legacyWebReply(parent);
    await failNext("sendMessage");
    expect((await post(`/admin/comments/${legacy.id}/send-to-telegram`)).status).toBe(502);
    const [still] = await db.select().from(comments).where(eq(comments.id, legacy.id));
    expect(still!.source).toBe("web");
  });
});

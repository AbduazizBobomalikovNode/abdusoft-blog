import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import { comments, posts, telegramRefs } from "../db/schema.js";
import { migrateTestDb } from "../test/migrate-test-db.js";
import { invalidateSettingsCache } from "../lib/settings.js";
import { upsertSiteSetting } from "../lib/site-settings.js";

const CHANNEL_NUMERIC_ID = -1001234567890;
const DISCUSSION_CHAT_ID = -1009876543210;

async function createPublishedPost(slug: string) {
  const [post] = await db
    .insert(posts)
    .values({
      slug,
      title: "Test post",
      contentJson: { type: "doc", content: [] },
      contentHtml: "<p></p>",
      contentText: "",
      toc: [],
      status: "published",
    })
    .returning();
  if (!post) throw new Error("post yaratilmadi");
  return post;
}

function channelForward(messageId: number) {
  return {
    message_id: 5000 + messageId,
    is_automatic_forward: true,
    forward_origin: {
      type: "channel",
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHANNEL_NUMERIC_ID, type: "channel", title: "Test kanal" },
      message_id: messageId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture, minimal grammY MessageOriginChannel shape
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture
  } as any;
}

let mapForwardToPost: typeof import("./discussion.js").mapForwardToPost;
let tryHandleGroupComment: typeof import("./discussion.js").tryHandleGroupComment;

beforeAll(async () => {
  await migrateTestDb();
  ({ mapForwardToPost, tryHandleGroupComment } = await import("./discussion.js"));
  await upsertSiteSetting("settings:telegram", { channelId: String(CHANNEL_NUMERIC_ID) });
  invalidateSettingsCache();
});

describe("mapForwardToPost — album (media group) discussion mapping", () => {
  it("maps a forward whose message_id matches the legacy single channelMessageId", async () => {
    const post = await createPublishedPost("legacy-single");
    await db.insert(telegramRefs).values({ postId: post.id, channelMessageId: 42 });

    const mapped = await mapForwardToPost(DISCUSSION_CHAT_ID, channelForward(42));
    expect(mapped).toBe(true);

    const [ref] = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, post.id));
    expect(ref?.discussionChatId).toBe(DISCUSSION_CHAT_ID);
    expect(ref?.discussionMessageId).toBe(5042);
  });

  it("maps a forward whose message_id matches ANY id inside channel_message_ids (album)", async () => {
    const post = await createPublishedPost("album-post");
    await db.insert(telegramRefs).values({
      postId: post.id,
      channelMessageId: 101,
      channelMessageType: "album",
      channelMessageIds: [101, 102, 103],
    });

    // Ikkinchi album elementining forward'i (101 emas, 102) — baribir shu postga bog'lanishi kerak.
    const mapped = await mapForwardToPost(DISCUSSION_CHAT_ID, channelForward(102));
    expect(mapped).toBe(true);

    const [ref] = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, post.id));
    expect(ref?.discussionChatId).toBe(DISCUSSION_CHAT_ID);
    expect(ref?.discussionMessageId).toBe(5102);
  });

  it("keeps the FIRST forwarded album item as the discussion root — later album items don't overwrite it", async () => {
    const post = await createPublishedPost("album-post-2");
    await db.insert(telegramRefs).values({
      postId: post.id,
      channelMessageId: 201,
      channelMessageType: "album",
      channelMessageIds: [201, 202, 203],
    });

    await mapForwardToPost(DISCUSSION_CHAT_ID, channelForward(201));
    const secondMapped = await mapForwardToPost(DISCUSSION_CHAT_ID, channelForward(202));
    expect(secondMapped).toBe(true);

    const [ref] = await db.select().from(telegramRefs).where(eq(telegramRefs.postId, post.id));
    // 202 emas — 201 (birinchi kelgan) saqlanib qolgan bo'lishi kerak.
    expect(ref?.discussionMessageId).toBe(5201);
  });

  it("returns false for a forward whose message_id belongs to no known post", async () => {
    const mapped = await mapForwardToPost(DISCUSSION_CHAT_ID, channelForward(999999));
    expect(mapped).toBe(false);
  });
});

describe("tryHandleGroupComment — who may comment", () => {
  let seq = 9000;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal grammY Context fixture
  function ctxFor(message: Record<string, unknown>, from: Record<string, unknown>): any {
    return { message, from, chat: { id: DISCUSSION_CHAT_ID, type: "supergroup" } };
  }
  async function mappedPost(slug: string, channelMessageId: number) {
    const post = await createPublishedPost(slug);
    await db.insert(telegramRefs).values({ postId: post.id, channelMessageId });
    const forward = channelForward(channelMessageId);
    expect(await mapForwardToPost(DISCUSSION_CHAT_ID, forward)).toBe(true);
    return { post, rootId: forward.message_id as number };
  }
  async function stored(postId: string) {
    return db.select().from(comments).where(eq(comments.postId, postId));
  }

  it("stores a normal user's comment in the thread", async () => {
    const { post, rootId } = await mappedPost("who-user", 701);
    const ok = await tryHandleGroupComment(
      ctxFor(
        { message_id: ++seq, message_thread_id: rootId, text: "Oddiy izoh" },
        { id: 111, is_bot: false, first_name: "Ali", username: "ali" },
      ),
    );
    expect(ok).toBe(true);
    const rows = await stored(post.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.authorName).toBe("Ali");
    expect(rows[0]!.tgUserId).toBe(111);
  });

  it("stores a comment sent AS THE CHANNEL (sender_chat = channel, from = Channel_Bot)", async () => {
    const { post, rootId } = await mappedPost("who-channel", 702);
    const ok = await tryHandleGroupComment(
      ctxFor(
        {
          message_id: ++seq,
          message_thread_id: rootId,
          text: "Kanal nomidan izoh",
          sender_chat: { id: CHANNEL_NUMERIC_ID, type: "channel", title: "Test kanal", username: "testkanal" },
        },
        { id: 136817688, is_bot: true, first_name: "Channel", username: "Channel_Bot" },
      ),
    );
    expect(ok).toBe(true);
    const rows = await stored(post.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.authorName).toBe("Test kanal");
    expect(rows[0]!.tgUsername).toBe("testkanal");
    expect(rows[0]!.tgUserId).toBeNull();
    expect(rows[0]!.source).toBe("telegram");
  });

  it("stores an anonymous group admin's comment (sender_chat = the group itself)", async () => {
    const { post, rootId } = await mappedPost("who-anon", 703);
    const ok = await tryHandleGroupComment(
      ctxFor(
        {
          message_id: ++seq,
          message_thread_id: rootId,
          text: "Anonim admin izohi",
          sender_chat: { id: DISCUSSION_CHAT_ID, type: "supergroup", title: "Muhokama" },
        },
        { id: 1087968824, is_bot: true, first_name: "Group", username: "GroupAnonymousBot" },
      ),
    );
    expect(ok).toBe(true);
    const rows = await stored(post.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.authorName).toBe("Muhokama (admin)");
    expect(rows[0]!.tgUserId).toBeNull();
  });

  it("ignores a real bot's message and an unmapped automatic forward", async () => {
    const { post, rootId } = await mappedPost("who-bot", 704);
    expect(
      await tryHandleGroupComment(
        ctxFor(
          { message_id: ++seq, message_thread_id: rootId, text: "bot xabari" },
          { id: 999, is_bot: true, first_name: "SomeBot" },
        ),
      ),
    ).toBe(false);
    expect(
      await tryHandleGroupComment(
        ctxFor(
          {
            ...channelForward(123456),
            sender_chat: { id: CHANNEL_NUMERIC_ID, type: "channel", title: "Test kanal" },
          },
          { id: 777000, is_bot: false, first_name: "Telegram" },
        ),
      ),
    ).toBe(false);
    expect(await stored(post.id)).toHaveLength(0);
  });
});

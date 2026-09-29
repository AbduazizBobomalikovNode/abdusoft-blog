import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/index.js";
import { posts, telegramRefs } from "../db/schema.js";
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

beforeAll(async () => {
  await migrateTestDb();
  ({ mapForwardToPost } = await import("./discussion.js"));
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

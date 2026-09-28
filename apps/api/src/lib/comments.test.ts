import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { posts, comments } from "../db/schema.js";
import { migrateTestDb } from "../test/migrate-test-db.js";
import { getCommentsForPost, nextCommentPath, recountPostComments } from "./comments.js";

const DEVICE_A = "device-hash-a";
const DEVICE_B = "device-hash-b";

async function createPost(slug: string) {
  const rows = await db
    .insert(posts)
    .values({
      slug,
      title: slug,
      contentJson: { type: "doc", content: [] },
      contentHtml: "",
      toc: [],
      status: "published",
    })
    .returning();
  return rows[0]!.id;
}

async function addComment(params: {
  postId: string;
  parentId?: string | null;
  path: string;
  depth: number;
  authorName: string;
  authorTokenHash?: string | null;
  status?: "visible" | "pending" | "hidden" | "deleted";
  createdAt?: Date;
}) {
  const rows = await db
    .insert(comments)
    .values({
      postId: params.postId,
      parentId: params.parentId ?? null,
      path: params.path,
      depth: params.depth,
      authorName: params.authorName,
      authorTokenHash: params.authorTokenHash ?? null,
      body: `body-${params.path}`,
      bodyHtml: `<p>body-${params.path}</p>`,
      status: params.status ?? "visible",
      createdAt: params.createdAt,
    })
    .returning();
  return rows[0]!.id;
}

beforeAll(async () => {
  await migrateTestDb();
});

describe("getCommentsForPost — tree building, filtering, promotion", () => {
  it("nests replies under their parent and keeps ordering by path", async () => {
    const postId = await createPost("tree-post");
    const root = await addComment({ postId, path: "000001", depth: 0, authorName: "Ali" });
    await addComment({ postId, parentId: root, path: "000001.000001", depth: 1, authorName: "Vali" });

    const result = await getCommentsForPost({
      postId,
      sort: "new",
      cursor: null,
      limit: 20,
      deviceHash: DEVICE_A,
      sessionUserId: null,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.replies).toHaveLength(1);
    expect(result.items[0]!.replies[0]!.authorName).toBe("Vali");
  });

  it("hides a pending comment from other visitors but shows it to its own author (device hash)", async () => {
    const postId = await createPost("pending-post");
    await addComment({
      postId,
      path: "000001",
      depth: 0,
      authorName: "Kutilayotgan",
      authorTokenHash: DEVICE_A,
      status: "pending",
    });

    const asOwner = await getCommentsForPost({
      postId,
      sort: "new",
      cursor: null,
      limit: 20,
      deviceHash: DEVICE_A,
      sessionUserId: null,
    });
    expect(asOwner.items).toHaveLength(1);
    expect(asOwner.items[0]!.pending).toBe(true);
    expect(asOwner.items[0]!.isMine).toBe(true);

    const asStranger = await getCommentsForPost({
      postId,
      sort: "new",
      cursor: null,
      limit: 20,
      deviceHash: DEVICE_B,
      sessionUserId: null,
    });
    expect(asStranger.items).toHaveLength(0);
  });

  it("never shows a hidden comment, but promotes its visible children up to its parent's level", async () => {
    const postId = await createPost("hidden-post");
    const root = await addComment({ postId, path: "000001", depth: 0, authorName: "Root" });
    const hiddenChild = await addComment({
      postId,
      parentId: root,
      path: "000001.000001",
      depth: 1,
      authorName: "Bloklangan",
      status: "hidden",
    });
    await addComment({
      postId,
      parentId: hiddenChild,
      path: "000001.000001.000001",
      depth: 2,
      authorName: "Nabira",
    });

    const result = await getCommentsForPost({
      postId,
      sort: "new",
      cursor: null,
      limit: 20,
      deviceHash: DEVICE_A,
      sessionUserId: null,
    });

    expect(result.items).toHaveLength(1);
    // Hidden node itself never appears — its child is promoted directly under root.
    const rootNode = result.items[0]!;
    expect(rootNode.authorName).toBe("Root");
    expect(rootNode.replies).toHaveLength(1);
    expect(rootNode.replies[0]!.authorName).toBe("Nabira");
  });

  it("keeps a deleted comment as an empty placeholder only if it still has visible descendants, drops it otherwise", async () => {
    const postId = await createPost("deleted-post");
    const root = await addComment({ postId, path: "000001", depth: 0, authorName: "Root" });
    const deletedWithChild = await addComment({
      postId,
      parentId: root,
      path: "000001.000001",
      depth: 1,
      authorName: "O'chirilgan",
      status: "deleted",
    });
    await addComment({
      postId,
      parentId: deletedWithChild,
      path: "000001.000001.000001",
      depth: 2,
      authorName: "Javob",
    });

    const withChild = await getCommentsForPost({
      postId,
      sort: "new",
      cursor: null,
      limit: 20,
      deviceHash: DEVICE_A,
      sessionUserId: null,
    });
    const deletedNode = withChild.items[0]!.replies[0]!;
    expect(deletedNode.deleted).toBe(true);
    expect(deletedNode.body).toBe("");
    expect(deletedNode.replies).toHaveLength(1);

    // Now a deleted leaf (no children) — should not appear at all.
    const postId2 = await createPost("deleted-leaf-post");
    const root2 = await addComment({ postId: postId2, path: "000001", depth: 0, authorName: "Root2" });
    await addComment({
      postId: postId2,
      parentId: root2,
      path: "000001.000001",
      depth: 1,
      authorName: "Yolgiz o'chirilgan",
      status: "deleted",
    });

    const leafResult = await getCommentsForPost({
      postId: postId2,
      sort: "new",
      cursor: null,
      limit: 20,
      deviceHash: DEVICE_A,
      sessionUserId: null,
    });
    expect(leafResult.items[0]!.replies).toHaveLength(0);
  });

  it("sorts roots by score (likes - dislikes) for sort=top, and by recency for sort=new", async () => {
    const postId = await createPost("sort-post");
    const older = await addComment({
      postId,
      path: "000001",
      depth: 0,
      authorName: "Eski",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const newer = await addComment({
      postId,
      path: "000002",
      depth: 0,
      authorName: "Yangi",
      createdAt: new Date("2026-02-01T00:00:00Z"),
    });
    // Give the older comment a higher score.
    await db.update(comments).set({ likesCount: 5 }).where(eqId(older));
    await db.update(comments).set({ likesCount: 1 }).where(eqId(newer));

    const byNew = await getCommentsForPost({
      postId,
      sort: "new",
      cursor: null,
      limit: 20,
      deviceHash: DEVICE_A,
      sessionUserId: null,
    });
    expect(byNew.items.map((i) => i.authorName)).toEqual(["Yangi", "Eski"]);

    const byTop = await getCommentsForPost({
      postId,
      sort: "top",
      cursor: null,
      limit: 20,
      deviceHash: DEVICE_A,
      sessionUserId: null,
    });
    expect(byTop.items.map((i) => i.authorName)).toEqual(["Eski", "Yangi"]);
  });
});

describe("getCommentsForPost — cursor pagination", () => {
  it("paginates root comments with a cursor and reports nextCursor only when more remain", async () => {
    const postId = await createPost("cursor-post");
    for (let i = 0; i < 5; i += 1) {
      await addComment({
        postId,
        path: String(i + 1).padStart(6, "0"),
        depth: 0,
        authorName: `User${i}`,
        createdAt: new Date(2026, 0, i + 1),
      });
    }

    const page1 = await getCommentsForPost({
      postId,
      sort: "new",
      cursor: null,
      limit: 2,
      deviceHash: DEVICE_A,
      sessionUserId: null,
    });
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.nextCursor).toBe(page1.items[1]!.id);

    const page2 = await getCommentsForPost({
      postId,
      sort: "new",
      cursor: page1.nextCursor,
      limit: 2,
      deviceHash: DEVICE_A,
      sessionUserId: null,
    });
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBe(page2.items[1]!.id);
    // No overlap with page 1.
    expect(page2.items.map((i) => i.id)).not.toEqual(expect.arrayContaining(page1.items.map((i) => i.id)));

    const page3 = await getCommentsForPost({
      postId,
      sort: "new",
      cursor: page2.nextCursor,
      limit: 2,
      deviceHash: DEVICE_A,
      sessionUserId: null,
    });
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();
  });
});

describe("nextCommentPath", () => {
  it("assigns sequential zero-padded root paths starting at depth 0", async () => {
    const postId = await createPost("path-post");
    const first = await nextCommentPath(postId, null);
    expect(first).toEqual({ path: "000001", depth: 0 });

    await addComment({ postId, path: first.path, depth: first.depth, authorName: "A" });
    const second = await nextCommentPath(postId, null);
    expect(second).toEqual({ path: "000002", depth: 0 });
  });

  it("builds a child path by appending a sequence segment to the parent path and incrementing depth", async () => {
    const postId = await createPost("path-post-2");
    const parentPath = await nextCommentPath(postId, null);
    const parentId = await addComment({ postId, path: parentPath.path, depth: parentPath.depth, authorName: "Parent" });

    const child = await nextCommentPath(postId, { id: parentId, path: parentPath.path, depth: parentPath.depth });
    expect(child).toEqual({ path: `${parentPath.path}.000001`, depth: 1 });
  });
});

describe("recountPostComments", () => {
  it("counts only visible comments and writes the total onto the post row", async () => {
    const postId = await createPost("recount-post");
    await addComment({ postId, path: "000001", depth: 0, authorName: "A", status: "visible" });
    await addComment({ postId, path: "000002", depth: 0, authorName: "B", status: "hidden" });
    await addComment({ postId, path: "000003", depth: 0, authorName: "C", status: "pending" });
    await addComment({ postId, path: "000004", depth: 0, authorName: "D", status: "visible" });

    await recountPostComments(postId);

    const [row] = await db.select({ commentsCount: posts.commentsCount }).from(posts).where(eqPostId(postId));
    expect(row!.commentsCount).toBe(2);
  });
});

function eqId(commentId: string) {
  return eq(comments.id, commentId);
}
function eqPostId(postId: string) {
  return eq(posts.id, postId);
}

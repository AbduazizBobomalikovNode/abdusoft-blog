import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { CommentNode, CommentSort, CommentsMe, CommentSourceValue, ReactionType } from "@blog/shared";
import { db } from "../db/index.js";
import { bannedDevices, comments, posts, reactions } from "../db/schema.js";
import { user } from "../db/auth-schema.js";

const PATH_SEGMENT_WIDTH = 6;
export const MAX_COMMENT_DEPTH = 8;
const EDIT_WINDOW_MS = 15 * 60 * 1000;

export interface SessionIdentity {
  userId: string | null;
  isAdmin: boolean;
}

interface CommentRow {
  id: string;
  postId: string;
  parentId: string | null;
  path: string;
  depth: number;
  authorName: string;
  authorTokenHash: string | null;
  authorUserId: string | null;
  body: string;
  bodyHtml: string;
  status: "visible" | "pending" | "hidden" | "deleted";
  likesCount: number;
  dislikesCount: number;
  createdAt: Date;
  editedAt: Date | null;
  userName: string | null;
  userImage: string | null;
  userRole: string | null;
  source: CommentSourceValue;
  tgUsername: string | null;
}

interface RawNode extends CommentRow {
  children: RawNode[];
}

function isRowMine(row: CommentRow, identity: { deviceHash: string; sessionUserId: string | null }): boolean {
  if (row.authorUserId) return row.authorUserId === identity.sessionUserId;
  return row.authorTokenHash !== null && row.authorTokenHash === identity.deviceHash;
}

function toNode(row: CommentRow, isMine: boolean): CommentNode {
  const isDeleted = row.status === "deleted";
  const editableUntil = new Date(row.createdAt.getTime() + EDIT_WINDOW_MS).toISOString();

  return {
    id: row.id,
    parentId: row.parentId,
    depth: row.depth,
    authorName: row.authorName,
    authorImage: row.userImage,
    authorIsAdmin: row.userRole === "admin",
    authorVerified: Boolean(row.authorUserId),
    isMine,
    editableUntil,
    body: isDeleted ? "" : row.body,
    bodyHtml: isDeleted ? "" : row.bodyHtml,
    pending: row.status === "pending",
    deleted: isDeleted,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    likes: row.likesCount,
    dislikes: row.dislikesCount,
    replies: [],
    source: row.source,
    tgUsername: row.tgUsername,
  };
}

/**
 * Tugunlar ro'yxatini filtrlaydi: `visible` doim ko'rinadi; `pending` faqat
 * o'ziniki bo'lsa; `hidden` hech qachon; `deleted` faqat ko'rinadigan avlodi
 * bo'lsagina bo'sh placeholder sifatida. `hidden` yoki begona `pending` tugun
 * chiqarib tashlanganda, uning ko'rinadigan bolalari yo'qolib ketmasligi
 * uchun ota-tugunga "ko'tariladi" (promote) — masalan, bitta foydalanuvchi
 * bloklanganda boshqa odamning uning ostidagi haqiqiy javobi yo'qolmaydi.
 */
function filterChildren(
  nodes: RawNode[],
  identity: { deviceHash: string; sessionUserId: string | null },
): CommentNode[] {
  const out: CommentNode[] = [];

  for (const node of nodes) {
    const filteredGrandchildren = filterChildren(node.children, identity);

    if (node.status === "hidden") {
      out.push(...filteredGrandchildren);
      continue;
    }

    const isMine = isRowMine(node, identity);

    if (node.status === "pending" && !isMine) {
      out.push(...filteredGrandchildren);
      continue;
    }

    if (node.status === "deleted" && filteredGrandchildren.length === 0) {
      continue;
    }

    const built = toNode(node, isMine);
    built.replies = filteredGrandchildren;
    out.push(built);
  }

  return out;
}

function collectIds(nodes: CommentNode[], into: string[]) {
  for (const n of nodes) {
    into.push(n.id);
    collectIds(n.replies, into);
  }
}

function collectOwnIds(nodes: CommentNode[], into: string[]) {
  for (const n of nodes) {
    if (n.isMine) into.push(n.id);
    collectOwnIds(n.replies, into);
  }
}

function scoreOf(node: RawNode): number {
  return node.likesCount - node.dislikesCount;
}

function sortRoots(roots: RawNode[], sort: CommentSort): RawNode[] {
  const copy = [...roots];
  if (sort === "top") {
    copy.sort((a, b) => {
      const diff = scoreOf(b) - scoreOf(a);
      if (diff !== 0) return diff;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
  } else {
    copy.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  return copy;
}

export interface GetCommentsParams {
  postId: string;
  sort: CommentSort;
  cursor: string | null;
  limit: number;
  deviceHash: string;
  sessionUserId: string | null;
  /** 'all' | 'web' | 'telegram' — chaqiruvchi (route) `comments.telegramDisplay` sozlamasiga qarab tanlaydi. Majburiy — standart yo'q, chunki noto'g'ri qiymat izohlar oqib chiqishiga olib kelishi mumkin. */
  source: "all" | "web" | "telegram";
}

export interface GetCommentsResult {
  items: CommentNode[];
  nextCursor: string | null;
  total: number;
  me: CommentsMe;
}

export async function getCommentsForPost(params: GetCommentsParams): Promise<GetCommentsResult> {
  const whereClause =
    params.source === "all"
      ? eq(comments.postId, params.postId)
      : and(eq(comments.postId, params.postId), eq(comments.source, params.source))!;

  const rows = await db
    .select({
      id: comments.id,
      postId: comments.postId,
      parentId: comments.parentId,
      path: comments.path,
      depth: comments.depth,
      authorName: comments.authorName,
      authorTokenHash: comments.authorTokenHash,
      authorUserId: comments.authorUserId,
      body: comments.body,
      bodyHtml: comments.bodyHtml,
      status: comments.status,
      likesCount: comments.likesCount,
      dislikesCount: comments.dislikesCount,
      createdAt: comments.createdAt,
      editedAt: comments.editedAt,
      userName: user.name,
      userImage: user.image,
      userRole: user.role,
      source: comments.source,
      tgUsername: comments.tgUsername,
    })
    .from(comments)
    .leftJoin(user, eq(comments.authorUserId, user.id))
    .where(whereClause)
    .orderBy(asc(comments.path));

  const nodeMap = new Map<string, RawNode>();
  const roots: RawNode[] = [];

  for (const row of rows) {
    const typedRow = row as CommentRow;
    nodeMap.set(typedRow.id, { ...typedRow, children: [] });
  }
  for (const row of rows) {
    const node = nodeMap.get(row.id);
    if (!node) continue;
    if (row.parentId && nodeMap.has(row.parentId)) {
      nodeMap.get(row.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const identity = { deviceHash: params.deviceHash, sessionUserId: params.sessionUserId };
  const sortedRoots = sortRoots(roots, params.sort);
  const filteredRoots = filterChildren(sortedRoots, identity);

  const total = filteredRoots.length;

  let startIndex = 0;
  if (params.cursor) {
    const idx = filteredRoots.findIndex((n) => n.id === params.cursor);
    startIndex = idx === -1 ? 0 : idx + 1;
  }

  const items = filteredRoots.slice(startIndex, startIndex + params.limit);
  const hasMore = startIndex + params.limit < filteredRoots.length;
  const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

  const allIds: string[] = [];
  collectIds(items, allIds);
  const ownIds: string[] = [];
  collectOwnIds(items, ownIds);

  const targetConditions: SQL[] = [and(eq(reactions.targetType, "post"), eq(reactions.targetId, params.postId))!];
  if (allIds.length > 0) {
    targetConditions.push(and(eq(reactions.targetType, "comment"), inArray(reactions.targetId, allIds))!);
  }

  const reactionRows = await db
    .select({ targetType: reactions.targetType, targetId: reactions.targetId, type: reactions.type })
    .from(reactions)
    .where(and(eq(reactions.deviceHash, params.deviceHash), or(...targetConditions)));

  const commentReactions: Record<string, ReactionType> = {};
  let postReaction: ReactionType | null = null;
  for (const r of reactionRows) {
    if (r.targetType === "post") {
      postReaction = r.type;
    } else {
      commentReactions[r.targetId] = r.type;
    }
  }

  return {
    items,
    nextCursor,
    total,
    me: {
      deviceOk: true,
      reactions: commentReactions,
      postReaction,
      ownIds,
    },
  };
}

/** Post yaratilgan yangi izoh javobini `me` bo'lakli kontekst bilan tayyorlaydi. */
export function toCommentNodeForCreator(row: CommentRow): CommentNode {
  return toNode(row, true);
}

export async function nextCommentPath(
  postId: string,
  parent: { id: string; path: string; depth: number } | null,
): Promise<{ path: string; depth: number }> {
  const whereClause = parent
    ? and(eq(comments.postId, postId), eq(comments.parentId, parent.id))
    : and(eq(comments.postId, postId), isNull(comments.parentId));

  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(comments).where(whereClause);

  const seq = String((row?.count ?? 0) + 1).padStart(PATH_SEGMENT_WIDTH, "0");
  return {
    path: parent ? `${parent.path}.${seq}` : seq,
    depth: parent ? parent.depth + 1 : 0,
  };
}

/** Postning web va Telegram izohlar sonini (ikkalasini ham) qayta hisoblaydi — `posts.commentsCount` faqat web, `posts.tgCommentsCount` faqat Telegram manbali "visible" izohlarni sanaydi. */
export async function recountPostComments(postId: string): Promise<void> {
  const [row] = await db
    .select({
      web: sql<number>`count(*) filter (where ${comments.status} = 'visible' and ${comments.source} = 'web')::int`,
      tg: sql<number>`count(*) filter (where ${comments.status} = 'visible' and ${comments.source} = 'telegram')::int`,
    })
    .from(comments)
    .where(eq(comments.postId, postId));

  await db
    .update(posts)
    .set({ commentsCount: row?.web ?? 0, tgCommentsCount: row?.tg ?? 0 })
    .where(eq(posts.id, postId));
}

export async function isBanned(deviceHash: string, ipHash: string): Promise<boolean> {
  const rows = await db
    .select({ id: bannedDevices.id })
    .from(bannedDevices)
    .where(or(eq(bannedDevices.deviceHash, deviceHash), eq(bannedDevices.ipHash, ipHash)))
    .limit(1);

  return rows.length > 0;
}

export function shortHash(hash: string | null): string | null {
  return hash ? hash.slice(0, 10) : null;
}

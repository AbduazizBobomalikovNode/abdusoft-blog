import { z } from "zod";
import {
  AuditListQuerySchema,
  MCP_SCOPES,
  StatsRangeSchema,
  type ContentNode,
} from "@blog/shared";
import { listAuditEntries } from "../../admin-reads/audit.js";
import { AdminCommentListQuerySchema, listAdminComments } from "../../admin-reads/comments.js";
import { listMedia } from "../../admin-reads/media.js";
import { getPostStatsView, getStatsOverview } from "../../admin-reads/stats.js";
import { tagsQuery } from "../../admin-reads/tags.js";
import { config } from "../../../config.js";
import { findLivePostIdBySlug, getPostDetail, getRevision, listPosts, listRevisions, listTrash } from "../../posts/index.js";
import { getSettings } from "../../settings.js";
import { docToReadableText } from "../doc-text.js";
import { defineTool, ToolError, unwrap, type McpToolDef, type ToolOutput } from "./types.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const PAGE = z.number().int().min(1).default(1).describe("Page number, starting at 1.");
const limitField = (max: number, fallback: number) =>
  z.number().int().min(1).max(max).default(fallback).describe(`Items per page (1-${max}, default ${fallback}).`);

const POST_STATUSES = ["draft", "in_review", "changes_requested", "scheduled", "published", "archived"] as const;

/** Sahifalangan ro'yxatga "keyingi sahifa" ishorasini qo'shadi (model uchun aniq). */
function paged<T extends { page: number; hasMore: boolean }>(result: T): T & { nextPage: number | null } {
  return { ...result, nextPage: result.hasMore ? result.page + 1 : null };
}

async function resolvePostId(args: { id?: string | undefined; slug?: string | undefined }): Promise<string> {
  if (args.id) return args.id;
  if (args.slug) {
    const id = await findLivePostIdBySlug(args.slug);
    if (id) return id;
    throw new ToolError("not_found", `No live post with slug '${args.slug}'.`, "Use list_posts (query) to find the post; trashed posts are not addressable here.");
  }
  throw new ToolError("invalid_request", "Provide either 'id' or 'slug'.", "Use list_posts to find the post first.");
}

const NOT_FOUND_POST = "Use list_posts to find a valid post id. Trashed posts are only visible through list_trash.";

function contentFor(
  json: unknown,
  include: "text" | "document" | "both",
): { content?: string; document?: unknown; contentFormat: string; contentNote: string } {
  const doc = (json ?? null) as ContentNode | null;
  return {
    contentFormat: "plain_text+tiptap_json",
    contentNote:
      "'content' is readable plain text (headings prefixed with #, lists with -). It is NOT Markdown and drops inline formatting; " +
      "'document' is the authoritative Tiptap JSON that the editor stores. No Markdown serializer exists on the server yet.",
    ...(include !== "document" ? { content: docToReadableText(doc) } : {}),
    ...(include !== "text" ? { document: json ?? null } : {}),
  };
}

const idOrSlug = {
  id: z.string().min(1).optional().describe("Post id (UUID) from list_posts."),
  slug: z.string().min(1).optional().describe("Post slug, as an alternative to id."),
};

export const whoami = defineTool({
  name: "whoami",
  title: "Connection info",
  description:
    "Describe this connection: the blog's name, the signed-in owner, which permissions (scopes) this connection was granted, which tools it can use, and server limits. " +
    "Call it first when unsure what you are allowed to do. Read-only.",
  scope: null,
  inputSchema: {},
  annotations: READ_ONLY,
  kind: "read",
  async handler(_args, ctx) {
    const settings = await getSettings();
    const { TOOLS } = await import("./index.js");
    return {
      data: {
        site: { name: settings.general.siteName, description: settings.general.siteDescription || null },
        user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email, role: ctx.actor.role },
        client: { id: ctx.client.id, name: ctx.client.name },
        grantedScopes: MCP_SCOPES.filter((scope) => ctx.scopes.has(scope.id)).map((scope) => ({ id: scope.id, description: scope.english })),
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          requiredScope: tool.scope,
          available: tool.scope === null || ctx.scopes.has(tool.scope),
          readOnly: tool.annotations.readOnlyHint,
        })),
        limits: {
          resultMaxChars: ctx.limits.resultMaxChars,
          maxPageSize: 50,
          accessTokenTtlSeconds: config.MCP_ACCESS_TOKEN_TTL_SECONDS,
          requestsPerMinutePerIp: config.MCP_RATE_LIMIT_MAX || null,
        },
        server: { mode: "read-only", note: "This version only exposes read tools. Writing, publishing and moderation are not available yet." },
      },
    } satisfies ToolOutput;
  },
});

export const listPostsTool = defineTool({
  name: "list_posts",
  title: "List posts",
  description:
    "List or search the blog's posts (drafts, scheduled and published ones; never trashed). Filter by status and/or search words in title and text. " +
    "Returns compact rows (id, slug, title, status, dates, tags, counts) newest-updated first; use get_post to read one post. Paginated: follow nextPage.",
  scope: "blog:read",
  inputSchema: {
    status: z.enum(["all", ...POST_STATUSES]).default("all").describe("Filter by status. 'all' returns every non-trashed post."),
    query: z.string().trim().min(1).max(200).optional().describe("Search words in title and body text."),
    page: PAGE,
    limit: limitField(50, 20),
  },
  annotations: READ_ONLY,
  kind: "read",
  async handler(args, ctx) {
    const result = await listPosts(ctx.actor, { status: args.status, q: args.query, page: args.page, limit: args.limit });
    return { data: paged(result), listKey: "items" };
  },
});

export const getPost = defineTool({
  name: "get_post",
  title: "Get a post",
  description:
    "Read one post in full: metadata, settings, tags, review state, Telegram channel status and its content. " +
    "'updatedAt' is the concurrency token that future edit tools require - pass it back unchanged. " +
    "Content comes as readable plain text ('content') and as the exact Tiptap JSON ('document'); use include to receive only one of them.",
  scope: "blog:read",
  inputSchema: {
    ...idOrSlug,
    include: z.enum(["both", "text", "document"]).default("both").describe("Which content form to return (default both)."),
  },
  annotations: READ_ONLY,
  kind: "read",
  async handler(args, ctx) {
    const id = await resolvePostId(args);
    const detail = unwrap(await getPostDetail(ctx.actor, id), { notFound: NOT_FOUND_POST });
    const { contentJson, channelPlan, channelSendAt, channelChoice, telegram, reviewNote, submittedAt, reviewedBy, reviewedAt, ...post } = detail;
    return {
      data: {
        post: {
          ...post,
          review: { note: reviewNote, submittedAt, reviewedBy, reviewedAt },
          channel: { plan: channelPlan, sendAt: channelSendAt, choice: channelChoice, telegram },
        },
        ...contentFor(contentJson, args.include),
      },
      shrink: [
        { key: "document", mode: "drop", note: "The structured 'document' was omitted because the post is very large; call get_post with include='text' or read revisions." },
        { key: "content", mode: "truncate", note: "'content' was truncated because the post is very large." },
      ],
    };
  },
});

export const listTags = defineTool({
  name: "list_tags",
  title: "List tags",
  description: "List all tags with their slug, name, description, color and the number of published posts. Read-only.",
  scope: "blog:read",
  inputSchema: {},
  annotations: READ_ONLY,
  kind: "read",
  async handler() {
    const items = await tagsQuery();
    return { data: { items, total: items.length }, listKey: "items" };
  },
});

export const listComments = defineTool({
  name: "list_comments",
  title: "List comments",
  description:
    "List comments for moderation, newest first, with counts per status. Filter by status (pending needs review), source, post, search text or date range. " +
    "Comments of trashed posts are never included. Read-only; moderation tools are not available yet.",
  scope: "blog:read",
  inputSchema: {
    status: z.enum(["all", "pending", "visible", "hidden", "deleted"]).default("pending").describe("Comment status (default pending)."),
    source: z.enum(["all", "web", "telegram"]).default("all"),
    post_id: z.string().min(1).optional().describe("Only comments of this post id."),
    query: z.string().trim().min(1).max(200).optional().describe("Search in comment text and author name."),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("From date, YYYY-MM-DD (UTC)."),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("To date, YYYY-MM-DD (UTC)."),
    page: PAGE,
    limit: limitField(50, 20),
  },
  annotations: READ_ONLY,
  kind: "read",
  async handler(args) {
    if (args.from && args.to && args.from > args.to) {
      throw new ToolError("invalid_request", "'from' must not be after 'to'.");
    }
    const query = AdminCommentListQuerySchema.parse({
      status: args.status,
      source: args.source,
      postId: args.post_id,
      q: args.query,
      from: args.from,
      to: args.to,
      page: args.page,
      limit: args.limit,
    });
    const result = await listAdminComments(query);
    return {
      data: paged({
        ...result,
        items: result.items.map((c) => ({
          id: c.id,
          postId: c.postId,
          postSlug: c.postSlug,
          postTitle: c.postTitle,
          parentId: c.parentId,
          authorName: c.authorName,
          authorIsAdmin: c.authorIsAdmin,
          source: c.source,
          status: c.status,
          body: c.body.length > 1000 ? `${c.body.slice(0, 1000)}…` : c.body,
          likes: c.likes,
          dislikes: c.dislikes,
          createdAt: c.createdAt,
        })),
      }),
      listKey: "items",
    };
  },
});

const rangeField = z.enum(["7d", "30d", "90d", "all"]).default("7d");

export const getSiteStats = defineTool({
  name: "get_site_stats",
  title: "Site statistics",
  description:
    "Site-wide statistics for a period: totals (views, likes, comments, published posts), the previous period for comparison, a daily series, top posts, recent comments and pending-comment count. Read-only.",
  scope: "blog:read",
  inputSchema: { range: rangeField.describe("Period: 7d, 30d, 90d or all (default 7d).") },
  annotations: READ_ONLY,
  kind: "read",
  async handler(args) {
    const stats = await getStatsOverview(StatsRangeSchema.parse(args.range));
    return { data: { ...stats }, shrink: [{ key: "series", mode: "drop", note: "The daily 'series' was omitted because it is too large." }] };
  },
});

export const getPostStats = defineTool({
  name: "get_post_stats",
  title: "Post statistics",
  description: "Statistics of one post for a period: views, reactions, comments, daily series, all-time counters and recent comments. Read-only.",
  scope: "blog:read",
  inputSchema: { ...idOrSlug, range: rangeField.describe("Period: 7d, 30d, 90d or all (default 7d).") },
  annotations: READ_ONLY,
  kind: "read",
  async handler(args) {
    const id = await resolvePostId(args);
    const stats = await getPostStatsView(id, StatsRangeSchema.parse(args.range));
    if (!stats) throw new ToolError("not_found", "Post not found.", NOT_FOUND_POST);
    return { data: { ...stats }, shrink: [{ key: "series", mode: "drop", note: "The daily 'series' was omitted because it is too large." }] };
  },
});

export const listPostRevisions = defineTool({
  name: "list_post_revisions",
  title: "List post revisions",
  description:
    "List the saved revision history of a post (newest first, without content): id, time, who and via what changed it, reason and the title/status at that time. Use get_post_revision to read one.",
  scope: "blog:read",
  inputSchema: { ...idOrSlug },
  annotations: READ_ONLY,
  kind: "read",
  async handler(args, ctx) {
    const id = await resolvePostId(args);
    const result = unwrap(await listRevisions(ctx.actor, id), { notFound: NOT_FOUND_POST });
    return { data: { postId: id, items: result.items, total: result.items.length }, listKey: "items" };
  },
});

export const getPostRevision = defineTool({
  name: "get_post_revision",
  title: "Get a post revision",
  description: "Read one saved revision of a post with its content (readable text and/or the Tiptap JSON). Read-only; restoring is not available yet.",
  scope: "blog:read",
  inputSchema: {
    ...idOrSlug,
    revision_id: z.string().min(1).describe("Revision id from list_post_revisions."),
    include: z.enum(["both", "text", "document"]).default("both"),
  },
  annotations: READ_ONLY,
  kind: "read",
  async handler(args, ctx) {
    const id = await resolvePostId(args);
    const revision = unwrap(await getRevision(ctx.actor, id, args.revision_id), {
      notFound: "Use list_post_revisions to find valid revision ids.",
    });
    const { contentJson, ...meta } = revision;
    return {
      data: { revision: meta, ...contentFor(contentJson, args.include) },
      shrink: [
        { key: "document", mode: "drop", note: "The structured 'document' was omitted because it is very large; call again with include='text'." },
        { key: "content", mode: "truncate", note: "'content' was truncated because the revision is very large." },
      ],
    };
  },
});

export const listTrashTool = defineTool({
  name: "list_trash",
  title: "List trashed posts",
  description: "List posts in the trash (most recently deleted first) with who deleted them and when. Trashed posts are not returned by any other tool. Read-only; restoring is not available yet.",
  scope: "blog:read",
  inputSchema: { page: PAGE, limit: limitField(50, 20) },
  annotations: READ_ONLY,
  kind: "read",
  async handler(args, ctx) {
    const result = unwrap(await listTrash(ctx.actor, { page: args.page, limit: args.limit }));
    return { data: paged(result), listKey: "items" };
  },
});

export const listAuditLog = defineTool({
  name: "list_audit_log",
  title: "List audit log",
  description:
    "List the audit log of administrative actions (newest first): who did what, via which channel (web, mcp, telegram, scheduler), with a short summary. " +
    "Filter by entity, action, channel or date. Contains no post content or secrets.",
  scope: "blog:read",
  inputSchema: {
    entity_type: z.string().trim().min(1).optional().describe("E.g. post, comment, tag, media, site, mcp."),
    entity_id: z.string().trim().min(1).optional(),
    action: z.string().trim().min(1).optional().describe("E.g. post.publish, comment.delete, mcp.read."),
    via: z.enum(["web", "mcp", "telegram", "scheduler", "system"]).optional().describe("Channel the action came through."),
    from: z.string().trim().min(1).optional().describe("From date (YYYY-MM-DD or ISO)."),
    to: z.string().trim().min(1).optional().describe("To date (YYYY-MM-DD or ISO)."),
    page: PAGE,
    limit: limitField(50, 20),
  },
  annotations: READ_ONLY,
  kind: "read",
  async handler(args) {
    const parsed = AuditListQuerySchema.safeParse({
      entityType: args.entity_type,
      entityId: args.entity_id,
      action: args.action,
      via: args.via,
      from: args.from,
      to: args.to,
      page: args.page,
      limit: args.limit,
    });
    if (!parsed.success) throw new ToolError("invalid_request", "Invalid date in 'from' or 'to'.", "Use YYYY-MM-DD or a full ISO timestamp.");
    return { data: paged(await listAuditEntries(parsed.data)), listKey: "items" };
  },
});

export const listMediaTool = defineTool({
  name: "list_media",
  title: "List media",
  description: "List uploaded media files (newest first): url, type, size, dimensions and alt text. Read-only; uploading is not available yet.",
  scope: "blog:read",
  inputSchema: { page: PAGE, limit: limitField(50, 30) },
  annotations: READ_ONLY,
  kind: "read",
  async handler(args, ctx) {
    const result = await listMedia({ id: ctx.user.id, role: "admin" }, { page: args.page, limit: args.limit });
    return {
      data: paged({ ...result, items: result.items.map(({ key: _key, ...item }) => (void _key, item)) }),
      listKey: "items",
    };
  },
});

export const READ_TOOLS: McpToolDef[] = [
  whoami,
  listPostsTool,
  getPost,
  listTags,
  listComments,
  getSiteStats,
  getPostStats,
  listPostRevisions,
  getPostRevision,
  listTrashTool,
  listAuditLog,
  listMediaTool,
] as unknown as McpToolDef[];

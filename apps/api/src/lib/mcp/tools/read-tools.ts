import { z } from "zod";
import {
  AuditListQuerySchema,
  MCP_SCOPES,
  StatsRangeSchema,
  analyzeDocMarkdown,
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
import { UNTRUSTED_DESCRIPTION_PREFIX as U, untrusted } from "./untrusted.js";
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
  throw new ToolError("invalid_input", "Provide either 'id' or 'slug'.", "Use list_posts to find the post first.");
}

const NOT_FOUND_POST = "Use list_posts to find a valid post id. Trashed posts are only visible through list_trash.";

type IncludeMode = "markdown" | "text" | "document" | "both" | "markdown+document";

const INCLUDE_FIELD = z
  .enum(["markdown", "text", "document", "both", "markdown+document"])
  .optional()
  .describe(
    "Which content form to return. 'markdown': the body as Markdown (the form update_post accepts) - the default when write tools are enabled. 'text': readable plain text. 'document': the exact structured Tiptap JSON. " +
      "'both': plain text + document (the default when write tools are disabled). 'markdown+document': Markdown + document.",
  );

/** Yozuv vositalari yoqilgan bo'lsa standart — Markdown; o'chiq bo'lsa PR #11 xatti-harakati ("both"). */
function resolveInclude(include: IncludeMode | undefined): IncludeMode {
  return include ?? (config.MCP_WRITE_TOOLS_ENABLED ? "markdown" : "both");
}

function contentFor(
  json: unknown,
  include: IncludeMode,
): { content?: string; document?: unknown; contentFormat: string; contentNote: string; [key: string]: unknown } {
  const doc = (json ?? null) as ContentNode | null;
  if (include === "markdown" || include === "markdown+document") {
    const report = analyzeDocMarkdown(doc);
    return {
      contentFormat: include === "markdown" ? "markdown" : "markdown+tiptap_json",
      contentNote:
        "'content' is the post body as Markdown (## and ### headings, lists, quotes, ``` code fences with language, tables, links, images). The post title is NOT part of it. " +
        "If 'truncated' appears in this result the Markdown is incomplete: never send it back as a replacement body." +
        (report.lossless ? "" : " Some blocks cannot be written as Markdown exactly (see lossyBlocks): a Markdown overwrite of this post is refused unless acknowledged; use content_document for structural edits."),
      content: report.markdown,
      markdownLossless: report.lossless,
      ...(report.lossless ? {} : { lossyBlocks: report.lossyBlocks }),
      ...(include === "markdown+document" ? { document: json ?? null } : {}),
    };
  }
  return {
    contentFormat: "plain_text+tiptap_json",
    contentNote:
      "'content' is readable plain text (headings prefixed with #, lists with -). It is NOT Markdown and drops inline formatting; " +
      "'document' is the authoritative Tiptap JSON that the editor stores. Use include='markdown' to get the body as Markdown.",
    ...(include !== "document" ? { content: docToReadableText(doc) } : {}),
    ...(include !== "text" ? { document: json ?? null } : {}),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidField = (what: string) => z.string().regex(UUID_RE, `must be a UUID (${what})`);

const idOrSlug = {
  id: uuidField("post id from list_posts").optional().describe("Post id (UUID) from list_posts."),
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
    const { getTools } = await import("./index.js");
    const TOOLS = getTools();
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
        server: config.MCP_WRITE_TOOLS_ENABLED
          ? {
              mode: "read-write",
              note: "Write tools are enabled. A write tool needs the matching permission (see grantedScopes) and, for existing posts, the post's current updatedAt as expected_updated_at. Every change is logged and undoable: in the web panel use Tarix (post editor), Savat (Postlar) and Jurnal first; the history, trash and audit-log tools and restore tools do the same.",
              permanentDeleteEnabled: config.MCP_PURGE_ENABLED,
              writeLimits: {
                createsPerHour: config.MCP_WRITE_LIMIT_CREATES_PER_HOUR || null,
                editsPerHour: config.MCP_WRITE_LIMIT_EDITS_PER_HOUR || null,
                uploadsPerHour: config.MCP_WRITE_LIMIT_UPLOADS_PER_HOUR || null,
                publishesPerDay: config.MCP_WRITE_LIMIT_PUBLISHES_PER_DAY || null,
                channelSendsPerDay: config.MCP_WRITE_LIMIT_CHANNEL_SENDS_PER_DAY || null,
                moderationPerHour: config.MCP_WRITE_LIMIT_MODERATION_PER_HOUR || null,
                destructivePerDay: config.MCP_WRITE_LIMIT_DESTRUCTIVE_PER_DAY || null,
              },
              maxImageBytes: config.MCP_MEDIA_MAX_BYTES,
            }
          : { mode: "read-only", note: "This version only exposes read tools. Writing, publishing and moderation are not available yet." },
      },
    } satisfies ToolOutput;
  },
});

export const listPostsTool = defineTool({
  name: "list_posts",
  title: "List posts",
  description:
    U + "List or search the blog's posts (drafts, scheduled and published ones; never trashed). Filter by status and/or search words in title and text. " +
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
    return { data: { ...paged(result), ...untrusted(["items[].title", "items[].reviewNote"]) }, listKey: "items" };
  },
});

export const getPost = defineTool({
  name: "get_post",
  title: "Get a post",
  description:
    U + "Read one post in full: metadata, settings, tags, review state, Telegram channel status and its content. " +
    "'updatedBy' and 'updatedVia' (web panel, telegram, scheduler, assistant...) say who/what changed it last. " +
    "'updatedAt' is the concurrency token that every edit tool requires (expected_updated_at) - pass it back unchanged. " +
    "Content comes as Markdown ('content', include='markdown') when write tools are enabled, otherwise as readable plain text plus the exact Tiptap JSON ('document'); use include to choose.",
  scope: "blog:read",
  inputSchema: {
    ...idOrSlug,
    include: INCLUDE_FIELD,
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
        ...contentFor(contentJson, resolveInclude(args.include)),
        ...untrusted(["content", "document", "post.title", "post.excerpt", "post.review.note"]),
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
    U + "List comments for moderation, newest first, with counts per status. Filter by status (pending needs review), source, post, search text or date range. " +
    "Comments of trashed posts are never included. Read-only; moderation tools are not available yet.",
  scope: "blog:read",
  inputSchema: {
    status: z.enum(["all", "pending", "visible", "hidden", "deleted"]).default("pending").describe("Comment status (default pending)."),
    source: z.enum(["all", "web", "telegram"]).default("all"),
    post_id: uuidField("post id").optional().describe("Only comments of this post id."),
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
      throw new ToolError("invalid_input", "'from' must not be after 'to'.");
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
      data: {
        ...paged({
          ...result,
          items: result.items.map((c) => ({
            id: c.id,
            postId: c.postId,
            postSlug: c.postSlug,
            parentId: c.parentId,
            authorIsAdmin: c.authorIsAdmin,
            source: c.source,
            status: c.status,
            likes: c.likes,
            dislikes: c.dislikes,
            createdAt: c.createdAt,
            // Uchinchi shaxs yozgan matn — alohida, aniq belgilangan maydonda.
            untrusted: {
              authorName: c.authorName,
              postTitle: c.postTitle,
              body: c.body.length > 1000 ? `${c.body.slice(0, 1000)}…` : c.body,
            },
          })),
        }),
        ...untrusted(["items[].untrusted"]),
      },
      listKey: "items",
    };
  },
});

const rangeField = z.enum(["7d", "30d", "90d", "all"]).default("7d");

export const getSiteStats = defineTool({
  name: "get_site_stats",
  title: "Site statistics",
  description:
    U + "Site-wide statistics for a period: totals (views, likes, comments, published posts), the previous period for comparison, a daily series, top posts, recent comments and pending-comment count. Read-only.",
  scope: "blog:read",
  inputSchema: { range: rangeField.describe("Period: 7d, 30d, 90d or all (default 7d).") },
  annotations: READ_ONLY,
  kind: "read",
  async handler(args) {
    const stats = await getStatsOverview(StatsRangeSchema.parse(args.range));
    return { data: { ...stats, ...untrusted(["topPosts[].title", "recentComments[].authorName", "recentComments[].body", "recentComments[].postTitle"]) }, shrink: [{ key: "series", mode: "drop", note: "The daily 'series' was omitted because it is too large." }] };
  },
});

export const getPostStats = defineTool({
  name: "get_post_stats",
  title: "Post statistics",
  description: U + "Statistics of one post for a period: views, reactions, comments, daily series, all-time counters and recent comments. Read-only.",
  scope: "blog:read",
  inputSchema: { ...idOrSlug, range: rangeField.describe("Period: 7d, 30d, 90d or all (default 7d).") },
  annotations: READ_ONLY,
  kind: "read",
  async handler(args) {
    const id = await resolvePostId(args);
    const stats = await getPostStatsView(id, StatsRangeSchema.parse(args.range));
    if (!stats) throw new ToolError("not_found", "Post not found.", NOT_FOUND_POST);
    return { data: { ...stats, ...untrusted(["post.title", "recentComments[].authorName", "recentComments[].body", "recentComments[].postTitle"]) }, shrink: [{ key: "series", mode: "drop", note: "The daily 'series' was omitted because it is too large." }] };
  },
});

export const listPostRevisions = defineTool({
  name: "list_post_revisions",
  title: "List post revisions",
  description:
    U + "List the saved revision history of a post (newest first, without content): id, time, who and via what changed it, reason and the title/status at that time. Use get_post_revision to read one.",
  scope: "blog:read",
  inputSchema: { ...idOrSlug },
  annotations: READ_ONLY,
  kind: "read",
  async handler(args, ctx) {
    const id = await resolvePostId(args);
    const result = unwrap(await listRevisions(ctx.actor, id), { notFound: NOT_FOUND_POST });
    return { data: { postId: id, items: result.items, total: result.items.length, ...untrusted(["items[].title"]) }, listKey: "items" };
  },
});

export const getPostRevision = defineTool({
  name: "get_post_revision",
  title: "Get a post revision",
  description: U + "Read one saved revision of a post with its content (Markdown, readable text and/or the Tiptap JSON; see include). Read-only; restoring is done with restore_post_revision when write tools are enabled.",
  scope: "blog:read",
  inputSchema: {
    ...idOrSlug,
    revision_id: uuidField("revision id from list_post_revisions").describe("Revision id from list_post_revisions."),
    include: INCLUDE_FIELD,
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
      data: { revision: meta, ...contentFor(contentJson, resolveInclude(args.include)), ...untrusted(["content", "document", "revision.title", "revision.excerpt"]) },
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
  description: U + "List posts in the trash (most recently deleted first) with who deleted them and when. Trashed posts are not returned by any other tool. Read-only; restoring is not available yet.",
  scope: "blog:read",
  inputSchema: { page: PAGE, limit: limitField(50, 20) },
  annotations: READ_ONLY,
  kind: "read",
  async handler(args, ctx) {
    const result = unwrap(await listTrash(ctx.actor, { page: args.page, limit: args.limit }));
    return { data: { ...paged(result), ...untrusted(["items[].title"]) }, listKey: "items" };
  },
});

export const listAuditLog = defineTool({
  name: "list_audit_log",
  title: "List audit log",
  description:
    U + "List the audit log of administrative actions (newest first): who did what, via which channel (web, mcp, telegram, scheduler), with a short summary. " +
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
    if (!parsed.success) throw new ToolError("invalid_input", "Invalid date in 'from' or 'to'.", "Use YYYY-MM-DD or a full ISO timestamp.");
    return { data: { ...paged(await listAuditEntries(parsed.data)), ...untrusted(["items[].summary", "items[].meta"]) }, listKey: "items" };
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

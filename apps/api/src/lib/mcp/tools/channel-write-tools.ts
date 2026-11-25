import { z } from "zod";
import type { ChannelSelection } from "@blog/shared";
import { summarizePreflightErrors, computeChannelPreflight } from "../../../telegram/channel-preflight.js";
import { previewChannelPost, sendToChannelAudited } from "../../../telegram/channel-actions.js";
import { resolveChoiceForSend } from "../../../telegram/channel-choice.js";
import { assertFreshToken, dryRunField, expectedUpdatedAtField, loadPostAnyState, postBlock, uuidField } from "./write-support.js";
import { UNTRUSTED_DESCRIPTION_PREFIX as U, untrusted } from "./untrusted.js";
import { ToolError, defineTool, type McpToolDef } from "./types.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const selectionFields = {
  mode: z.enum(["media", "text"]).optional().describe("'media' = photo/album with a caption, 'text' = a text message. Use together with variant."),
  variant: z.enum(["s", "m", "l", "xl"]).optional().describe("Length: s short, m medium, l long, xl extra long (not every combination exists for both modes - invalid ones are rejected)."),
  version_id: uuidField("custom channel version id").optional().describe("A custom channel version prepared in the web panel (use instead of mode+variant)."),
};

type SelectionArgs = { mode?: "media" | "text" | undefined; variant?: "s" | "m" | "l" | "xl" | undefined; version_id?: string | undefined };

/** mode+variant YOKI version_id; hech biri berilmasa — postda belgilangan versiya (yo'q bo'lsa standart tanlov). */
async function selectionFrom(postId: string, args: SelectionArgs): Promise<{ selection: ChannelSelection; source: "explicit" | "marked" | "default" }> {
  if (args.version_id && (args.mode || args.variant)) throw new ToolError("invalid_input", "Pass either version_id or mode+variant, not both.");
  if (args.version_id) return { selection: { versionId: args.version_id }, source: "explicit" };
  if (args.mode || args.variant) {
    if (!args.mode || !args.variant) throw new ToolError("invalid_input", "mode and variant must be given together.");
    return { selection: { mode: args.mode, variant: args.variant }, source: "explicit" };
  }
  const resolved = await resolveChoiceForSend(postId);
  if (!resolved) throw new ToolError("not_found", "No post with this id.");
  return { selection: resolved.selection, source: resolved.fallback ? "default" : "marked" };
}

function describeFailure(reason: string): ToolError {
  const map: Record<string, [string, string?]> = {
    not_found: ["No such post or channel version."],
    version_not_found: ["That channel version does not exist for this post.", "Use the web panel's Telegram section to see the versions."],
    not_published: ["Only a published post can be sent to the channel.", "Publish it first (publish_post)."],
    invalid_combo: ["That mode/length combination is not valid.", "Valid: media with s/m/l, text with m/l/xl."],
    no_media: ["The photo mode needs a cover image or an image in the body.", "Use mode 'text', or add a cover (update_post cover_media_id)."],
    telegram_disabled: ["The Telegram bot or channel is not configured on this server."],
    already_sent: ["This post is already in the channel.", "Pass replace_existing=true to replace the channel message."],
  };
  const [message, hint] = map[reason] ?? ["The channel action failed."];
  return new ToolError(reason === "already_sent" || reason === "not_published" ? "conflict" : reason === "not_found" || reason === "version_not_found" ? "not_found" : "unprocessable", message!, hint);
}

export const previewChannelPostTool = defineTool({
  name: "preview_channel_post",
  title: "Preview a Telegram channel post",
  description:
    U + "Show exactly how a post would look in the Telegram channel (caption HTML, visible length vs the limit, whether it is truncated, attached images, whether it was already sent, the channel). Read-only; nothing is sent or saved. " +
    "Pick mode+variant or a custom version_id; with neither, the version marked on the post (or the default) is previewed.",
  scope: "blog:read",
  inputSchema: { id: uuidField("post id"), ...selectionFields },
  annotations: READ_ONLY,
  kind: "read",
  async handler(args) {
    const { selection, source } = await selectionFrom(args.id, args);
    const preview = await previewChannelPost(args.id, selection);
    if (!preview.ok) throw describeFailure(preview.reason);
    const c = preview.computed;
    return {
      data: {
        post: { id: c.post.id, title: c.post.title, status: c.post.status },
        selection: { mode: c.mode, variant: c.variant, versionId: c.versionId, versionName: c.versionName, chosenBy: source },
        captionHtml: c.captionHtml,
        visibleLength: c.visibleLength,
        limit: c.limit,
        truncated: c.truncated,
        media: c.media,
        alreadySent: preview.alreadySent,
        channel: preview.channel,
        ...untrusted(["captionHtml", "post.title", "media[].alt"]),
      },
      shrink: [{ key: "captionHtml", mode: "truncate", note: "captionHtml was truncated." }],
    };
  },
});

export const checkChannelPostTool = defineTool({
  name: "check_channel_post",
  title: "Check a post against Telegram's limits",
  description:
    "Run the same preflight the web panel runs before sending: caption/text length, image sizes and formats, album limits, channel access. Returns every check with ok/warn/error and whether sending would be allowed. Read-only; nothing is sent. " +
    "for_plan=true checks for a future scheduled send (the post need not be published yet).",
  scope: "blog:read",
  inputSchema: { id: uuidField("post id"), ...selectionFields, for_plan: z.boolean().optional().describe("Check for scheduling (post may be unpublished).") },
  annotations: READ_ONLY,
  kind: "read",
  async handler(args) {
    const { selection, source } = await selectionFrom(args.id, args);
    const result = await computeChannelPreflight(args.id, selection, { requirePublished: !args.for_plan, planFallback: Boolean(args.for_plan) && !("versionId" in selection) });
    if (!result.ok) throw describeFailure(result.reason);
    const p = result.preflight;
    return {
      data: {
        canSend: p.canSend,
        errors: p.errorCount,
        warnings: p.warnCount,
        selection: { ...selection, chosenBy: source },
        checks: p.checks.map((check) => ({ status: check.status, group: check.group, message: check.message, ...(check.value !== null ? { value: check.value } : {}), ...(check.limit !== null ? { limit: check.limit } : {}) })),
        text: p.text,
      },
    };
  },
});

export const sendToChannelTool = defineTool({
  name: "send_to_channel",
  title: "Send a post to the Telegram channel",
  description:
    U + "Send a PUBLISHED post to the Telegram channel now (as the blog's bot), using mode+variant, a custom version_id, or - with neither - the version marked on the post. " +
    "The Telegram preflight runs first: if any check fails NOTHING is sent and you get the checklist. If the post is already in the channel it refuses unless replace_existing=true, which DELETES the earlier channel message(s) and posts anew. " +
    "dry_run=true reports the preflight and what would happen without sending. Messages in a public channel cannot be taken back by this connector. expected_updated_at is REQUIRED.",
  scope: "channels:send",
  limit: "channel",
  inputSchema: {
    id: uuidField("post id"),
    expected_updated_at: expectedUpdatedAtField,
    ...selectionFields,
    replace_existing: z.boolean().optional().describe("Replace the message already in the channel (deletes it). Default false."),
    dry_run: dryRunField,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  kind: "write",
  async handler(args, ctx) {
    const post = await loadPostAnyState(args.id);
    if (!post || post.deletedAt) throw new ToolError("not_found", "No live post with this id.", "Use list_posts to find the post.");
    await assertFreshToken(post, args.expected_updated_at);
    if (post.status !== "published") throw describeFailure("not_published");
    const { selection, source } = await selectionFrom(args.id, args);
    if (args.dry_run) {
      const result = await computeChannelPreflight(args.id, selection, { requirePublished: true });
      if (!result.ok) throw describeFailure(result.reason);
      const preview = await previewChannelPost(args.id, selection);
      const already = preview.ok ? preview.alreadySent : null;
      const blockedByExisting = Boolean(already) && !args.replace_existing;
      return {
        data: {
          ok: true,
          dryRun: true,
          summary: result.preflight.canSend && !blockedByExisting ? "Dry run: the post can be sent." : "Dry run: sending would be refused.",
          canSend: result.preflight.canSend && !blockedByExisting,
          wouldDo: args.replace_existing && already ? "Delete the earlier channel message(s) and send the post again." : "Send the post to the channel.",
          ...(blockedByExisting ? { refusedBecause: "already sent; pass replace_existing=true to replace it" } : {}),
          selection: { ...selection, chosenBy: source },
          alreadySent: already,
          failingChecks: result.preflight.checks.filter((c) => c.status !== "ok").map((c) => ({ status: c.status, message: c.message })),
          post: postBlock(post),
          ...untrusted(["post.title"]),
        },
      };
    }
    const request = { ...selection, ...(args.replace_existing ? { replaceExisting: true } : {}) } as Parameters<typeof sendToChannelAudited>[2];
    const result = await sendToChannelAudited(ctx.actor, args.id, request);
    if (!result.ok) {
      if (result.reason === "preflight_failed" && result.preflight) {
        throw new ToolError(
          "unprocessable",
          `Telegram checks failed, nothing was sent: ${summarizePreflightErrors(result.preflight)}`,
          "Fix the listed problems (shorten the text, change mode/variant, fix images) and try again.",
          { failingChecks: result.preflight.checks.filter((c) => c.status !== "ok").map((c) => ({ status: c.status, message: c.message })) },
        );
      }
      throw describeFailure(result.reason);
    }
    return {
      data: {
        ok: true,
        summary: args.replace_existing ? "The channel message was replaced." : "The post was sent to the channel.",
        channel: { messageUrl: result.messageUrl, messages: result.messageIds.length, messageType: result.messageType, mode: result.mode, variant: result.variant, versionId: result.versionId, sentAt: result.sentAt },
        post: postBlock(post),
        ...untrusted(["post.title"]),
      },
    };
  },
});

export const CHANNEL_WRITE_TOOLS: McpToolDef[] = [previewChannelPostTool, checkChannelPostTool, sendToChannelTool] as unknown as McpToolDef[];

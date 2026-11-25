import { z } from "zod";
import { DISTRIBUTION_PROVIDERS, type DistributionItemDto } from "@blog/shared";
import { cancel, getDistributionDto, listPostDistributions, removeFromPlatform, retry, saveDraft, schedule, sendNow, type DraftInput, type QueueInput } from "../../distribution/service/actions.js";
import { listChannels } from "../../distribution/service/channels.js";
import { buildPreview } from "../../distribution/service/prepare.js";
import { getDistribution } from "../../distribution/service/rows.js";
import type { ProviderId } from "../../distribution/types.js";
import { withIdempotency } from "../idempotency.js";
import { UNTRUSTED_DESCRIPTION_PREFIX as U, untrusted } from "./untrusted.js";
import { ToolError, defineTool, unwrap, type McpToolDef, type ToolOutput } from "./types.js";
import { assertFreshToken, dryRunField, expectedUpdatedAtField, idempotencyKeyField, loadPostAnyState, postBlock, uuidField } from "./write-support.js";

/**
 * Ijtimoiy tarqatish vositalari (`DISTRIBUTION_ENABLED=true` bo'lgandagina ro'yxatga olinadi — `index.ts`).
 * Akkauntni ulash, ilova kalitlari va tokenlar BU YERDA YO'Q (ataylab): ular faqat admin panel orqali, assistentga ochilmaydi.
 * "Tekshirish kerak" holatini hal qilish ham faqat odamga qoldirilgan. Hech narsa chop etilganda avtomatik yuborilmaydi.
 */

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const LOCAL_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
/** Jamoat internetiga chiqadi (LinkedIn/X/Threads/Instagram/GitHub'da ko'rinadi). */
const PUBLIC_SEND = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const PUBLIC_DELETE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;

const channelField = z.enum(DISTRIBUTION_PROVIDERS).describe("Channel: linkedin | x | threads | instagram | github (the GitHub profile README block).");
const imageField = z.enum(["auto", "cover", "og", "none"]).optional().describe("Image: auto = the post's cover, otherwise the site's generated Open Graph image; cover; og; none.");
const linkModeField = z.enum(["article", "text"]).optional().describe("LinkedIn only: 'article' (link card with the cover image, default) or 'text' (text with the link).");
const textField = z.string().max(20_000).optional().describe("The exact text to post. Omit to use the channel's default template (or the saved hand-edited text). Not used for github.");

const PUBLIC_WARNING =
  "ACTS ON THE PUBLIC INTERNET: this publishes to a real public account. Nothing is ever sent automatically when a post is published - only an explicit call like this one. ASK THE OWNER FOR APPROVAL EVERY TIME (show the final text and channel first; use dry_run=true to get the checks) and never send in a loop or to several channels without being asked. ";

function item(d: DistributionItemDto): Record<string, unknown> {
  const { createdBy: _c, ...rest } = d;
  void _c;
  return rest;
}

function draftOf(args: { text?: string | undefined; image?: "auto" | "cover" | "og" | "none" | undefined; link_mode?: "article" | "text" | undefined }): DraftInput {
  return {
    ...(args.text !== undefined ? { text: args.text } : {}),
    ...(args.image !== undefined ? { imageChoice: args.image } : {}),
    ...(args.link_mode !== undefined ? { linkMode: args.link_mode } : {}),
  };
}

async function requirePostFresh(postId: string, expected: string) {
  const post = await loadPostAnyState(postId);
  if (!post || post.deletedAt) throw new ToolError("not_found", "No live post with this id.", "Use list_posts to find the post.");
  await assertFreshToken(post, expected);
  return post;
}

export const listDistributionChannelsTool = defineTool({
  name: "list_distribution_channels",
  title: "List social distribution channels",
  description:
    "List the channels a post can be distributed to (LinkedIn profile, X, Threads, Instagram, GitHub profile README) with their connection state (connected, token ok/expiring/expired, account display name) and limits; Telegram is shown read-only. Read-only; account connection, credentials and tokens are never exposed and cannot be changed through this connector - the owner does that in the web panel.",
  scope: "blog:read",
  inputSchema: {},
  annotations: READ_ONLY,
  kind: "read",
  async handler() {
    const channels = await listChannels();
    return {
      data: {
        autoPost: false,
        note: "Nothing is distributed automatically when a post is published; only explicit send/schedule calls do.",
        channels: channels.map((c) => ({
          id: c.id,
          name: c.name,
          readOnly: c.readOnly,
          connected: c.connected,
          ready: c.ready,
          notReadyReason: c.notReadyReason,
          account: c.account ? { displayName: c.account.displayName, tokenState: c.account.tokenState, expiresAt: c.account.expiresAt, daysLeft: c.account.daysLeft } : null,
          limits: c.capabilities ? { textMax: c.capabilities.textMax, unit: c.capabilities.textUnit, image: c.capabilities.image, canRemove: c.capabilities.delete } : null,
        })),
        ...untrusted(["channels[].account.displayName"]),
      },
      listKey: "channels",
    };
  },
});

export const previewDistributionTool = defineTool({
  name: "preview_distribution",
  title: "Preview a post's distribution to a channel",
  description:
    U + "Show exactly what would be posted to one channel for one post: the text (saved hand-edited text, your override, or the channel's default template), its length counted the platform's way against the limit, the image that would be used, and the preflight checklist (ok/warn/error) in the same shape as the Telegram checks. Read-only; nothing is saved or sent and no social platform is contacted.",
  scope: "blog:read",
  inputSchema: { post_id: uuidField("post id"), channel: channelField, text: textField, image: imageField, link_mode: linkModeField },
  annotations: READ_ONLY,
  kind: "read",
  async handler(args) {
    const preview = await buildPreview(args.post_id, args.channel as ProviderId, { overrides: draftOf(args) });
    if (!preview) throw new ToolError("not_found", "No post with this id.", "Use list_posts to find the post.");
    return {
      data: {
        post: { id: preview.postId, title: preview.postTitle, url: preview.postUrl },
        channel: { id: preview.provider, name: preview.channel.name, ready: preview.channel.ready, notReadyReason: preview.channel.notReadyReason },
        text: preview.text,
        defaultText: preview.defaultText,
        edited: preview.edited,
        length: preview.length,
        limit: preview.limit,
        unit: preview.unit,
        image: { source: preview.image.source, width: preview.image.width, height: preview.image.height, error: preview.image.error },
        imageChoice: preview.imageChoice,
        linkMode: preview.linkMode,
        canSend: preview.canSend,
        errors: preview.errorCount,
        warnings: preview.warnCount,
        checks: preview.checks.map((c) => ({ status: c.status, group: c.group, title: c.title, message: c.message, ...(c.value !== null ? { value: c.value } : {}), ...(c.limit !== null ? { limit: c.limit } : {}) })),
        distribution: preview.distribution ? item(preview.distribution) : null,
        previouslySent: preview.previouslySent ? { sentAt: preview.previouslySent.sentAt, url: preview.previouslySent.externalUrl } : null,
        ...untrusted(["post.title", "text", "defaultText", "distribution.text", "distribution.lastErrorMessage"]),
      },
      shrink: [{ key: "defaultText", mode: "drop", note: "defaultText was dropped to fit." }],
    };
  },
});

export const listPostDistributionsTool = defineTool({
  name: "list_post_distributions",
  title: "List a post's distributions",
  description:
    U + "List every distribution of one post (any channel): status (draft, scheduled, sending, sent, failed, needs_checking, cancelled), text, scheduled time, attempts, last error kind and safe message, platform post URL. Read-only.",
  scope: "blog:read",
  inputSchema: { post_id: uuidField("post id") },
  annotations: READ_ONLY,
  kind: "read",
  async handler(args) {
    const res = unwrap(await listPostDistributions(args.post_id), { notFound: "Use list_posts to find the post." });
    return { data: { autoPost: false, distributions: res.distributions.map(item), ...untrusted(["distributions[].text", "distributions[].sentText", "distributions[].lastErrorMessage"]) }, listKey: "distributions" };
  },
});

export const getDistributionStatusTool = defineTool({
  name: "get_distribution_status",
  title: "Get a distribution's status",
  description:
    U + "Status of one distribution: where it is (draft/scheduled/sending/sent/failed/needs_checking/cancelled), attempts, next automatic retry time, last error, the platform post URL once sent. needs_checking means the platform's answer was unclear - the owner must check the platform and resolve it in the web panel; do not retry it. Read-only.",
  scope: "blog:read",
  inputSchema: { distribution_id: uuidField("distribution id") },
  annotations: READ_ONLY,
  kind: "read",
  async handler(args) {
    const d = unwrap(await getDistributionDto(args.distribution_id), { notFound: "Use list_post_distributions to find it." });
    return { data: { distribution: item(d), ...(d.status === "needs_checking" ? { needsHuman: "Platform result unknown. The owner must verify on the platform and resolve it in the web panel (mark as sent with the post URL, or retry knowingly)." } : {}), ...untrusted(["distribution.text", "distribution.sentText", "distribution.lastErrorMessage"]) } };
  },
});

export const saveDistributionTextTool = defineTool({
  name: "save_distribution_text",
  title: "Save the text for a distribution",
  description:
    U + "Save the hand-edited text and options (image, LinkedIn link mode) for one post + channel as a DRAFT. Nothing is sent. Use reset_text=true to go back to the channel's default template. dry_run=true only reports the length and checks. Requires the channel-sending permission.",
  scope: "channels:send",
  limit: "edit",
  inputSchema: {
    post_id: uuidField("post id"),
    channel: channelField,
    text: textField,
    reset_text: z.boolean().optional().describe("Remove the hand-edited text and use the default template again."),
    image: imageField,
    link_mode: linkModeField,
    dry_run: dryRunField,
  },
  annotations: LOCAL_WRITE,
  kind: "write",
  async handler(args, ctx) {
    if (args.text !== undefined && args.reset_text) throw new ToolError("invalid_input", "Pass either text or reset_text, not both.");
    const draft: DraftInput = { ...draftOf(args), ...(args.reset_text ? { text: null } : {}) };
    if (args.dry_run) {
      const preview = await buildPreview(args.post_id, args.channel as ProviderId, { overrides: draft });
      if (!preview) throw new ToolError("not_found", "No post with this id.");
      return { data: { ok: true, dryRun: true, summary: "Dry run: the draft would be saved; nothing was sent.", canSend: preview.canSend, length: preview.length, limit: preview.limit, failingChecks: preview.checks.filter((c) => c.status !== "ok").map((c) => ({ status: c.status, message: c.message })) } };
    }
    const saved = unwrap(await saveDraft(ctx.actor, args.post_id, args.channel as ProviderId, draft));
    return { data: { ok: true, summary: "Draft saved. Nothing was sent.", distribution: item(saved), ...untrusted(["distribution.text"]) } };
  },
});

async function sendOrSchedule(args: {
  post_id: string;
  channel: string;
  expected_updated_at: string;
  text?: string | undefined;
  image?: "auto" | "cover" | "og" | "none" | undefined;
  link_mode?: "article" | "text" | undefined;
  again?: boolean | undefined;
  scheduled_at?: string | undefined;
  dry_run?: boolean | undefined;
}, ctx: Parameters<McpToolDef["handler"]>[1]): Promise<ToolOutput> {
  const post = await requirePostFresh(args.post_id, args.expected_updated_at);
  if (post.status !== "published") throw new ToolError("conflict", "Only a published post can be distributed.", "Publish it first (publish_post).");
  const channel = args.channel as ProviderId;
  const draft = draftOf(args);
  const when = args.scheduled_at ? new Date(args.scheduled_at) : null;
  if (args.scheduled_at && (!when || Number.isNaN(when.getTime()))) throw new ToolError("invalid_input", "scheduled_at must be an ISO timestamp in the future.");
  if (args.dry_run) {
    const preview = await buildPreview(args.post_id, channel, { overrides: draft });
    if (!preview) throw new ToolError("not_found", "No post with this id.");
    const blocked = !preview.canSend || (Boolean(preview.previouslySent) && channel !== "github" && !args.again);
    return {
      data: {
        ok: true,
        dryRun: true,
        summary: blocked ? "Dry run: this would be refused." : when ? "Dry run: the distribution can be scheduled." : "Dry run: the post can be sent.",
        canSend: !blocked,
        wouldDo: when ? `Schedule posting to ${preview.channel.name} at ${when.toISOString()} (it still needs the owner's approval to have been given now).` : `Post to ${preview.channel.name} now, as the owner's account, publicly.`,
        ...(preview.previouslySent && channel !== "github" && !args.again ? { refusedBecause: "already sent to this channel before; pass again=true to post a duplicate on purpose" } : {}),
        text: preview.text,
        length: preview.length,
        limit: preview.limit,
        image: { source: preview.image.source, error: preview.image.error },
        failingChecks: preview.checks.filter((c) => c.status !== "ok").map((c) => ({ status: c.status, message: c.message })),
        post: postBlock(post),
        ...untrusted(["post.title", "text"]),
      },
    };
  }
  const input: QueueInput = { ...draft, ...(args.again ? { again: true } : {}) };
  const result = when ? await schedule(ctx.actor, args.post_id, channel, when, input) : await sendNow(ctx.actor, args.post_id, channel, input);
  if (!result.ok) {
    const checks = (result.error.extra as { checks?: Array<{ status: string; message: string }> } | undefined)?.checks;
    throw new ToolError(
      result.error.kind === "conflict" ? "conflict" : result.error.kind === "not_found" ? "not_found" : result.error.kind === "bad_request" ? "invalid_input" : "unprocessable",
      result.error.message,
      checks ? "Fix the listed problems (text, image, account) and try again; nothing was sent." : undefined,
      checks ? { failingChecks: checks.filter((c) => c.status !== "ok").map((c) => ({ status: c.status, message: c.message })) } : undefined,
      ["error.message"],
    );
  }
  return {
    data: {
      ok: true,
      summary: when ? "Distribution scheduled." : "Queued: the post is being sent in the background (not instant). Check get_distribution_status for the outcome.",
      distribution: item(result.data),
      post: postBlock(post),
      ...untrusted(["post.title", "distribution.text"]),
    },
  };
}

const sendFields = {
  post_id: uuidField("post id"),
  channel: channelField,
  expected_updated_at: expectedUpdatedAtField,
  text: textField,
  image: imageField,
  link_mode: linkModeField,
  again: z.boolean().optional().describe("Allow sending even though this post was already sent to this channel (creates a duplicate on purpose). Default false."),
  idempotency_key: idempotencyKeyField,
  dry_run: dryRunField,
};

export const sendDistributionTool = defineTool({
  name: "send_distribution",
  title: "Send a post to a social channel",
  description:
    U + PUBLIC_WARNING + "Queue ONE published post for ONE channel now (LinkedIn profile, X, Threads, Instagram, or regenerate the GitHub README latest-posts block). The preflight runs first: if any check fails nothing is queued and you get the checklist. The actual sending happens in the background within about a minute (not instant); an unclear platform answer becomes needs_checking, which only the owner resolves in the web panel. Pass idempotency_key so a retry cannot post twice. expected_updated_at is REQUIRED. Requires the channel-sending permission.",
  scope: "channels:send",
  limit: "channel",
  inputSchema: sendFields,
  annotations: PUBLIC_SEND,
  kind: "write",
  async handler(args, ctx) {
    return withIdempotency(ctx, "send_distribution", args.idempotency_key, args, () => sendOrSchedule(args, ctx));
  },
});

export const scheduleDistributionTool = defineTool({
  name: "schedule_distribution",
  title: "Schedule a post for a social channel",
  description:
    U + PUBLIC_WARNING + "Schedule ONE published post for ONE channel at a future time (scheduled_at, ISO 8601; at least a minute ahead, at most a year). The same checks as send_distribution run now and again at send time; the owner can cancel before then. Nothing is posted at publish time on its own - only this explicit schedule. Pass idempotency_key. expected_updated_at is REQUIRED. Requires the channel-sending permission.",
  scope: "channels:send",
  limit: "channel",
  inputSchema: { ...sendFields, scheduled_at: z.string().min(10).max(40).describe("When to send, ISO 8601 with timezone, e.g. 2026-12-01T09:00:00+05:00.") },
  annotations: PUBLIC_SEND,
  kind: "write",
  async handler(args, ctx) {
    return withIdempotency(ctx, "schedule_distribution", args.idempotency_key, args, () => sendOrSchedule(args, ctx));
  },
});

export const cancelDistributionTool = defineTool({
  name: "cancel_distribution",
  title: "Cancel a distribution",
  description:
    U + "Cancel a draft, scheduled or failed distribution so it will not be sent. A distribution that is already sending or sent cannot be cancelled (use remove_distribution_from_platform for a sent one, where supported). Requires the channel-sending permission.",
  scope: "channels:send",
  limit: "edit",
  inputSchema: { distribution_id: uuidField("distribution id"), dry_run: dryRunField },
  annotations: LOCAL_WRITE,
  kind: "write",
  async handler(args, ctx) {
    const row = await getDistribution(args.distribution_id);
    if (!row) throw new ToolError("not_found", "No distribution with this id.", "Use list_post_distributions.");
    if (args.dry_run) {
      const can = ["draft", "scheduled", "failed"].includes(row.status);
      return { data: { ok: true, dryRun: true, summary: can ? "Dry run: it can be cancelled." : `Dry run: cannot cancel (status ${row.status}).`, canCancel: can, status: row.status } };
    }
    return { data: { ok: true, summary: "Cancelled.", distribution: item(unwrap(await cancel(ctx.actor, args.distribution_id))), ...untrusted(["distribution.text"]) } };
  },
});

export const retryDistributionTool = defineTool({
  name: "retry_distribution",
  title: "Retry a failed distribution",
  description:
    U + PUBLIC_WARNING + "Retry a FAILED distribution (resumes from where it stopped when the platform allows, e.g. reusing an already uploaded image). It refuses needs_checking: that state means the platform may already have the post, and only the owner may resolve it in the web panel. Requires the channel-sending permission.",
  scope: "channels:send",
  limit: "channel",
  inputSchema: { distribution_id: uuidField("distribution id"), dry_run: dryRunField },
  annotations: PUBLIC_SEND,
  kind: "write",
  async handler(args, ctx) {
    const row = await getDistribution(args.distribution_id);
    if (!row) throw new ToolError("not_found", "No distribution with this id.", "Use list_post_distributions.");
    if (args.dry_run) {
      const can = row.status === "failed";
      return { data: { ok: true, dryRun: true, summary: can ? "Dry run: it can be retried." : `Dry run: cannot retry (status ${row.status}).`, canRetry: can, status: row.status, willResume: Boolean(row.partial) } };
    }
    return { data: { ok: true, summary: "Retry queued: sending happens in the background.", distribution: item(unwrap(await retry(ctx.actor, args.distribution_id))), ...untrusted(["distribution.text", "distribution.lastErrorMessage"]) } };
  },
});

export const removeDistributionTool = defineTool({
  name: "remove_distribution_from_platform",
  title: "Remove a sent post from the platform",
  description:
    U + "Delete a previously SENT post from the platform where the platform's API supports it (LinkedIn, X, Threads; not Instagram or the GitHub README block). This deletes a public post and cannot be undone. ASK THE OWNER FOR APPROVAL EVERY TIME. Requires the channel-sending permission.",
  scope: "channels:send",
  limit: "destructive",
  inputSchema: { distribution_id: uuidField("distribution id"), dry_run: dryRunField },
  annotations: PUBLIC_DELETE,
  kind: "write",
  async handler(args, ctx) {
    const row = await getDistribution(args.distribution_id);
    if (!row) throw new ToolError("not_found", "No distribution with this id.", "Use list_post_distributions.");
    if (args.dry_run) {
      const can = row.status === "sent" && Boolean(row.externalId);
      return { data: { ok: true, dryRun: true, summary: can ? "Dry run: the platform post would be deleted if the platform supports it." : `Dry run: nothing to remove (status ${row.status}).`, status: row.status, url: row.externalUrl } };
    }
    return { data: { ok: true, summary: "The post was removed from the platform.", distribution: item(unwrap(await removeFromPlatform(ctx.actor, args.distribution_id))), ...untrusted(["distribution.text"]) } };
  },
});

export const DISTRIBUTION_READ_TOOLS: McpToolDef[] = [listDistributionChannelsTool, previewDistributionTool, listPostDistributionsTool, getDistributionStatusTool] as unknown as McpToolDef[];
export const DISTRIBUTION_WRITE_TOOLS: McpToolDef[] = [saveDistributionTextTool, sendDistributionTool, scheduleDistributionTool, cancelDistributionTool, retryDistributionTool, removeDistributionTool] as unknown as McpToolDef[];

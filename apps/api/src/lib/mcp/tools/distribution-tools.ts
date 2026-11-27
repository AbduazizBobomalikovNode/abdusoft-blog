import { z } from "zod";
import { DISTRIBUTION_PLAN_MAX_DELAY_MINUTES, DISTRIBUTION_PROVIDERS, type DistributionItemDto, type DistributionVersionDto } from "@blog/shared";
import { clearPrimary, createVersion, deleteVersion, getVersion, listVersions, setPrimary, toVersionDto, updateVersion } from "../../distribution/service/versions.js";
import { cancel, getDistributionDto, listPostDistributions, removeFromPlatform, retry, saveDraft, schedule, sendNow, type DraftInput, type QueueInput } from "../../distribution/service/actions.js";
import { checkPlan, clearPlan, setPlan } from "../../distribution/service/plans.js";
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
const xThreadField = z.boolean().optional().describe("X only: post the text as a THREAD (a chain of reply tweets) instead of one tweet. Parts are split on lines containing only `---`, and any part still over 280 weighted characters is auto-split at paragraph/sentence/word boundaries (never inside a URL or word-grapheme); at most 15 tweets. Default false = one tweet (the 280 limit applies).");
const xThreadNumberingField = z.boolean().optional().describe("X thread only: append \" 1/n\" to every tweet (counted in the 280 weight). Default false.");
const textField = z.string().max(20_000).optional().describe("The exact text to post. Omit to use the channel's default template (or the saved hand-edited text). Not used for github.");

const PUBLIC_WARNING =
  "ACTS ON THE PUBLIC INTERNET: this publishes to a real public account. Nothing is ever sent automatically when a post is published - only an explicit call like this one. ASK THE OWNER FOR APPROVAL EVERY TIME (show the final text and channel first; use dry_run=true to get the checks) and never send in a loop or to several channels without being asked. ";

function item(d: DistributionItemDto): Record<string, unknown> {
  const { createdBy: _c, ...rest } = d;
  void _c;
  return rest;
}

function draftOf(args: { text?: string | undefined; image?: "auto" | "cover" | "og" | "none" | undefined; link_mode?: "article" | "text" | undefined; x_thread?: boolean | undefined; x_thread_numbering?: boolean | undefined }): DraftInput {
  return {
    ...(args.x_thread !== undefined ? { xThread: args.x_thread } : {}),
    ...(args.x_thread_numbering !== undefined ? { xThreadNumbering: args.x_thread_numbering } : {}),
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
        note: "Nothing is distributed automatically when a post is published unless the owner (or you, on request) set a plan with set_distribution_plan; otherwise only explicit send/schedule calls distribute.",
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
  inputSchema: { post_id: uuidField("post id"), channel: channelField, text: textField, image: imageField, link_mode: linkModeField, x_thread: xThreadField, x_thread_numbering: xThreadNumberingField },
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
        ...(preview.provider === "x" ? { xThread: preview.xThread, xThreadNumbering: preview.xThreadNumbering, ...(preview.threadParts ? { threadParts: preview.threadParts.map((p, i) => ({ n: i + 1, text: p.text, weight: p.weight, ...(p.over ? { over: true } : {}) })), threadPartCount: preview.threadParts.length, threadMaxParts: preview.threadMaxParts } : {}) } : {}),
        canSend: preview.canSend,
        errors: preview.errorCount,
        warnings: preview.warnCount,
        checks: preview.checks.map((c) => ({ status: c.status, group: c.group, title: c.title, message: c.message, ...(c.value !== null ? { value: c.value } : {}), ...(c.limit !== null ? { limit: c.limit } : {}) })),
        distribution: preview.distribution ? item(preview.distribution) : null,
        previouslySent: preview.previouslySent ? { sentAt: preview.previouslySent.sentAt, url: preview.previouslySent.externalUrl } : null,
        ...untrusted(["post.title", "text", "defaultText", "threadParts[].text", "checks[].value", "previouslySent.url", "distribution.text", "distribution.lastErrorMessage"]),
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
    U + "Save the hand-edited text and options (image, LinkedIn link mode) for one post + channel as a DRAFT. Nothing is sent. Use reset_text=true to go back to the channel's default template. dry_run=true only reports the length and checks. Requires the social-posting permission (social:post), separate from the Telegram channel permission.",
  scope: "social:post",
  limit: "edit",
  inputSchema: {
    post_id: uuidField("post id"),
    channel: channelField,
    text: textField,
    reset_text: z.boolean().optional().describe("Remove the hand-edited text and use the default template again."),
    image: imageField,
    link_mode: linkModeField,
    x_thread: xThreadField,
    x_thread_numbering: xThreadNumberingField,
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
      return { data: { ok: true, dryRun: true, summary: "Dry run: the draft would be saved; nothing was sent.", canSend: preview.canSend, length: preview.length, limit: preview.limit, ...(preview.threadParts ? { threadPartCount: preview.threadParts.length } : {}), failingChecks: preview.checks.filter((c) => c.status !== "ok").map((c) => ({ status: c.status, message: c.message })) } };
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
  x_thread?: boolean | undefined;
  x_thread_numbering?: boolean | undefined;
  again?: boolean | undefined;
  scheduled_at?: string | undefined;
  version_id?: string | undefined;
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
        ...(preview.threadParts ? { threadParts: preview.threadParts.map((p, i) => ({ n: i + 1, text: p.text, weight: p.weight, ...(p.over ? { over: true } : {}) })), threadPartCount: preview.threadParts.length } : {}),
        image: { source: preview.image.source, error: preview.image.error },
        failingChecks: preview.checks.filter((c) => c.status !== "ok").map((c) => ({ status: c.status, message: c.message })),
        post: postBlock(post),
        ...untrusted(["post.title", "text", "threadParts[].text"]),
      },
    };
  }
  const input: QueueInput = { ...draft, ...(args.again ? { again: true } : {}), ...(args.version_id ? { versionId: args.version_id } : {}) };
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
  x_thread: xThreadField,
  x_thread_numbering: xThreadNumberingField,
  version_id: z.string().uuid().optional().describe("Optional: the named version (list_distribution_versions) this text came from. It is only recorded on the distribution; what is posted is still exactly `text` (pass the version's text yourself) or the default template."),
  again: z.boolean().optional().describe("Allow sending even though this post was already sent to this channel (creates a duplicate on purpose). Default false."),
  idempotency_key: idempotencyKeyField,
  dry_run: dryRunField,
};

export const sendDistributionTool = defineTool({
  name: "send_distribution",
  title: "Send a post to a social channel",
  description:
    U + PUBLIC_WARNING + "Queue ONE published post for ONE channel now (LinkedIn profile, X, Threads, Instagram, or regenerate the GitHub README latest-posts block). The preflight runs first: if any check fails nothing is queued and you get the checklist. The actual sending happens in the background within about a minute (not instant); an unclear platform answer becomes needs_checking, which only the owner resolves in the web panel. Pass idempotency_key so a retry cannot post twice. expected_updated_at is REQUIRED. Requires the social-posting permission (social:post), separate from the Telegram channel permission.",
  scope: "social:post",
  limit: "social",
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
    U + PUBLIC_WARNING + "Schedule ONE published post for ONE channel at a future time (scheduled_at, ISO 8601; at least a minute ahead, at most a year). The same checks as send_distribution run now and again at send time; the owner can cancel before then. Nothing is posted at publish time on its own - only this explicit schedule. Pass idempotency_key. expected_updated_at is REQUIRED. Requires the social-posting permission (social:post), separate from the Telegram channel permission.",
  scope: "social:post",
  limit: "social",
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
    U + "Cancel a draft, scheduled or failed distribution so it will not be sent. A distribution that is already sending or sent cannot be cancelled (use remove_distribution_from_platform for a sent one, where supported). Requires the social-posting permission (social:post), separate from the Telegram channel permission.",
  scope: "social:post",
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
    U + PUBLIC_WARNING + "Retry a FAILED distribution (resumes from where it stopped when the platform allows, e.g. reusing an already uploaded image). It refuses needs_checking: that state means the platform may already have the post, and only the owner may resolve it in the web panel. Requires the social-posting permission (social:post), separate from the Telegram channel permission.",
  scope: "social:post",
  limit: "social",
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
    U + "Delete a previously SENT post from the platform where the platform's API supports it (LinkedIn, X, Threads; not Instagram or the GitHub README block). This deletes a public post and cannot be undone. ASK THE OWNER FOR APPROVAL EVERY TIME. Requires the social-posting permission (social:post), separate from the Telegram channel permission.",
  scope: "social:post",
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

const PLAN_WARNING =
  "ACTS ON THE PUBLIC INTERNET LATER: a plan makes the server post to the owner's real public account automatically, delay_minutes after the post is published (by anyone, any way, including its scheduled publish time) - not now. ASK THE OWNER FOR APPROVAL EVERY TIME (show the channel, the delay and the text first; use dry_run=true to get the checks) and never plan several channels without being asked. ";

export const setDistributionPlanTool = defineTool({
  name: "set_distribution_plan",
  title: "Plan a social post for after the blog post is published",
  description:
    U + PLAN_WARNING + `Set (or replace) the relative plan for ONE channel of a post that is NOT yet published (draft, in review or scheduled): "delay_minutes after it goes live" (0 = at the next minute tick, max ${DISTRIBUTION_PLAN_MAX_DELAY_MINUTES} = 7 days). When the post is published the server turns the plan into a normal scheduled distribution at publish time + delay, using the text at that moment: the named version (version_id, or the channel's primary version when you pass neither version_id nor text) read live, else the text you pass, else the saved text/default template. The same checks as schedule_distribution run THEN; if they fail the distribution becomes failed with the reason (visible in list_post_distributions) and nothing is posted. Unpublishing returns not-yet-sent plans to waiting; the plan is kept. A post that is already published cannot be planned - use schedule_distribution. dry_run=true only reports the checks. Requires the social-posting permission (social:post), separate from the Telegram channel permission.`,
  scope: "social:post",
  limit: "social",
  inputSchema: {
    post_id: uuidField("post id"),
    channel: channelField,
    delay_minutes: z.number().int().min(0).max(DISTRIBUTION_PLAN_MAX_DELAY_MINUTES).describe(`Minutes after the post is published (0-${DISTRIBUTION_PLAN_MAX_DELAY_MINUTES}).`),
    version_id: z.string().uuid().optional().describe("Optional: the named version (list_distribution_versions) whose text is posted; its text is read when the post is published."),
    text: textField,
    image_choice: imageField,
    link_mode: linkModeField,
    x_thread: xThreadField,
    x_thread_numbering: xThreadNumberingField,
    dry_run: dryRunField,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  kind: "write",
  async handler(args, ctx) {
    const channel = args.channel as ProviderId;
    const post = await loadPostAnyState(args.post_id);
    if (!post || post.deletedAt) throw new ToolError("not_found", "No live post with this id.", "Use list_posts to find the post.");
    if (args.dry_run) {
      const summary = await checkPlan(args.post_id, channel, draftOf({ text: args.text, image: args.image_choice, link_mode: args.link_mode, x_thread: args.x_thread, x_thread_numbering: args.x_thread_numbering }));
      const publishedNow = post.status === "published";
      return {
        data: {
          ok: true,
          dryRun: true,
          summary: publishedNow ? "Dry run: refused, the post is already published (use schedule_distribution)." : "Dry run: the plan can be set; nothing was saved or sent.",
          canSet: !publishedNow && post.status !== "archived",
          wouldDo: `After the post is published, post to ${channel} ${args.delay_minutes} minute(s) later, publicly, as the owner's account.`,
          ...(summary ? { text: summary.text, length: summary.length, limit: summary.limit, failingChecks: summary.checks.filter((c) => c.status !== "ok").map((c) => ({ status: c.status, message: c.message })) } : {}),
          ...untrusted(["text"]),
        },
      };
    }
    const result = await setPlan(ctx.actor, args.post_id, channel, {
      delayMinutes: args.delay_minutes,
      ...(args.version_id ? { versionId: args.version_id } : {}),
      ...draftOf({ text: args.text, image: args.image_choice, link_mode: args.link_mode, x_thread: args.x_thread, x_thread_numbering: args.x_thread_numbering }),
    });
    if (!result.ok) {
      throw new ToolError(
        result.error.kind === "conflict" ? "conflict" : result.error.kind === "not_found" ? "not_found" : result.error.kind === "bad_request" ? "invalid_input" : "unprocessable",
        result.error.message,
        undefined,
        undefined,
        ["error.message"],
      );
    }
    return { data: { ok: true, summary: "Plan saved. Nothing is sent now: the server posts it automatically after the blog post is published.", distribution: item(result.data), post: postBlock(post), ...untrusted(["post.title", "distribution.text"]) } };
  },
});

export const clearDistributionPlanTool = defineTool({
  name: "clear_distribution_plan",
  title: "Remove a channel's after-publish plan",
  description:
    U + "Remove the relative \"N minutes after publish\" plan of one post + channel. If the plan had already been turned into a scheduled distribution that has not been sent yet, that scheduled distribution is cancelled too; sent or sending ones are never touched. Saved text and versions stay. Requires the social-posting permission (social:post), separate from the Telegram channel permission.",
  scope: "social:post",
  limit: "edit",
  inputSchema: { post_id: uuidField("post id"), channel: channelField, dry_run: dryRunField },
  annotations: LOCAL_WRITE,
  kind: "write",
  async handler(args, ctx) {
    const channel = args.channel as ProviderId;
    if (args.dry_run) {
      const res = unwrap(await listPostDistributions(args.post_id), { notFound: "Use list_posts to find the post." });
      const row = res.distributions.find((d) => d.provider === channel && d.planDelayMinutes !== null && ["draft", "scheduled", "sending", "failed", "needs_checking"].includes(d.status));
      return { data: { ok: true, dryRun: true, summary: row ? "Dry run: the plan would be removed." : "Dry run: there is no plan for this channel.", hasPlan: Boolean(row), wouldCancelScheduled: row?.status === "scheduled" && row.planMaterializedAt !== null } };
    }
    const res = unwrap(await clearPlan(ctx.actor, args.post_id, channel), { notFound: "Use list_posts to find the post." });
    return { data: { ok: true, summary: res.cleared ? (res.cancelled ? "Plan removed and the not-yet-sent scheduled distribution cancelled." : "Plan removed.") : "There was no plan; nothing was changed.", alreadyInState: !res.cleared, distribution: res.distribution ? item(res.distribution) : null, ...untrusted(["distribution.text"]) } };
  },
});

const versionChannelField = z.enum(["linkedin", "x", "threads", "instagram"]).describe("Channel: linkedin | x | threads | instagram (GitHub has no editable text, so no versions).");
const versionIdField = uuidField("distribution version id (from list_distribution_versions)");
const versionNameField = z.string().max(80).optional().describe("Version name, up to 80 characters (default: '<N>-versiya').");

function versionOut(v: DistributionVersionDto): Record<string, unknown> {
  const { createdBy: _c, ...rest } = v;
  void _c;
  return rest;
}

const VERSION_UNTRUSTED = ["version.name", "version.text"];

export const listDistributionVersionsTool = defineTool({
  name: "list_distribution_versions",
  title: "List a post's named distribution versions",
  description:
    U + "List the named text versions saved for one post + social channel (up to 10; one may be marked primary - the one the web dialog opens on). Each has name, the exact text, image choice, LinkedIn link mode, isPrimary. The Telegram channel versions are separate (list_channel_versions). Read-only.",
  scope: "blog:read",
  inputSchema: { post_id: uuidField("post id"), channel: versionChannelField },
  annotations: READ_ONLY,
  kind: "read",
  async handler(args) {
    const versions = unwrap(await listVersions(args.post_id, args.channel as ProviderId), { notFound: "Use list_posts to find the post." });
    return { data: { versions: versions.map(versionOut), primaryId: versions.find((v) => v.isPrimary)?.id ?? null, ...untrusted(["versions[].name", "versions[].text"]) }, listKey: "versions" };
  },
});

export const createDistributionVersionTool = defineTool({
  name: "create_distribution_version",
  title: "Create a named distribution version",
  description:
    U + "Create a named text version for one post + social channel (max 10 per channel). Text comes from `text`, or is copied from `from_version_id`, or (neither given) from the channel's default template. Saved only; nothing is sent. make_primary=true also marks it primary. Requires the social-posting permission (social:post).",
  scope: "social:post",
  limit: "edit",
  inputSchema: {
    post_id: uuidField("post id"),
    channel: versionChannelField,
    name: versionNameField,
    text: textField,
    from_version_id: z.string().uuid().optional().describe("Copy text, image and link mode from this existing version instead of passing text."),
    image: imageField,
    link_mode: linkModeField,
    make_primary: z.boolean().optional().describe("Also mark the new version primary."),
    dry_run: dryRunField,
  },
  annotations: LOCAL_WRITE,
  kind: "write",
  async handler(args, ctx) {
    if (args.dry_run) {
      const existing = unwrap(await listVersions(args.post_id, args.channel as ProviderId), { notFound: "Use list_posts to find the post." });
      return { data: { ok: true, dryRun: true, summary: existing.length >= 10 ? "Dry run: refused, the channel already has 10 versions." : "Dry run: the version would be created; nothing was sent.", versionsNow: existing.length, canCreate: existing.length < 10 } };
    }
    const created = unwrap(
      await createVersion(ctx.actor, args.post_id, args.channel as ProviderId, {
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.text !== undefined ? { text: args.text } : {}),
        ...(args.from_version_id ? { fromVersionId: args.from_version_id } : {}),
        ...(args.image !== undefined ? { imageChoice: args.image } : {}),
        ...(args.link_mode !== undefined ? { linkMode: args.link_mode } : {}),
        ...(args.make_primary ? { makePrimary: true } : {}),
      }),
      { notFound: "Use list_posts / list_distribution_versions." },
    );
    return { data: { ok: true, summary: "Version created. Nothing was sent.", version: versionOut(created), ...untrusted(VERSION_UNTRUSTED) } };
  },
});

export const updateDistributionVersionTool = defineTool({
  name: "update_distribution_version",
  title: "Edit a named distribution version",
  description:
    U + "Rename a version or change its text, image choice or LinkedIn link mode. Pass expected_version_updated_at (the version's updatedAt from your last read) to avoid overwriting a concurrent edit. Saved only; nothing is sent. Requires the social-posting permission (social:post).",
  scope: "social:post",
  limit: "edit",
  inputSchema: {
    version_id: versionIdField,
    name: versionNameField,
    text: textField,
    image: imageField,
    link_mode: linkModeField,
    expected_version_updated_at: z.string().min(10).max(40).optional().describe("The version.updatedAt you last saw; the call conflicts if it changed since."),
    dry_run: dryRunField,
  },
  annotations: LOCAL_WRITE,
  kind: "write",
  async handler(args, ctx) {
    const row = await getVersion(args.version_id);
    if (!row) throw new ToolError("not_found", "No version with this id.", "Use list_distribution_versions.");
    if (args.dry_run) return { data: { ok: true, dryRun: true, summary: "Dry run: the version would be updated.", version: versionOut(toVersionDto(row)), ...untrusted(VERSION_UNTRUSTED) } };
    const updated = unwrap(
      await updateVersion(ctx.actor, args.version_id, {
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.text !== undefined ? { text: args.text } : {}),
        ...(args.image !== undefined ? { imageChoice: args.image } : {}),
        ...(args.link_mode !== undefined ? { linkMode: args.link_mode } : {}),
        ...(args.expected_version_updated_at ? { expectedUpdatedAt: args.expected_version_updated_at } : {}),
      }),
    );
    return { data: { ok: true, summary: "Version saved. Nothing was sent.", version: versionOut(updated), ...untrusted(VERSION_UNTRUSTED) } };
  },
});

export const deleteDistributionVersionTool = defineTool({
  name: "delete_distribution_version",
  title: "Delete a named distribution version",
  description:
    U + "Delete one saved version (past sends keep their text; only the link to the version is dropped). If it was primary, the channel has no primary afterwards. Requires the social-posting permission (social:post).",
  scope: "social:post",
  limit: "edit",
  inputSchema: { version_id: versionIdField, dry_run: dryRunField },
  annotations: LOCAL_WRITE,
  kind: "write",
  async handler(args, ctx) {
    const row = await getVersion(args.version_id);
    if (!row) throw new ToolError("not_found", "No version with this id.", "Use list_distribution_versions.");
    if (args.dry_run) return { data: { ok: true, dryRun: true, summary: "Dry run: the version would be deleted.", wasPrimary: row.isPrimary, name: row.name, ...untrusted(["name"]) } };
    const res = unwrap(await deleteVersion(ctx.actor, args.version_id));
    return { data: { ok: true, summary: "Version deleted.", ...res } };
  },
});

export const setDistributionPrimaryTool = defineTool({
  name: "set_distribution_primary",
  title: "Mark a distribution version primary",
  description:
    U + "Mark one version primary (the web dialog opens on it; it replaces the previous primary of that post + channel). Or pass clear=true with post_id and channel to leave the channel without a primary. Nothing is sent. Requires the social-posting permission (social:post).",
  scope: "social:post",
  limit: "edit",
  inputSchema: {
    version_id: z.string().uuid().optional().describe("The version to mark primary."),
    clear: z.boolean().optional().describe("true: remove the primary mark from the channel (needs post_id and channel, no version_id)."),
    post_id: z.string().uuid().optional().describe("With clear=true."),
    channel: versionChannelField.optional().describe("With clear=true."),
    dry_run: dryRunField,
  },
  annotations: LOCAL_WRITE,
  kind: "write",
  async handler(args, ctx) {
    if (args.clear) {
      if (args.version_id || !args.post_id || !args.channel) throw new ToolError("invalid_input", "clear=true needs post_id and channel and no version_id.");
      if (args.dry_run) return { data: { ok: true, dryRun: true, summary: "Dry run: the primary mark would be removed." } };
      return { data: { ok: true, summary: "Primary mark removed.", ...unwrap(await clearPrimary(ctx.actor, args.post_id, args.channel as ProviderId), { notFound: "Use list_posts to find the post." }) } };
    }
    if (!args.version_id) throw new ToolError("invalid_input", "Pass version_id (or clear=true with post_id and channel).");
    const row = await getVersion(args.version_id);
    if (!row) throw new ToolError("not_found", "No version with this id.", "Use list_distribution_versions.");
    if (args.dry_run) return { data: { ok: true, dryRun: true, summary: row.isPrimary ? "Dry run: it is already primary." : "Dry run: it would become primary." } };
    return { data: { ok: true, summary: "Marked primary.", version: versionOut(unwrap(await setPrimary(ctx.actor, args.version_id))), ...untrusted(VERSION_UNTRUSTED) } };
  },
});

export const DISTRIBUTION_READ_TOOLS: McpToolDef[] = [listDistributionChannelsTool, previewDistributionTool, listPostDistributionsTool, getDistributionStatusTool, listDistributionVersionsTool] as unknown as McpToolDef[];
export const DISTRIBUTION_WRITE_TOOLS: McpToolDef[] = [saveDistributionTextTool, sendDistributionTool, scheduleDistributionTool, cancelDistributionTool, retryDistributionTool, removeDistributionTool, createDistributionVersionTool, updateDistributionVersionTool, deleteDistributionVersionTool, setDistributionPrimaryTool, setDistributionPlanTool, clearDistributionPlanTool] as unknown as McpToolDef[];

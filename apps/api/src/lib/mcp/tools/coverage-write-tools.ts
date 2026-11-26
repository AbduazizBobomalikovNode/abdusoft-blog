import { z } from "zod";
import { PostSettingsSchema, SocialLinksSchema, TelegramDisplayModeSchema, type ChannelChoice, type ChannelPlan, type ContentNode } from "@blog/shared";
import { liftBan } from "../../bans-admin.js";
import { sendReplyToTelegram } from "../../comments-moderation.js";
import { TelegramReplyError } from "../../comments-admin.js";
import { recordAuditSafe } from "../../audit.js";
import { createStaffInviteAudited, removeStaffMemberAudited, revokeStaffInviteAudited } from "../../staff-admin.js";
import { saveSettingsAudited, updateSiteSettings } from "../../site-admin.js";
import { SettingsValidationError, getSettings } from "../../settings.js";
import { loadSiteSettings } from "../../site-settings.js";
import { updatePost } from "../../posts/index.js";
import { postHasChannelMessage } from "../../posts/channel-guard.js";
import { previewChannelPost } from "../../../telegram/channel-actions.js";
import { preparePlan } from "../../posts/plan.js";
import { loadVersion } from "../../../telegram/channel-versions.js";
import { telegramHtmlToDoc, validateRestrictedDoc } from "../../../telegram/channel-html.js";
import { channelSendImpact, clearChannelChoiceAudited, createChannelVersionAudited, deleteChannelVersionAudited, resyncChannelCaptionAudited, setChannelChoiceAudited, updateChannelVersionAudited } from "../../../telegram/channel-admin.js";
import { getTelegramRefForPost, refreshTelegraphMirror } from "../../../telegram/publish.js";
import { withIdempotency } from "../idempotency.js";
import { aboutEtag } from "./coverage-read-tools.js";
import { documentFromMarkdown, validatedDocument } from "./post-write-tools.js";
import { CONTENT_MAX_CHARS, assertFreshToken, dryRunField, expectedUpdatedAtField, idempotencyKeyField, loadPostAnyState, lossyReport, postBlock, unwrapPost, uuidField } from "./write-support.js";
import { UNTRUSTED_DESCRIPTION_PREFIX as U, untrusted } from "./untrusted.js";
import { ToolError, defineTool, type McpToolDef } from "./types.js";

const ADDITIVE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const STATE_CHANGE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const OVERWRITES = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const postId = uuidField("post id from list_posts or get_post");
const versionId = uuidField("channel version id from list_channel_versions");
const versionToken = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: "must be an ISO timestamp exactly as returned in version.updatedAt" })
  .describe("REQUIRED concurrency token: the version's updatedAt from list_channel_versions / get_channel_version, passed back unchanged. If the version changed meanwhile (for example edited in the web panel) nothing is written.");

/** `channels:prepare` hech narsa yubormaydi, lekin kutilayotgan ommaviy yuborish ishlatadigan versiya/belgini o'zgartirish `channels:send` talab qiladi. */
async function requireSendScopeIfPublic(ctx: { scopes: ReadonlySet<string> }, post: Parameters<typeof channelSendImpact>[0], target: Parameters<typeof channelSendImpact>[1]) {
  if (ctx.scopes.has("channels:send")) return;
  const impact = await channelSendImpact(post, target);
  if (!impact) return;
  throw new ToolError(
    "conflict",
    `Refused: ${impact}. This connection may only prepare channel versions (channels:prepare), and this change would alter a pending public Telegram post.`,
    "Cancel or change the channel plan first (needs the channels:send permission), or ask the owner to make this change in the web panel or to grant channels:send.",
    { requiredScope: "channels:send", grantedScopes: [...ctx.scopes].sort() },
  );
}

async function livePost(id: string) {
  const post = await loadPostAnyState(id);
  if (!post || post.deletedAt) throw new ToolError("not_found", "No live post with this id.", "Use list_posts to find the post.");
  return post;
}
const unwrapSvc = <T>(result: Parameters<typeof unwrapPost<T>>[0], hint?: string) => unwrapPost(result, "", hint ? { notFound: hint } : {});

function channelFailure(error: string, status: number): never {
  throw new ToolError(status === 404 ? "not_found" : status === 409 ? "conflict" : "invalid_input", error, "Use list_channel_versions to see the versions and their limits.");
}

// --------------------------------------------------------------------------- kanal versiyalari (channels:prepare)

const selection = {
  mode: z.enum(["media", "text"]).optional().describe("'media' = photo/album with a caption, 'text' = a text message (use with variant)."),
  variant: z.enum(["s", "m", "l", "xl"]).optional().describe("Automatic length variant (use with mode)."),
  version_id: uuidField("custom channel version id").optional().describe("A custom channel version (use instead of mode+variant)."),
};

function choiceFrom(args: { mode?: "media" | "text" | undefined; variant?: "s" | "m" | "l" | "xl" | undefined; version_id?: string | undefined }): ChannelChoice {
  if (args.version_id) {
    if (args.mode || args.variant) throw new ToolError("invalid_input", "Pass either version_id or mode+variant, not both.");
    return { kind: "version", versionId: args.version_id };
  }
  if (!args.mode || !args.variant) throw new ToolError("invalid_input", "Pass version_id, or mode and variant together.");
  return { kind: "auto", mode: args.mode, variant: args.variant };
}

export const createChannelVersionTool = defineTool({
  name: "create_channel_version",
  title: "Create a Telegram channel version",
  description:
    U + "Prepare a custom Telegram channel version for a post by copying an automatic variant (mode + from_variant) or an existing version (from_version_id); edit its text afterwards with update_channel_version. Nothing is sent to the channel and the post is not changed. Pass idempotency_key so a retry does not create two.",
  scope: "channels:prepare",
  limit: "create",
  inputSchema: {
    id: postId,
    mode: z.enum(["media", "text"]).describe("'media' (photo caption, 1024 chars) or 'text' (message, 4096 chars)."),
    from_variant: z.enum(["s", "m", "l", "xl"]).optional().describe("Copy this automatic length variant (default l for media, xl for text)."),
    from_version_id: uuidField("existing version id").optional().describe("Copy an existing version instead."),
    name: z.string().trim().min(1).max(80).optional().describe("Version name (default 'Versiya N')."),
    idempotency_key: idempotencyKeyField,
  },
  annotations: ADDITIVE,
  kind: "write",
  async handler(args, ctx) {
    return withIdempotency(ctx, "create_channel_version", args.idempotency_key, args, async () => {
      const post = await livePost(args.id);
      const result = await createChannelVersionAudited(ctx.actor, post, {
        mode: args.mode,
        ...(args.from_variant ? { fromVariant: args.from_variant } : {}),
        ...(args.from_version_id ? { fromVersionId: args.from_version_id } : {}),
        ...(args.name ? { name: args.name } : {}),
      });
      if (!result.ok) return channelFailure(result.error, result.status);
      const v = result.data;
      return { data: { ok: true, summary: `Channel version created: ${v.name}.`, version: { id: v.id, name: v.name, mode: v.mode, visibleLength: v.visibleLength, limit: v.limit, overLimit: v.overLimit, updatedAt: v.updatedAt }, post: postBlock(post), ...untrusted(["version.name", "post.title"]) } };
    });
  },
});

export const updateChannelVersionTool = defineTool({
  name: "update_channel_version",
  title: "Edit a Telegram channel version",
  description:
    U + "Change a custom channel version: its name, its text (text_html, Telegram HTML: <b> <i> <u> <s> <code> <a href> <blockquote>, blocks separated by a blank line), its images (image_urls: urls offered by list_channel_versions postImages) or its mode. Only the fields you pass change. Nothing is sent, but if a scheduled channel plan will send this version (directly, or because it is the marked version and the plan uses the mark) the change is refused unless the connection also has channels:send. expected_version_updated_at is REQUIRED (conflict if the version changed meanwhile).",
  scope: "channels:prepare",
  limit: "edit",
  inputSchema: {
    id: postId,
    version_id: versionId,
    expected_version_updated_at: versionToken,
    name: z.string().trim().min(1).max(80).optional(),
    text_html: z.string().max(12_000).optional().describe("New text as Telegram HTML."),
    image_urls: z.array(z.string().max(2000)).max(10).optional().describe("Images (urls from postImages), in order. Only for mode 'media'."),
    mode: z.enum(["media", "text"]).optional(),
  },
  annotations: OVERWRITES,
  kind: "write",
  async handler(args, ctx) {
    const post = await livePost(args.id);
    const existing = await loadVersion(post.id, args.version_id);
    if (!existing) throw new ToolError("not_found", "No such channel version for this post.", "Use list_channel_versions.");
    if (existing.updatedAt.getTime() !== Date.parse(args.expected_version_updated_at)) {
      throw new ToolError("conflict", "The channel version was changed after you read it, so nothing was written.", "Re-read it with get_channel_version, merge your intent and retry with its fresh updatedAt.", { currentUpdatedAt: existing.updatedAt.toISOString() });
    }
    await requireSendScopeIfPublic(ctx, post, { versionId: args.version_id });
    const body: Parameters<typeof updateChannelVersionAudited>[3] = {};
    if (args.name !== undefined) body.name = args.name;
    if (args.mode !== undefined) body.mode = args.mode;
    if (args.image_urls !== undefined) body.imageUrls = args.image_urls;
    if (args.text_html !== undefined) {
      const doc = telegramHtmlToDoc(args.text_html);
      const problem = validateRestrictedDoc(doc);
      if (problem) throw new ToolError("invalid_input", problem);
      body.contentJson = doc;
    }
    if (Object.keys(body).length === 0) throw new ToolError("invalid_input", "Nothing to change: pass name, text_html, image_urls or mode.");
    const result = await updateChannelVersionAudited(ctx.actor, post, args.version_id, body);
    if (!result.ok) return channelFailure(result.error, result.status);
    const v = result.data;
    return { data: { ok: true, summary: `Channel version updated (${Object.keys(body).join(", ")}).`, version: { id: v.id, name: v.name, mode: v.mode, visibleLength: v.visibleLength, limit: v.limit, overLimit: v.overLimit, updatedAt: v.updatedAt }, ...untrusted(["version.name"]) } };
  },
});

export const deleteChannelVersionTool = defineTool({
  name: "delete_channel_version",
  title: "Delete a Telegram channel version",
  description:
    "Delete a custom channel version. Refused while a scheduled channel plan uses it. If it was the version marked on the post, the mark is cleared (the result says so). Messages already in the channel are not touched. The version cannot be restored. expected_version_updated_at is REQUIRED.",
  scope: "channels:prepare",
  limit: "destructive",
  inputSchema: { id: postId, version_id: versionId, expected_version_updated_at: versionToken },
  annotations: DESTRUCTIVE,
  kind: "write",
  async handler(args, ctx) {
    const post = await livePost(args.id);
    const existing = await loadVersion(post.id, args.version_id);
    if (!existing) throw new ToolError("not_found", "No such channel version for this post.", "Use list_channel_versions.");
    if (existing.updatedAt.getTime() !== Date.parse(args.expected_version_updated_at)) {
      throw new ToolError("conflict", "The channel version was changed after you read it, so nothing was deleted.", "Re-read it with get_channel_version first.", { currentUpdatedAt: existing.updatedAt.toISOString() });
    }
    const result = await deleteChannelVersionAudited(ctx.actor, post, args.version_id);
    if (!result.ok) return channelFailure(result.error, result.status);
    return { data: { ok: true, summary: "The channel version was deleted.", clearedChoice: result.data.clearedChoice } };
  },
});

export const setChannelChoiceTool = defineTool({
  name: "set_channel_choice",
  title: "Mark the version to send to the channel",
  description:
    "Mark which Telegram version a post uses when it is sent (an automatic mode+variant, or a custom version_id). This only records the choice; nothing is sent. If a scheduled channel plan uses the marked version, the change is refused unless the connection also has channels:send. expected_updated_at is REQUIRED.",
  scope: "channels:prepare",
  limit: "edit",
  inputSchema: { id: postId, expected_updated_at: expectedUpdatedAtField, ...selection },
  annotations: STATE_CHANGE,
  kind: "write",
  async handler(args, ctx) {
    const post = await livePost(args.id);
    await assertFreshToken(post, args.expected_updated_at);
    const choice = choiceFrom(args);
    await requireSendScopeIfPublic(ctx, post, { choiceChange: true });
    const result = await setChannelChoiceAudited(ctx.actor, post, choice, ctx.user.id);
    if (!result.ok) return channelFailure(result.error, result.status);
    return { data: { ok: true, summary: "The channel version was marked.", marked: result.choice ? { label: result.choice.label, mode: result.choice.mode, visibleLength: result.choice.visibleLength, limit: result.choice.limit, passesChecks: result.choice.passes } : null, post: postBlock((await loadPostAnyState(post.id)) ?? post), ...untrusted(["marked.label", "post.title"]) } };
  },
});

export const clearChannelChoiceTool = defineTool({
  name: "clear_channel_choice",
  title: "Clear the marked channel version",
  description: "Remove the mark that says which Telegram version the post uses (sending then falls back to the default). Nothing is sent or deleted (refused without channels:send when a scheduled channel plan uses the mark). expected_updated_at is REQUIRED.",
  scope: "channels:prepare",
  limit: "edit",
  inputSchema: { id: postId, expected_updated_at: expectedUpdatedAtField },
  annotations: STATE_CHANGE,
  kind: "write",
  async handler(args, ctx) {
    const post = await livePost(args.id);
    await assertFreshToken(post, args.expected_updated_at);
    await requireSendScopeIfPublic(ctx, post, { choiceChange: true });
    await clearChannelChoiceAudited(ctx.actor, post);
    return { data: { ok: true, summary: "The mark was removed.", post: postBlock(post), ...untrusted(["post.title"]) } };
  },
});

// --------------------------------------------------------------------------- kanalga yuborish rejasi va sinxron (channels:send)

export const setChannelPlanTool = defineTool({
  name: "set_channel_plan",
  title: "Plan the channel send of a scheduled post",
  description:
    U + "For a post that is SCHEDULED: plan that it is sent to the Telegram channel delay_minutes after it is published (use the marked version with use_marked=true, or mode+variant, or version_id). The Telegram preflight must pass. Nothing is sent now; the server sends it automatically after publishing, so this is a public action later. dry_run=true only reports the preflight. Cancel with cancel_channel_plan. expected_updated_at is REQUIRED.",
  scope: "channels:send",
  limit: "channel",
  inputSchema: {
    id: postId,
    expected_updated_at: expectedUpdatedAtField,
    delay_minutes: z.number().int().min(0).max(10080).describe("Minutes after publishing (0-10080)."),
    use_marked: z.boolean().optional().describe("Use the version marked on the post at send time (default when no other choice is given)."),
    ...selection,
    dry_run: dryRunField,
  },
  annotations: OVERWRITES,
  kind: "write",
  async handler(args, ctx) {
    const post = await livePost(args.id);
    await assertFreshToken(post, args.expected_updated_at);
    if (post.status !== "scheduled") throw new ToolError("conflict", "A channel plan can only be set on a scheduled post.", "Schedule it first with schedule_post.");
    let plan: ChannelPlan;
    if (args.version_id || args.mode || args.variant) {
      const c = choiceFrom(args);
      plan = c.kind === "version" ? { versionId: c.versionId, delayMinutes: args.delay_minutes } : { mode: c.mode, variant: c.variant, delayMinutes: args.delay_minutes };
    } else {
      plan = { useChoice: true, delayMinutes: args.delay_minutes };
    }
    if (args.dry_run) {
      const prepared = await preparePlan(post.id, plan);
      return { data: { ok: true, dryRun: true, summary: prepared.ok ? "Dry run: the plan passes the Telegram checks." : "Dry run: the plan would be refused.", canPlan: prepared.ok, ...(prepared.ok ? {} : { refusedBecause: prepared.error.message }), post: postBlock(post), ...untrusted(["post.title", "refusedBecause"]) } };
    }
    await unwrapPost(await updatePost(ctx.actor, post.id, { channelPlan: plan, expectedUpdatedAt: args.expected_updated_at }, { audit: { action: "post.channel_plan_set", summary: "Kanalga yuborish rejasi o'rnatildi", meta: { delayMinutes: args.delay_minutes } } }), post.id);
    return { data: { ok: true, summary: `The post will be sent to the channel ${args.delay_minutes} minute(s) after it is published.`, post: postBlock((await loadPostAnyState(post.id)) ?? post), ...untrusted(["post.title"]) } };
  },
});

export const cancelChannelPlanTool = defineTool({
  name: "cancel_channel_plan",
  title: "Cancel a planned channel send",
  description: "Remove the planned Telegram channel send of a scheduled post. The schedule itself stays. Nothing is sent or deleted. expected_updated_at is REQUIRED.",
  scope: "channels:send",
  limit: "channel",
  inputSchema: { id: postId, expected_updated_at: expectedUpdatedAtField },
  annotations: STATE_CHANGE,
  kind: "write",
  async handler(args, ctx) {
    const post = await livePost(args.id);
    await assertFreshToken(post, args.expected_updated_at);
    if (post.channelPlan == null) return { data: { ok: true, alreadyInState: true, summary: "There was no channel plan; nothing was changed.", post: postBlock(post), ...untrusted(["post.title"]) } };
    await unwrapPost(await updatePost(ctx.actor, post.id, { channelPlan: null, expectedUpdatedAt: args.expected_updated_at }, { audit: { action: "post.channel_plan_clear", summary: "Kanalga yuborish rejasi olib tashlandi" } }), post.id);
    return { data: { ok: true, summary: "The channel plan was cancelled.", post: postBlock((await loadPostAnyState(post.id)) ?? post), ...untrusted(["post.title"]) } };
  },
});

export const resyncChannelCaptionTool = defineTool({
  name: "resync_channel_caption",
  title: "Refresh the channel message text",
  description:
    U + "Rebuild the text of the post's EXISTING Telegram channel message from the current post (edits the public channel message in place). If the post was never sent, nothing happens. dry_run=true shows the caption that would be used and whether a channel message exists.",
  scope: "channels:send",
  limit: "channel",
  inputSchema: { id: postId, dry_run: dryRunField },
  annotations: OVERWRITES,
  kind: "write",
  async handler(args, ctx) {
    const post = await livePost(args.id);
    const exists = await postHasChannelMessage(post.id);
    if (args.dry_run) {
      const { resolveChoiceForSend } = await import("../../../telegram/channel-choice.js");
      const resolved = await resolveChoiceForSend(post.id);
      const preview = resolved ? await previewChannelPost(post.id, resolved.selection) : null;
      return { data: { ok: true, dryRun: true, summary: exists ? "Dry run: the existing channel message would be edited." : "Dry run: the post is not in the channel; nothing would happen.", channelMessageExists: exists, ...(preview && preview.ok ? { captionHtml: preview.computed.captionHtml.slice(0, 1500) } : {}), post: postBlock(post), ...untrusted(["post.title", "captionHtml"]) } };
    }
    if (!exists) return { data: { ok: true, alreadyInState: true, summary: "The post is not in the channel; nothing was changed.", post: postBlock(post), ...untrusted(["post.title"]) } };
    await resyncChannelCaptionAudited(ctx.actor, post.id);
    return { data: { ok: true, summary: "The channel message text was refreshed.", post: postBlock(post), ...untrusted(["post.title"]) } };
  },
});

// --------------------------------------------------------------------------- Telegraph ko'zgusi (posts:publish)

export const refreshTelegraphMirrorTool = defineTool({
  name: "refresh_telegraph_mirror",
  title: "Refresh the Telegraph mirror page",
  description:
    "Create or refresh the Telegraph (telegra.ph) mirror page of a PUBLISHED post from its current content (only if the Telegraph integration and the post's telegraphMirror setting are on). The Telegram channel message is never touched by this tool. Returns the page url when there is one.",
  scope: "posts:publish",
  limit: "publish",
  inputSchema: { id: postId },
  annotations: STATE_CHANGE,
  kind: "write",
  async handler(args, ctx) {
    const post = await livePost(args.id);
    if (post.status !== "published") throw new ToolError("conflict", "Only a published post has a Telegraph mirror.", "Publish it first with publish_post.");
    await refreshTelegraphMirror(post.id, { skipChannel: true });
    await recordAuditSafe(ctx.actor, { action: "post.telegraph_refresh", entityType: "post", entityId: post.id, summary: "Telegraph ko'zgusi yangilandi" });
    const ref = await getTelegramRefForPost(post.id);
    return { data: { ok: true, summary: ref?.telegraphUrl ? "The Telegraph mirror is up to date." : "No Telegraph page exists (the integration or the post's telegraphMirror setting is off).", telegraphUrl: ref?.telegraphUrl ?? null, post: postBlock(post), ...untrusted(["post.title"]) } };
  },
});

// --------------------------------------------------------------------------- izohlar (comments:moderate)

export const liftCommentBanTool = defineTool({
  name: "lift_comment_ban",
  title: "Lift a comment ban",
  description: "Lift a commenter ban (id from list_comment_bans). The person can comment again; their old hidden comments are not restored. Use only on the owner's instruction.",
  scope: "comments:moderate",
  limit: "moderate",
  inputSchema: { ban_id: uuidField("ban id from list_comment_bans") },
  annotations: STATE_CHANGE,
  kind: "write",
  async handler(args, ctx) {
    await unwrapSvc(await liftBan(ctx.actor, args.ban_id), "Use list_comment_bans to find a valid ban id.");
    return { data: { ok: true, summary: "The ban was lifted." } };
  },
});

export const resendReplyToTelegramTool = defineTool({
  name: "resend_reply_to_telegram",
  title: "Send an admin reply to the Telegram group",
  description: "Send an admin reply (a visible reply under a Telegram-sourced comment that was not delivered) to the Telegram discussion group as the bot. Refused when it was already sent or is not a reply to a Telegram comment.",
  scope: "comments:moderate",
  limit: "moderate",
  inputSchema: { id: uuidField("reply comment id from list_comments") },
  annotations: ADDITIVE,
  kind: "write",
  async handler(args, ctx) {
    try {
      const sent = await sendReplyToTelegram(ctx.actor, args.id);
      if (!sent) throw new ToolError("not_found", "No comment with this id.", "Use list_comments to find the reply.");
      return { data: { ok: true, summary: "The reply was sent to the Telegram group.", reply: { id: sent.id, postId: sent.postId } } };
    } catch (error) {
      if (error instanceof TelegramReplyError) throw new ToolError(error.status === 409 ? "conflict" : "internal_error", error.message);
      throw error;
    }
  },
});

// --------------------------------------------------------------------------- xodimlar (staff:manage)

const SENSITIVE_NOTE = "SENSITIVE: the invite link is a credential - whoever opens it can become a staff member. Show it only to the owner, pass it only to the intended person, and do not store or repeat it. It is not kept by the server in any readable form and cannot be shown again; revoke the invite if it may have leaked.";

export const createStaffInviteTool = defineTool({
  name: "create_staff_invite",
  title: "Create a staff invite link",
  description:
    "Create a single-use staff invite (valid 7 days) and return its link. The link is a credential: the result marks it as sensitive. It is shown once and cannot be listed again. The audit log records only the invite id. idempotency_key makes a retry return the invite WITHOUT the link (create a new one if you lost it). Revoke with revoke_staff_invite.",
  scope: "staff:manage",
  limit: "create",
  inputSchema: { note: z.string().trim().max(200).optional().describe("Who the invite is for (shown in the panel)."), idempotency_key: idempotencyKeyField },
  annotations: ADDITIVE,
  kind: "write",
  async handler(args, ctx) {
    return withIdempotency(
      ctx,
      "create_staff_invite",
      args.idempotency_key,
      args,
      async () => {
        const created = await createStaffInviteAudited(ctx.actor, ctx.user.id, args.note?.trim() || null);
        return { data: { ok: true, summary: "Staff invite created. The link below is shown only now.", sensitive: true, sensitiveNote: SENSITIVE_NOTE, invite: { id: created.invite.id, note: created.invite.note, expiresAt: created.invite.expiresAt }, inviteUrl: created.url, ...untrusted(["invite.note"]) } };
      },
      (data) => {
        const { inviteUrl: _link, sensitive: _s, sensitiveNote: _n, ...rest } = data;
        void _link;
        void _s;
        void _n;
        return { ...rest, summary: "Staff invite was created earlier. The link was shown once and is not stored.", linkOmitted: true };
      },
    );
  },
});

export const revokeStaffInviteTool = defineTool({
  name: "revoke_staff_invite",
  title: "Revoke a staff invite",
  description: "Revoke an unused staff invite (id from list_staff) so its link stops working. Already used or revoked invites are refused.",
  scope: "staff:manage",
  limit: "destructive",
  inputSchema: { invite_id: uuidField("invite id from list_staff") },
  annotations: DESTRUCTIVE,
  kind: "write",
  async handler(args, ctx) {
    await unwrapSvc(await revokeStaffInviteAudited(ctx.actor, args.invite_id), "Use list_staff to see the invites.");
    return { data: { ok: true, summary: "The invite was revoked." } };
  },
});

export const removeStaffMemberTool = defineTool({
  name: "remove_staff_member",
  title: "Remove a staff member",
  description: "Remove a staff member's role (user id from list_staff): they become an ordinary user and are signed out everywhere. Their posts stay. They can be invited again with a new invite. Only staff can be removed - never an admin.",
  scope: "staff:manage",
  limit: "destructive",
  inputSchema: { user_id: z.string().min(1).max(100).describe("Staff user id from list_staff.") },
  annotations: DESTRUCTIVE,
  kind: "write",
  async handler(args, ctx) {
    await unwrapSvc(await removeStaffMemberAudited(ctx.actor, args.user_id), "Use list_staff to find a valid staff id.");
    return { data: { ok: true, summary: "The staff role was removed and their sessions were ended." } };
  },
});

// --------------------------------------------------------------------------- sozlamalar (settings:manage)

export const updateSiteSettingsTool = defineTool({
  name: "update_site_settings",
  title: "Update general site settings",
  description:
    "Change non-secret site settings (only the fields you pass): site name and description, social links (null clears one), default settings for new posts, Telegram comment display options. The public site changes immediately. dry_run=true reports the result without saving. Integration keys, tokens and passwords cannot be read or changed here.",
  scope: "settings:manage",
  limit: "edit",
  inputSchema: {
    site_name: z.string().trim().min(1).max(100).optional(),
    site_description: z.string().trim().max(300).optional(),
    social: SocialLinksSchema.partial().strict().optional().describe("Social links: telegram, github, x, email (null clears)."),
    default_post_settings: PostSettingsSchema.partial().strict().optional().describe("Defaults for NEW posts (existing posts are unchanged)."),
    telegram_display: z.object({ notifyComments: z.boolean().optional(), digestEnabled: z.boolean().optional(), telegramDisplay: TelegramDisplayModeSchema.optional() }).strict().optional().describe("Telegram comment options."),
    dry_run: dryRunField,
  },
  annotations: OVERWRITES,
  kind: "write",
  async handler(args, ctx) {
    const general: { siteName?: string; siteDescription?: string } = {};
    if (args.site_name !== undefined) general.siteName = args.site_name;
    if (args.site_description !== undefined) general.siteDescription = args.site_description;
    const site = {
      ...(args.social ? { social: args.social } : {}),
      ...(args.default_post_settings ? { defaultPostSettings: args.default_post_settings } : {}),
      ...(args.telegram_display ? { telegram: args.telegram_display } : {}),
    };
    const sections = [...(Object.keys(general).length ? ["general"] : []), ...Object.keys(site)];
    if (sections.length === 0) throw new ToolError("invalid_input", "Nothing to change: pass site_name, site_description, social, default_post_settings or telegram_display.");
    if (args.dry_run) {
      const current = await loadSiteSettings();
      const g = (await getSettings()).general;
      return { data: { ok: true, dryRun: true, summary: `Dry run: would update ${sections.join(", ")}.`, wouldChange: sections, resulting: { general: { siteName: general.siteName ?? g.siteName, siteDescription: general.siteDescription ?? g.siteDescription }, social: { ...current.social, ...(args.social ?? {}) } }, ...untrusted(["resulting"]) } };
    }
    try {
      if (Object.keys(general).length) await saveSettingsAudited(ctx.actor, { general });
    } catch (error) {
      if (error instanceof SettingsValidationError) throw new ToolError("invalid_input", "The settings were rejected.", "Check the values.", { fields: error.fields });
      throw error;
    }
    if (Object.keys(site).length) await unwrapSvc(await updateSiteSettings(ctx.actor, site));
    return { data: { ok: true, summary: `Settings updated: ${sections.join(", ")}.`, changed: sections } };
  },
});

export const updateAboutPageTool = defineTool({
  name: "update_about_page",
  title: "Update the About page",
  description:
    U + "Replace the About page (/haqida) with content_markdown (## and ### headings, lists, links, own uploaded images) OR a structured content_document, both checked by the same strict validators as post content. The public page changes immediately. expected_etag (from get_about_page) is REQUIRED: if the page changed since, nothing is written. If the current page has parts Markdown cannot represent exactly, a Markdown overwrite needs acknowledge_lossy_overwrite=true. dry_run=true only validates.",
  scope: "settings:manage",
  limit: "edit",
  inputSchema: {
    expected_etag: z.string().min(8).max(64).describe("REQUIRED concurrency token from get_about_page."),
    content_markdown: z.string().max(CONTENT_MAX_CHARS + 1).optional(),
    content_document: z.object({ type: z.literal("doc"), content: z.array(z.record(z.string(), z.unknown())).max(5000) }).passthrough().optional(),
    acknowledge_lossy_overwrite: z.boolean().optional(),
    dry_run: dryRunField,
  },
  annotations: OVERWRITES,
  kind: "write",
  async handler(args, ctx) {
    if ((args.content_markdown === undefined) === (args.content_document === undefined)) throw new ToolError("invalid_input", "Pass exactly one of content_markdown or content_document.");
    const { about } = await loadSiteSettings();
    if (aboutEtag(about.json) !== args.expected_etag) {
      throw new ToolError("conflict", "The About page changed after you read it, so nothing was written.", "Call get_about_page again and merge your change.", { currentEtag: aboutEtag(about.json) });
    }
    let doc: ContentNode;
    if (args.content_markdown !== undefined) {
      const report = lossyReport(about.json);
      if (!report.lossless && !args.acknowledge_lossy_overwrite) {
        throw new ToolError("lossy_content", `Replacing the page from Markdown would lose or change ${report.lossyBlocks.length} block(s) that Markdown cannot represent exactly. Nothing was written.`, "Use content_document, or repeat with acknowledge_lossy_overwrite=true.", { lossyBlocks: report.lossyBlocks }, ["error.lossyBlocks[].preview"]);
      }
      doc = await documentFromMarkdown(args.content_markdown);
    } else {
      doc = await validatedDocument(args.content_document);
    }
    if (args.dry_run) return { data: { ok: true, dryRun: true, summary: "Dry run: the About page content is valid and would be saved." } };
    await unwrapSvc(await updateSiteSettings(ctx.actor, { about: { json: doc } }));
    return { data: { ok: true, summary: "The About page was updated.", etag: aboutEtag(doc) } };
  },
});

export const COVERAGE_WRITE_TOOLS: McpToolDef[] = [
  createChannelVersionTool,
  updateChannelVersionTool,
  deleteChannelVersionTool,
  setChannelChoiceTool,
  clearChannelChoiceTool,
  setChannelPlanTool,
  cancelChannelPlanTool,
  resyncChannelCaptionTool,
  refreshTelegraphMirrorTool,
  liftCommentBanTool,
  resendReplyToTelegramTool,
  createStaffInviteTool,
  revokeStaffInviteTool,
  removeStaffMemberTool,
  updateSiteSettingsTool,
  updateAboutPageTool,
] as unknown as McpToolDef[];

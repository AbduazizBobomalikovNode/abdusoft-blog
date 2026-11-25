import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  ChannelPreviewRequestSchema,
  ChannelSelectionSchema,
  ChannelSendRequestSchema,
  CreateChannelVersionBodySchema,
  CreatePostBodySchema,
  ExpectedUpdatedAtSchema,
  PublishPostBodySchema,
  RequestChangesBodySchema,
  SchedulePostBodySchema,
  SetChannelChoiceBodySchema,
  TrashListQuerySchema,
  UpdateChannelVersionBodySchema,
  UpdatePostBodySchema,
  type PublishChannelSendResult,
} from "@blog/shared";
import { requireRole } from "../lib/require-admin.js";
import {
  actorFromAdminUser,
  approvePost,
  archivePost,
  authorizeEdit,
  createPost,
  findPost,
  getPostDetail,
  getRevision,
  listRevisions,
  restoreRevision,
  listPosts,
  listTrash,
  purgePost,
  restoreFromTrash,
  trashPost,
  mineSummary,
  previewPost,
  publishPost,
  requestPostChanges,
  requireAdminActor,
  schedulePost,
  submitPostForReview,
  unpublishPost,
  updatePost,
  type Actor,
  type PostRow,
} from "../lib/posts/index.js";
import {
  computeChannelVersionPost,
  computeChannelPost,
  editChannelCaptionForPost,
  getChannelAlreadySent,
  sendPostToChannel,
  sendVersionToChannel,
  type SendChannelPostResult,
} from "../telegram/channel-send.js";
import { computeChannelPreflight, summarizePreflightErrors } from "../telegram/channel-preflight.js";
import { getChannelInfo } from "../telegram/channel-info.js";
import {
  clearChannelChoice,
  parseStoredChoice,
  resolveChannelChoice,
  setChannelChoice,
} from "../telegram/channel-choice.js";
import { sendMarkedChoiceNow } from "../telegram/channel-plan.js";
import {
  createChannelVersion,
  deleteChannelVersion,
  listChannelVersions,
  updateChannelVersion,
} from "../telegram/channel-version-service.js";
import { getTelegramRefForPost, refreshTelegraphMirror } from "../telegram/publish.js";
import { recordAuditSafe } from "../lib/audit.js";
import { errorResponse } from "./service-response.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function actorOf(c: Context): Actor {
  return actorFromAdminUser(c.get("adminUser"), "web");
}

/**
 * Holat o'tishlarining ixtiyoriy `expectedUpdatedAt`i (tana yoki — DELETE uchun — query). Tana yo'q/boshqa shaklda
 * bo'lsa e'tiborsiz qoldiriladi (eski mijozlar o'zgarmaydi); faqat BERILGAN lekin noto'g'ri qiymat `400`.
 */
async function readExpectedUpdatedAt(c: Context): Promise<{ expectedUpdatedAt?: string } | { response: Response }> {
  const raw = await c.req.json().catch(() => null);
  const fromBody =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).expectedUpdatedAt
      : undefined;
  const candidate = fromBody ?? c.req.query("expectedUpdatedAt");
  if (candidate === undefined || candidate === null) return {};
  const parsed = ExpectedUpdatedAtSchema.safeParse(candidate);
  if (!parsed.success) return { response: c.json({ error: "Noto'g'ri so'rov tanasi" }, 400) };
  return { expectedUpdatedAt: parsed.data };
}

/** Kanal endpoint'lari uchun post qidiruvi (404 tekshiruvi chaqiruvchida). */
function loadPostOr404(id: string) {
  return findPost(id);
}


/**
 * Hono'ning fluent (zanjirlangan) marshrut tur chiqarishini buzmaslik uchun
 * (middleware'ni `.post(path, middleware, handler)` ko'rinishida uchinchi
 * argument sifatida berish `c.req.param()` turini `string | undefined`ga
 * kengaytirib yuborardi) — admin-only tekshiruvi alohida middleware EMAS,
 * handler ICHIDA chaqiriladigan oddiy tekshiruv sifatida amalga oshiriladi.
 */
function forbidUnlessAdmin(c: Context): Response | null {
  const adminUser = c.get("adminUser");
  if (adminUser.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }
  return null;
}

/**
 * Kanal versiyalarini TAYYORLASH (ro'yxat/yaratish/tahrirlash/o'chirish, ko'rinish, preflight, belgi)
 * ruxsati: admin — doim; xodim — FAQAT o'z posti uchun, yozish amallari esa faqat `draft`/`changes_requested`
 * holatida (`in_review`da versiyalar xodim uchun faqat o'qish). Kanalga YUBORISH bu yerda hech qachon xodimga ochilmaydi.
 */
function guardChannelPrep(c: Context, post: PostRow, access: "read" | "write"): Response | null {
  const me = c.get("adminUser");
  if (me.role === "admin") return null;
  if (post.createdBy !== me.id) {
    return c.json({ error: "Faqat o'z postlaringiz uchun kanal versiyasini tayyorlay olasiz" }, 403);
  }
  if (access === "write" && post.status !== "draft" && post.status !== "changes_requested") {
    return c.json({ error: "Post ko'rib chiqishda yoki chop etilgan — kanal versiyalari hozir faqat o'qish uchun" }, 409);
  }
  return null;
}

const STATUS_VALUES = [
  "all",
  "draft",
  "in_review",
  "changes_requested",
  "scheduled",
  "published",
  "archived",
] as const;

const ListQuerySchema = z.object({
  status: z.enum(STATUS_VALUES).default("all"),
  q: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).default(DEFAULT_LIMIT),
});



function toLifecycleSummary(post: PostRow) {
  return {
    id: post.id,
    slug: post.slug,
    status: post.status,
    publishedAt: post.publishedAt?.toISOString() ?? null,
    scheduledAt: post.scheduledAt?.toISOString() ?? null,
    pinned: post.pinned,
    updatedAt: post.updatedAt.toISOString(),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `sendPostToChannel`/`sendVersionToChannel` xatosini HTTP javobiga aylantiradi. */
function sendFailureResponse(c: Context, result: Extract<SendChannelPostResult, { ok: false }>): Response {
  switch (result.reason) {
    case "not_found":
      return c.json({ error: "Topilmadi" }, 404);
    case "version_not_found":
      return c.json({ error: "Versiya topilmadi" }, 404);
    case "not_published":
      return c.json({ error: "Faqat chop etilgan post kanalga yuboriladi" }, 409);
    case "telegram_disabled":
      return c.json({ error: "Telegram bot yoki kanal sozlanmagan" }, 409);
    case "invalid_combo":
      return c.json({ error: "Bu uzunlik ushbu rejim uchun mos emas" }, 400);
    case "no_media":
      return c.json({ error: "🖼 Rasmli rejim uchun postda kover yoki band ichida rasm bo'lishi kerak" }, 400);
    case "preflight_failed":
      return c.json(
        {
          error: `Telegram cheklovlari bajarilmagan: ${result.preflight ? summarizePreflightErrors(result.preflight) : ""}`,
          preflight: result.preflight,
        },
        422,
      );
    default:
      return c.json({ error: "Post allaqachon kanalga yuborilgan — replaceExisting bilan qayta yuboring" }, 409);
  }
}


const CHANNEL_SEND_WAIT_MS = 20_000;

/** `publish`/`approve` ixtiyoriy tanasi: `sendToChannel: true` bo'lsa postda belgilangan versiya bo'lishi shart (aks holda 400). */
async function parsePublishBody(
  c: Context,
  postId: string,
): Promise<{ sendToChannel: boolean; expectedUpdatedAt?: string } | { response: Response }> {
  const raw = await c.req.json().catch(() => ({}));
  const parsed = PublishPostBodySchema.safeParse(raw ?? {});
  if (!parsed.success) return { response: c.json({ error: "Noto'g'ri so'rov tanasi" }, 400) };
  const expectedUpdatedAt = parsed.data.expectedUpdatedAt;
  if (!parsed.data.sendToChannel) return { sendToChannel: false, expectedUpdatedAt };
  const post = await loadPostOr404(postId);
  if (post && !parseStoredChoice(post.channelChoice)) {
    return { response: c.json({ error: "Postda belgilangan kanal versiyasi yo'q" }, 400) };
  }
  return { sendToChannel: true, expectedUpdatedAt };
}

/** Rejani (kechikishsiz) qo'yib, Telegraph'dan keyin yuboradi; natija HTTP javobiga (toast) qo'shiladi. Uzoq cho'zilsa — fonda davom etadi (admin chatga xabar boradi). */
async function queueChannelSend(postId: string): Promise<PublishChannelSendResult> {
  const work = sendMarkedChoiceNow(postId).then(
    (outcome): PublishChannelSendResult => {
      if (outcome.state === "sent") return { state: "sent", messageUrl: outcome.messageUrl, error: null };
      if (outcome.state === "failed") {
        return {
          state: "failed",
          messageUrl: null,
          error: outcome.willRetry ? `${outcome.reason} (keyinroq qayta uriniladi)` : outcome.reason,
        };
      }
      return { state: "failed", messageUrl: null, error: "Kanalga yuborilmadi (allaqachon yuborilgan bo'lishi mumkin)" };
    },
    (error: unknown): PublishChannelSendResult => ({
      state: "failed",
      messageUrl: null,
      error: error instanceof Error ? error.message : "Noma'lum xato",
    }),
  );
  const timeout = new Promise<PublishChannelSendResult>((resolve) => {
    setTimeout(() => resolve({ state: "pending", messageUrl: null, error: null }), CHANNEL_SEND_WAIT_MS).unref?.();
  });
  return Promise.race([work, timeout]);
}


export const adminPostsRoute = new Hono()
  .use("*", requireRole("admin", "staff"))
  .get("/mine/summary", async (c) => c.json(await mineSummary(actorOf(c))))
  // Chiqindi qutisi (faqat admin): `/trash` marshrutlari `/:id`dan OLDIN ro'yxatga olinadi.
  .get("/trash", async (c) => {
    const parsed = TrashListQuerySchema.safeParse({ page: c.req.query("page"), limit: c.req.query("limit") });
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov parametrlari" }, 400);
    const result = await listTrash(actorOf(c), parsed.data);
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(result.data);
  })
  .post("/trash/:id/restore", async (c) => {
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "Topilmadi" }, 404);
    const actor = actorOf(c);
    const denied = requireAdminActor(actor);
    if (denied) return errorResponse(c, denied.error);
    const expected = await readExpectedUpdatedAt(c);
    if ("response" in expected) return expected.response;
    const result = await restoreFromTrash(actor, id, expected);
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(result.data);
  })
  .delete("/trash/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "Topilmadi" }, 404);
    const actor = actorOf(c);
    const denied = requireAdminActor(actor);
    if (denied) return errorResponse(c, denied.error);
    const expected = await readExpectedUpdatedAt(c);
    if ("response" in expected) return expected.response;
    const result = await purgePost(actor, id, expected);
    if (!result.ok) return errorResponse(c, result.error);
    return c.json({ ok: true });
  })
  .get("/", async (c) => {
    const parsed = ListQuerySchema.safeParse({
      status: c.req.query("status") ?? undefined,
      q: c.req.query("q"),
      page: c.req.query("page"),
      limit: c.req.query("limit"),
    });

    if (!parsed.success) {
      return c.json({ error: "Noto'g'ri so'rov parametrlari" }, 400);
    }

    return c.json(await listPosts(actorOf(c), parsed.data));
  })
  .post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreatePostBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);
    }

    const result = await createPost(actorOf(c), { title: parsed.data.title });
    if (!result.ok) return c.json({ error: result.error.message }, 500);
    return c.json(result.data, 201);
  })
  .get("/:id", async (c) => {
    const result = await getPostDetail(actorOf(c), c.req.param("id"));
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(result.data);
  })
  .post("/:id/telegram/telegraph", async (c) => {
    const forbidden = forbidUnlessAdmin(c);
    if (forbidden) return forbidden;
    const id = c.req.param("id");
    const post = await loadPostOr404(id);
    if (!post) return c.json({ error: "Topilmadi" }, 404);
    if (post.status !== "published") {
      return c.json({ error: "Faqat chop etilgan post uchun Telegraph mirror yaratiladi" }, 409);
    }

    await refreshTelegraphMirror(id);
    const ref = await getTelegramRefForPost(id);
    return c.json({ telegraphUrl: ref?.telegraphUrl ?? null });
  })
  .post("/:id/channel/preview", async (c) => {
    const id = c.req.param("id");
    const prepPost = await loadPostOr404(id);
    if (!prepPost) return c.json({ error: "Topilmadi" }, 404);
    const forbidden = guardChannelPrep(c, prepPost, "read");
    if (forbidden) return forbidden;
    const body = await c.req.json().catch(() => null);
    const parsed = ChannelPreviewRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "mode va variant (yoki versionId) majburiy (mode: media|text)" }, 400);

    // Rejalashtirish paytida post hali chop etilmagan bo'ladi — ko'rinish baribir quriladi.
    const computed =
      "versionId" in parsed.data
        ? // Maxsus versiyada rasmlar olib tashlangan bo'lishi mumkin (tahrirlash jarayoni) — ko'rinish quriladi, preflight o'zi xato ko'rsatadi.
          await computeChannelVersionPost(id, parsed.data.versionId, { allowUnpublished: true, allowEmptyMedia: true })
        : await computeChannelPost(id, parsed.data.mode, parsed.data.variant, { allowUnpublished: true });
    if (!computed.ok) {
      if (computed.reason === "not_found") return c.json({ error: "Topilmadi" }, 404);
      if (computed.reason === "version_not_found") return c.json({ error: "Versiya topilmadi" }, 404);
      if (computed.reason === "not_published") {
        return c.json({ error: "Faqat chop etilgan post uchun kanal ko'rinishi tayyorlanadi" }, 409);
      }
      if (computed.reason === "invalid_combo") {
        return c.json({ error: "Bu uzunlik ushbu rejim uchun mos emas" }, 400);
      }
      // no_media
      return c.json({ error: "🖼 Rasmli rejim uchun postda kover yoki band ichida rasm bo'lishi kerak" }, 400);
    }

    const [alreadySent, channel] = await Promise.all([getChannelAlreadySent(id), getChannelInfo()]);

    return c.json({
      mode: computed.data.mode,
      variant: computed.data.variant,
      versionId: computed.data.versionId,
      captionHtml: computed.data.captionHtml,
      visibleLength: computed.data.visibleLength,
      limit: computed.data.limit,
      truncated: computed.data.truncated,
      media: computed.data.media,
      alreadySent,
      channel,
    });
  })
  .post("/:id/channel/preflight", async (c) => {
    const id = c.req.param("id");
    const prepPost = await loadPostOr404(id);
    if (!prepPost) return c.json({ error: "Topilmadi" }, 404);
    const forbidden = guardChannelPrep(c, prepPost, "read");
    if (forbidden) return forbidden;
    const body = await c.req.json().catch(() => null);
    const parsed = ChannelSelectionSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "mode va variant (yoki versionId) majburiy" }, 400);

    // `forPlan: true` — rejalashtirish tekshiruvi: post chop etilgan bo'lishi shart emas, avtomatik rejada rasm yo'qligi ogohlantirish.
    const forPlan = (body as { forPlan?: unknown } | null)?.forPlan === true;
    const result = await computeChannelPreflight(id, parsed.data, {
      requirePublished: !forPlan,
      planFallback: forPlan && !("versionId" in parsed.data),
    });
    if (!result.ok) {
      if (result.reason === "not_found") return c.json({ error: "Topilmadi" }, 404);
      if (result.reason === "version_not_found") return c.json({ error: "Versiya topilmadi" }, 404);
      return c.json({ error: "Bu uzunlik ushbu rejim uchun mos emas" }, 400);
    }
    return c.json(result.preflight);
  })
  .get("/:id/channel/versions", async (c) => {
    const post = await loadPostOr404(c.req.param("id"));
    if (!post) return c.json({ error: "Topilmadi" }, 404);
    const forbidden = guardChannelPrep(c, post, "read");
    if (forbidden) return forbidden;
    return c.json(await listChannelVersions(post));
  })
  .post("/:id/channel/versions", async (c) => {
    const post = await loadPostOr404(c.req.param("id"));
    if (!post) return c.json({ error: "Topilmadi" }, 404);
    const forbidden = guardChannelPrep(c, post, "write");
    if (forbidden) return forbidden;
    const body = await c.req.json().catch(() => null);
    const parsed = CreateChannelVersionBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi", issues: parsed.error.issues }, 400);
    const result = await createChannelVersion(post, parsed.data, c.get("adminUser").id);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    await recordAuditSafe(actorOf(c), {
      action: "post.channel_version_create",
      entityType: "post",
      entityId: post.id,
      summary: "Kanal versiyasi yaratildi",
    });
    return c.json(result.data, 201);
  })
  .patch("/:id/channel/versions/:vid", async (c) => {
    const vid = c.req.param("vid");
    if (!UUID_RE.test(vid)) return c.json({ error: "Versiya topilmadi" }, 404);
    const post = await loadPostOr404(c.req.param("id"));
    if (!post) return c.json({ error: "Topilmadi" }, 404);
    const forbidden = guardChannelPrep(c, post, "write");
    if (forbidden) return forbidden;
    const body = await c.req.json().catch(() => null);
    const parsed = UpdateChannelVersionBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi", issues: parsed.error.issues }, 400);
    const result = await updateChannelVersion(post, vid, parsed.data);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    await recordAuditSafe(actorOf(c), {
      action: "post.channel_version_update",
      entityType: "post",
      entityId: post.id,
      summary: "Kanal versiyasi tahrirlandi",
      meta: { versionId: vid },
    });
    return c.json(result.data);
  })
  .delete("/:id/channel/versions/:vid", async (c) => {
    const vid = c.req.param("vid");
    if (!UUID_RE.test(vid)) return c.json({ error: "Versiya topilmadi" }, 404);
    const post = await loadPostOr404(c.req.param("id"));
    if (!post) return c.json({ error: "Topilmadi" }, 404);
    const forbidden = guardChannelPrep(c, post, "write");
    if (forbidden) return forbidden;
    const result = await deleteChannelVersion(post, vid);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    await recordAuditSafe(actorOf(c), {
      action: "post.channel_version_delete",
      entityType: "post",
      entityId: post.id,
      summary: "Kanal versiyasi o'chirildi",
      meta: { versionId: vid, clearedChoice: result.data.clearedChoice },
    });
    return c.json({ ok: true, clearedChoice: result.data.clearedChoice });
  })
  .put("/:id/channel/choice", async (c) => {
    const post = await loadPostOr404(c.req.param("id"));
    if (!post) return c.json({ error: "Topilmadi" }, 404);
    const forbidden = guardChannelPrep(c, post, "write");
    if (forbidden) return forbidden;
    const body = await c.req.json().catch(() => null);
    const parsed = SetChannelChoiceBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Noto'g'ri tanlov", issues: parsed.error.issues }, 400);
    const result = await setChannelChoice(post.id, parsed.data, c.get("adminUser").id);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    await recordAuditSafe(actorOf(c), {
      action: "post.channel_choice_set",
      entityType: "post",
      entityId: post.id,
      summary: "Kanal versiyasi belgilandi",
    });
    const fresh = await loadPostOr404(post.id);
    return c.json({ choice: fresh ? await resolveChannelChoice(fresh) : null });
  })
  .delete("/:id/channel/choice", async (c) => {
    const post = await loadPostOr404(c.req.param("id"));
    if (!post) return c.json({ error: "Topilmadi" }, 404);
    const forbidden = guardChannelPrep(c, post, "write");
    if (forbidden) return forbidden;
    await clearChannelChoice(post.id);
    await recordAuditSafe(actorOf(c), {
      action: "post.channel_choice_clear",
      entityType: "post",
      entityId: post.id,
      summary: "Kanal versiyasi belgisi olib tashlandi",
    });
    return c.json({ ok: true });
  })
  .post("/:id/channel/send", async (c) => {
    const forbidden = forbidUnlessAdmin(c);
    if (forbidden) return forbidden;
    const id = c.req.param("id");
    const post = await loadPostOr404(id);
    if (!post) return c.json({ error: "Topilmadi" }, 404);
    if (post.status !== "published") {
      return c.json({ error: "Faqat chop etilgan post kanalga yuboriladi" }, 409);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = ChannelSendRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "mode va variant (yoki versionId) majburiy (mode: media|text)" }, 400);

    // Preflight `sendPostToChannel`/`sendVersionToChannel` ichida server tomonida ishlaydi — o'tmasa 422 va HECH NARSA yuborilmaydi.
    const result =
      "versionId" in parsed.data
        ? await sendVersionToChannel(id, parsed.data.versionId, { replaceExisting: parsed.data.replaceExisting })
        : await sendPostToChannel(id, parsed.data.mode, parsed.data.variant, {
            replaceExisting: parsed.data.replaceExisting,
          });

    if (!result.ok) return sendFailureResponse(c, result);
    await recordAuditSafe(actorOf(c), {
      action: parsed.data.replaceExisting ? "post.channel_replace" : "post.channel_send",
      entityType: "post",
      entityId: id,
      summary: parsed.data.replaceExisting ? "Post kanalga qayta yuborildi (almashtirildi)" : "Post kanalga yuborildi",
      meta:
        "versionId" in parsed.data
          ? { versionId: parsed.data.versionId, replaceExisting: Boolean(parsed.data.replaceExisting) }
          : { mode: parsed.data.mode, variant: parsed.data.variant, replaceExisting: Boolean(parsed.data.replaceExisting) },
    });
    return c.json(result);
  })
  .post("/:id/channel/resync-caption", async (c) => {
    const forbidden = forbidUnlessAdmin(c);
    if (forbidden) return forbidden;
    const id = c.req.param("id");
    const post = await loadPostOr404(id);
    if (!post) return c.json({ error: "Topilmadi" }, 404);

    // Post hali kanalga yuborilmagan bo'lsa — jimgina hech narsa qilmaydi
    // (`editChannelCaptionForPost` ichida tekshiriladi), shu sabab bu yerda
    // 409 tashlamaymiz: tugma faqat "allaqachon yuborilgan" holatda ko'rinadi.
    await editChannelCaptionForPost(id);
    await recordAuditSafe(actorOf(c), {
      action: "post.channel_resync",
      entityType: "post",
      entityId: id,
      summary: "Kanal xabari matni yangilandi",
    });
    return c.json({ ok: true });
  })
  .get("/:id/preview", async (c) => {
    const result = await previewPost(actorOf(c), c.req.param("id"));
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(result.data);
  })
  .get("/:id/revisions", async (c) => {
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "Topilmadi" }, 404);
    const result = await listRevisions(actorOf(c), id);
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(result.data);
  })
  .get("/:id/revisions/:rid", async (c) => {
    const id = c.req.param("id");
    const rid = c.req.param("rid");
    if (!UUID_RE.test(id)) return c.json({ error: "Topilmadi" }, 404);
    if (!UUID_RE.test(rid)) return c.json({ error: "Revision topilmadi" }, 404);
    const result = await getRevision(actorOf(c), id, rid);
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(result.data);
  })
  .post("/:id/revisions/:rid/restore", async (c) => {
    const id = c.req.param("id");
    const rid = c.req.param("rid");
    if (!UUID_RE.test(id)) return c.json({ error: "Topilmadi" }, 404);
    if (!UUID_RE.test(rid)) return c.json({ error: "Revision topilmadi" }, 404);
    const expected = await readExpectedUpdatedAt(c);
    if ("response" in expected) return expected.response;
    const rawBody = await c.req.json().catch(() => null);
    const restoreSlug =
      rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
        ? (rawBody as Record<string, unknown>).restoreSlug
        : undefined;
    if (restoreSlug !== undefined && typeof restoreSlug !== "boolean") {
      return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);
    }
    const result = await restoreRevision(actorOf(c), id, rid, { ...expected, restoreSlug });
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(result.data);
  })
  .patch("/:id", async (c) => {
    const actor = actorOf(c);
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const parsed = UpdatePostBodySchema.safeParse(body);
    if (!parsed.success) {
      // Eski tartib: avval 404/403/409, keyin 400.
      const access = await authorizeEdit(actor, id);
      if (!access.ok) return errorResponse(c, access.error);
      // `issues` — debug uchun: qaysi maydon nega rad etilganini ko'rsatadi
      // (masalan avtosaqlash bo'sh `slug` yuborsa, `zod` xatosi shu yerda ko'rinadi).
      return c.json({ error: "Noto'g'ri so'rov tanasi", issues: parsed.error.issues }, 400);
    }

    // `snapshot` — maydon emas, parametr: xodim cheklovi va jurnal "maydonlar" ro'yxatiga kirmaydi.
    const { snapshot, ...fields } = parsed.data;
    const result = await updatePost(actor, id, fields, snapshot ? { forceSnapshot: true } : {});
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(result.data);
  })
  .post("/:id/submit", async (c) => {
    const expected = await readExpectedUpdatedAt(c);
    if ("response" in expected) return expected.response;
    const result = await submitPostForReview(actorOf(c), c.req.param("id"), expected);
    if (!result.ok) return errorResponse(c, result.error);
    return c.json({
      id: result.data.id,
      status: result.data.status,
      submittedAt: result.data.submittedAt?.toISOString() ?? null,
      updatedAt: result.data.updatedAt.toISOString(),
    });
  })
  .post("/:id/approve", async (c) => {
    const actor = actorOf(c);
    const denied = requireAdminActor(actor);
    if (denied) return errorResponse(c, denied.error);
    const id = c.req.param("id");
    const wants = await parsePublishBody(c, id);
    if ("response" in wants) return wants.response;
    const result = await approvePost(actor, id, { expectedUpdatedAt: wants.expectedUpdatedAt });
    if (!result.ok) return errorResponse(c, result.error);

    const channelSend = wants.sendToChannel ? await queueChannelSend(id) : undefined;
    return c.json({ ...toLifecycleSummary(result.data), ...(channelSend ? { channelSend } : {}) });
  })
  .post("/:id/request-changes", async (c) => {
    const actor = actorOf(c);
    const denied = requireAdminActor(actor);
    if (denied) return errorResponse(c, denied.error);
    const body = await c.req.json().catch(() => null);
    const parsed = RequestChangesBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Izoh (note) majburiy" }, 400);

    const result = await requestPostChanges(actor, c.req.param("id"), parsed.data.note, {
      expectedUpdatedAt: parsed.data.expectedUpdatedAt,
    });
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(result.data);
  })
  .post("/:id/publish", async (c) => {
    const actor = actorOf(c);
    const denied = requireAdminActor(actor);
    if (denied) return errorResponse(c, denied.error);
    const id = c.req.param("id");
    const post = await loadPostOr404(id);
    if (!post) return c.json({ error: "Topilmadi" }, 404);
    const wants = await parsePublishBody(c, id);
    if ("response" in wants) return wants.response;

    const result = await publishPost(actor, id, { expectedUpdatedAt: wants.expectedUpdatedAt });
    if (!result.ok) return errorResponse(c, result.error);

    // Belgilangan versiyani Telegraph ko'zgusidan KEYIN yuborish (ixtiyoriy; standart — qo'lda yuborish).
    const channelSend = wants.sendToChannel ? await queueChannelSend(id) : undefined;
    return c.json({ ...result.data, ...(channelSend ? { channelSend } : {}) });
  })
  .post("/:id/unpublish", async (c) => {
    const actor = actorOf(c);
    const denied = requireAdminActor(actor);
    if (denied) return errorResponse(c, denied.error);
    const expected = await readExpectedUpdatedAt(c);
    if ("response" in expected) return expected.response;
    const result = await unpublishPost(actor, c.req.param("id"), expected);
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(result.data);
  })
  .post("/:id/archive", async (c) => {
    const actor = actorOf(c);
    const denied = requireAdminActor(actor);
    if (denied) return errorResponse(c, denied.error);
    const expected = await readExpectedUpdatedAt(c);
    if ("response" in expected) return expected.response;
    const result = await archivePost(actor, c.req.param("id"), expected);
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(result.data);
  })
  .post("/:id/schedule", async (c) => {
    const actor = actorOf(c);
    const denied = requireAdminActor(actor);
    if (denied) return errorResponse(c, denied.error);
    const id = c.req.param("id");
    const post = await loadPostOr404(id);
    if (!post) return c.json({ error: "Topilmadi" }, 404);

    const body = await c.req.json().catch(() => null);
    const parsed = SchedulePostBodySchema.safeParse(body);
    if (!parsed.success) {
      const planInvalid = parsed.error.issues.some((issue) => issue.path[0] === "channelPlan");
      return c.json(
        { error: planInvalid ? "Noto'g'ri kanal rejasi" : "scheduledAt majburiy", issues: parsed.error.issues },
        400,
      );
    }

    const result = await schedulePost(actor, id, parsed.data);
    if (!result.ok) return errorResponse(c, result.error);
    return c.json(result.data);
  })
  .delete("/:id", async (c) => {
    // Eski nom saqlangan, lekin endi post chiqindi qutisiga ko'chadi (qaytarish mumkin).
    const actor = actorOf(c);
    const denied = requireAdminActor(actor);
    if (denied) return errorResponse(c, denied.error);
    const expected = await readExpectedUpdatedAt(c);
    if ("response" in expected) return expected.response;
    const result = await trashPost(actor, c.req.param("id"), expected);
    if (!result.ok) return errorResponse(c, result.error);
    return c.json({ ok: true });
  });

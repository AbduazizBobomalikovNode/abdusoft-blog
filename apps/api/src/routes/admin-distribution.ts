import { Hono, type Context } from "hono";
import { z } from "zod";
import { DISTRIBUTION_IMAGE_CHOICES, DISTRIBUTION_PROVIDERS } from "@blog/shared";
import { config } from "../config.js";
import { requireAdmin } from "../lib/require-admin.js";
import { actorFromAdminUser, type Actor, type ServiceResult } from "../lib/posts/types.js";
import { recordAuditSafe } from "../lib/audit.js";
import { CALLBACK_REASON_TEXT, completeConnect, connectWithPastedToken, disconnectAccount, startConnect } from "../lib/distribution/service/accounts.js";
import { cancel, getDistributionDto, listPostDistributions, removeFromPlatform, resolveNeedsChecking, retry, saveDraft, schedule, sendNow, type DraftInput, type QueueInput } from "../lib/distribution/service/actions.js";
import { listChannels } from "../lib/distribution/service/channels.js";
import { CredentialsValidationError, saveCredentials } from "../lib/distribution/service/credentials.js";
import { isProviderId } from "../lib/distribution/service/env.js";
import { buildPreview } from "../lib/distribution/service/prepare.js";
import { buildSettingsView } from "../lib/distribution/service/settings-view.js";
import type { ProviderId } from "../lib/distribution/types.js";
import { errorResponse } from "./service-response.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ImageChoice = z.enum(DISTRIBUTION_IMAGE_CHOICES as unknown as [string, ...string[]]);
const DraftBody = z
  .object({
    text: z.string().max(20_000).nullable().optional(),
    imageChoice: ImageChoice.optional(),
    linkMode: z.enum(["article", "text"]).nullable().optional(),
  })
  .strict();
const SendBody = DraftBody.extend({ again: z.boolean().optional() }).strict();
const ScheduleBody = SendBody.extend({ scheduledAt: z.string().min(10).max(40) }).strict();
const ResolveBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("mark_sent"), url: z.string().min(8).max(2000), externalId: z.string().max(200).optional() }).strict(),
  z.object({ action: z.literal("retry"), confirmDuplicateRisk: z.boolean() }).strict(),
  z.object({ action: z.literal("not_posted") }).strict(),
]);
const CredField = z.object({ clientId: z.string().max(500).optional(), clientSecret: z.string().max(2000).optional() }).strict();
const CredentialsBody = z.object({ linkedin: CredField.optional(), x: CredField.optional(), threads: CredField.optional(), instagram: CredField.optional() }).strict();
const TokenBody = z.object({ token: z.string().min(8).max(500) }).strict();

function actorOf(c: Context): Actor {
  return actorFromAdminUser(c.get("adminUser"));
}

function respond<T>(c: Context, result: ServiceResult<T>, status: 200 | 201 = 200) {
  if (!result.ok) return errorResponse(c, result.error);
  return c.json(result.data, status);
}

function providerParam(c: Context): ProviderId | null {
  const p = c.req.param("provider") ?? "";
  return isProviderId(p) && (DISTRIBUTION_PROVIDERS as readonly string[]).includes(p) ? p : null;
}

function webSettingsUrl(params: Record<string, string>): string {
  const u = new URL("/admin/sozlamalar", config.WEB_ORIGIN);
  u.searchParams.set("tab", "tarqatish");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * Ijtimoiy tarqatish marshrutlari (`DISTRIBUTION_ENABLED=true` bo'lgandagina ro'yxatga olinadi — `routes/admin.ts`).
 * Hammasi FAQAT admin (xodim 403). Hech narsa chop etilganda avtomatik yuborilmaydi: yuborish faqat shu aniq so'rovlar orqali.
 * Hech bir javobda token yoki client secret yo'q.
 */
export const adminDistributionRoute = new Hono()
  .use("*", requireAdmin)
  // --- Sozlamalar / akkauntlar ---
  .get("/settings", async (c) => c.json(await buildSettingsView()))
  .put("/settings", async (c) => {
    const parsed = CredentialsBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);
    try {
      await saveCredentials(parsed.data);
    } catch (error) {
      if (error instanceof CredentialsValidationError) return c.json({ error: error.message, fields: error.fields }, 400);
      throw error;
    }
    await recordAuditSafe(actorOf(c), { action: "distribution.credentials_update", entityType: "settings", entityId: "distribution", summary: "Tarqatish kanallari ilova kalitlari yangilandi", meta: { providers: Object.keys(parsed.data) } });
    return c.json(await buildSettingsView());
  })
  .post("/accounts/:provider/connect", async (c) => {
    const provider = providerParam(c);
    if (!provider) return c.json({ error: "Topilmadi" }, 404);
    return respond(c, await startConnect(actorOf(c), provider));
  })
  .post("/accounts/:provider/token", async (c) => {
    const provider = providerParam(c);
    if (!provider) return c.json({ error: "Topilmadi" }, 404);
    const parsed = TokenBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Token kiritilmagan yoki noto'g'ri" }, 400);
    return respond(c, await connectWithPastedToken(actorOf(c), provider, parsed.data.token));
  })
  .delete("/accounts/:provider", async (c) => {
    const provider = providerParam(c);
    if (!provider) return c.json({ error: "Topilmadi" }, 404);
    return respond(c, await disconnectAccount(actorOf(c), provider));
  })
  // Platforma ilovasida ro'yxatdan o'tkaziladigan callback (brauzer redirect): `${API_ORIGIN}/admin/distribution/callback/<provider>`.
  .get("/callback/:provider", async (c) => {
    const provider = providerParam(c);
    if (!provider) return c.json({ error: "Topilmadi" }, 404);
    const result = await completeConnect(actorOf(c), provider, { code: c.req.query("code"), state: c.req.query("state"), error: c.req.query("error") });
    if (result.ok) return c.redirect(webSettingsUrl({ dist: "connected", provider }), 302);
    return c.redirect(webSettingsUrl({ dist: "error", provider, reason: CALLBACK_REASON_TEXT[result.reason] }), 302);
  })
  // --- Kanallar va post bo'yicha tarqatishlar ---
  .get("/channels", async (c) => c.json({ channels: await listChannels(), autoPost: false }))
  .get("/posts/:postId", async (c) => {
    const postId = c.req.param("postId");
    if (!UUID_RE.test(postId)) return c.json({ error: "Topilmadi" }, 404);
    return respond(c, await listPostDistributions(postId));
  })
  .post("/posts/:postId/:provider/preview", async (c) => {
    const postId = c.req.param("postId");
    const provider = providerParam(c);
    if (!provider || !UUID_RE.test(postId)) return c.json({ error: "Topilmadi" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = DraftBody.safeParse(body ?? {});
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);
    const preview = await buildPreview(postId, provider, { overrides: parsed.data as DraftInput, live: c.req.query("live") === "1" });
    if (!preview) return c.json({ error: "Post topilmadi" }, 404);
    return c.json(preview);
  })
  .put("/posts/:postId/:provider/draft", async (c) => {
    const postId = c.req.param("postId");
    const provider = providerParam(c);
    if (!provider || !UUID_RE.test(postId)) return c.json({ error: "Topilmadi" }, 404);
    const parsed = DraftBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);
    return respond(c, await saveDraft(actorOf(c), postId, provider, parsed.data as DraftInput));
  })
  .post("/posts/:postId/:provider/send", async (c) => {
    const postId = c.req.param("postId");
    const provider = providerParam(c);
    if (!provider || !UUID_RE.test(postId)) return c.json({ error: "Topilmadi" }, 404);
    const parsed = SendBody.safeParse((await c.req.json().catch(() => ({}))) ?? {});
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);
    return respond(c, await sendNow(actorOf(c), postId, provider, parsed.data as QueueInput), 200);
  })
  .post("/posts/:postId/:provider/schedule", async (c) => {
    const postId = c.req.param("postId");
    const provider = providerParam(c);
    if (!provider || !UUID_RE.test(postId)) return c.json({ error: "Topilmadi" }, 404);
    const parsed = ScheduleBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi (scheduledAt majburiy)" }, 400);
    const { scheduledAt, ...rest } = parsed.data;
    return respond(c, await schedule(actorOf(c), postId, provider, new Date(scheduledAt), rest as QueueInput));
  })
  // --- Bitta tarqatish ---
  .get("/items/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "Topilmadi" }, 404);
    return respond(c, await getDistributionDto(id));
  })
  .post("/items/:id/cancel", async (c) => {
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "Topilmadi" }, 404);
    return respond(c, await cancel(actorOf(c), id));
  })
  .post("/items/:id/retry", async (c) => {
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "Topilmadi" }, 404);
    return respond(c, await retry(actorOf(c), id));
  })
  .post("/items/:id/resolve", async (c) => {
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "Topilmadi" }, 404);
    const parsed = ResolveBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Noto'g'ri so'rov tanasi" }, 400);
    return respond(c, await resolveNeedsChecking(actorOf(c), id, parsed.data));
  })
  .post("/items/:id/remove", async (c) => {
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) return c.json({ error: "Topilmadi" }, 404);
    return respond(c, await removeFromPlatform(actorOf(c), id));
  });

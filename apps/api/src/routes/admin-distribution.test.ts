import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { migrateTestDb } from "../test/migrate-test-db.js";
import { createTestUser, type TestUser } from "../test/auth-test-helpers.js";

vi.hoisted(() => {
  process.env.DISTRIBUTION_ENABLED = "true";
  process.env.API_ORIGIN = "https://api.example.test";
  process.env.WEB_ORIGIN = "https://blog.example.test";
  // Env qiymati DB'dan ustun: faqat X uchun env berilgan (qulflangan maydon sinovi).
  process.env.DISTRIBUTION_X_CLIENT_ID = "env-x-client-id";
  process.env.ADMIN_WRITE_RATE_LIMIT_MAX = "0";
});

let app: Hono;
let admin: TestUser;
let admin2: TestUser;
let staff: TestUser;
let db: typeof import("../db/index.js").db;
let s: typeof import("../db/schema.js");
let sup: typeof import("../lib/distribution/service/test-support.js");
let fx: typeof import("../lib/distribution/service/fixtures.js");
let env: typeof import("../lib/distribution/service/env.js");
let mock: ReturnType<typeof import("../lib/distribution/service/test-support.js").createPlatformMock>;
let nowMs = Date.parse("2026-11-26T10:00:00Z");

const LI_SECRET = "LI-CLIENT-SECRET-VALUE-123";

async function call(path: string, cookie: string | null, init: { method?: string; body?: unknown } = {}) {
  return app.request(`/admin/distribution${path}`, {
    method: init.method ?? "GET",
    headers: { ...(cookie ? { cookie } : {}), ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    redirect: "manual",
  });
}

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../app.js"));
  ({ db } = await import("../db/index.js"));
  s = await import("../db/schema.js");
  sup = await import("../lib/distribution/service/test-support.js");
  fx = await import("../lib/distribution/service/fixtures.js");
  env = await import("../lib/distribution/service/env.js");
  mock = sup.createPlatformMock();
  env.setDistributionFetch(mock.fetch);
  env.setDistributionClock(() => new Date(nowMs));
  const images = await import("../lib/distribution/service/images.js");
  images.setSocialImageLoader((url) => sup.fakePreparedImage(url));
  admin = await createTestUser({ role: "admin", name: "Admin" });
  admin2 = await createTestUser({ role: "admin", name: "Admin 2" });
  staff = await createTestUser({ role: "staff", name: "Staff" });
});

afterAll(() => {
  env.setDistributionFetch(null);
  env.setDistributionClock(null);
});

beforeEach(async () => {
  nowMs = Date.parse("2026-11-26T10:00:00Z");
  mock.reset();
  await fx.clearAll();
  await db.delete(s.siteSettings).where(eq(s.siteSettings.key, "settings:distribution"));
});

async function saveLinkedInCreds() {
  const res = await call("/settings", admin.cookie, { method: "PUT", body: { linkedin: { clientId: "li-client-id", clientSecret: LI_SECRET } } });
  expect(res.status).toBe(200);
  return res;
}

const stateOf = (url: string) => new URL(url).searchParams.get("state")!;

describe("access control", () => {
  const routes: Array<[string, string]> = [
    ["GET", "/settings"],
    ["PUT", "/settings"],
    ["POST", "/accounts/linkedin/connect"],
    ["POST", "/accounts/github/token"],
    ["DELETE", "/accounts/linkedin"],
    ["GET", "/callback/linkedin"],
    ["GET", "/channels"],
    ["GET", "/posts/00000000-0000-4000-8000-000000000000"],
    ["POST", "/posts/00000000-0000-4000-8000-000000000000/x/preview"],
    ["PUT", "/posts/00000000-0000-4000-8000-000000000000/x/draft"],
    ["POST", "/posts/00000000-0000-4000-8000-000000000000/x/send"],
    ["POST", "/posts/00000000-0000-4000-8000-000000000000/x/schedule"],
    ["POST", "/items/00000000-0000-4000-8000-000000000000/cancel"],
    ["POST", "/items/00000000-0000-4000-8000-000000000000/retry"],
    ["POST", "/items/00000000-0000-4000-8000-000000000000/resolve"],
    ["POST", "/items/00000000-0000-4000-8000-000000000000/remove"],
  ];
  it.each(routes)("%s %s: anonymous 401, staff 403", async (method, path) => {
    const body = method === "GET" || method === "DELETE" ? undefined : {};
    const anonymous = await call(path, null, { method, body });
    if (path.startsWith("/callback/")) {
      // INTENTIONAL CHANGE: the browser callback sends an expired/missing session to the web login (no raw JSON on the API origin).
      expect(anonymous.status).toBe(302);
      expect(anonymous.headers.get("location")).toBe("https://blog.example.test/login?notice=dist_session_expired");
    } else expect(anonymous.status).toBe(401);
    expect((await call(path, staff.cookie, { method, body })).status).toBe(403);
  });

  it("the expired-session redirect carries nothing from the callback (no code, no state) and consumes no state", async () => {
    await saveLinkedInCreds();
    const start = await call("/accounts/linkedin/connect", admin.cookie, { method: "POST" });
    const state = stateOf(((await start.json()) as { authorizationUrl: string }).authorizationUrl);
    const res = await call(`/callback/linkedin?code=SECRETCODE&state=${state}`, null);
    expect(res.status).toBe(302);
    const loc = res.headers.get("location")!;
    expect(loc).not.toContain("SECRETCODE");
    expect(loc).not.toContain(state);
    expect([...new URL(loc).searchParams.keys()]).toEqual(["notice"]);
    expect(await db.select().from(s.distributionOauthStates)).toHaveLength(1);
    expect(mock.calls.filter((c) => c.host === "www.linkedin.com")).toHaveLength(0);
  });
});

describe("credentials (encrypted settings, env over db)", () => {
  it("stores the secret encrypted and only ever returns a mask", async () => {
    const res = await saveLinkedInCreds();
    const text = await res.text();
    expect(text).not.toContain(LI_SECRET);
    const view = JSON.parse(text) as { providers: Array<{ id: string; credentials: { clientId: { value: string; source: string }; clientSecret: { value: string; isSet: boolean } } | null; credentialsReady: boolean; redirectUrl: string | null }> };
    const li = view.providers.find((p) => p.id === "linkedin")!;
    expect(li.credentials!.clientId).toMatchObject({ value: "li-client-id", source: "db" });
    expect(li.credentials!.clientSecret.value).toBe(`••••${LI_SECRET.slice(-4)}`);
    expect(li.credentialsReady).toBe(true);
    expect(li.redirectUrl).toBe("https://api.example.test/admin/distribution/callback/linkedin");
    const [row] = await db.select().from(s.siteSettings).where(eq(s.siteSettings.key, "settings:distribution"));
    const raw = JSON.stringify(row!.value);
    expect(raw).not.toContain(LI_SECRET);
    expect(raw).toContain("enc:v1:");
    // maska yuborilsa o'zgarmaydi
    await call("/settings", admin.cookie, { method: "PUT", body: { linkedin: { clientId: "li-client-id", clientSecret: li.credentials!.clientSecret.value } } });
    const again = await (await call("/settings", admin.cookie)).json() as typeof view;
    expect(again.providers.find((p) => p.id === "linkedin")!.credentials!.clientSecret.value).toBe(`••••${LI_SECRET.slice(-4)}`);
  });
  it("env-locked fields cannot be changed from the panel, the same value is ignored", async () => {
    const bad = await call("/settings", admin.cookie, { method: "PUT", body: { x: { clientId: "other" } } });
    expect(bad.status).toBe(400);
    expect((await bad.json() as { fields: Record<string, string> }).fields["x.clientId"]).toContain("DISTRIBUTION_X_CLIENT_ID");
    const same = await call("/settings", admin.cookie, { method: "PUT", body: { x: { clientId: "env-x-client-id" } } });
    expect(same.status).toBe(200);
    const view = (await same.json()) as { providers: Array<{ id: string; credentials: { clientId: { source: string; envVar: string } } | null; credentialsReady: boolean }> };
    expect(view.providers.find((p) => p.id === "x")!.credentials!.clientId).toMatchObject({ source: "env", envVar: "DISTRIBUTION_X_CLIENT_ID" });
    // X public client: client id yetarli
    expect(view.providers.find((p) => p.id === "x")!.credentialsReady).toBe(true);
  });
  it("rejects unknown keys and whitespace", async () => {
    expect((await call("/settings", admin.cookie, { method: "PUT", body: { github: { clientId: "x" } } })).status).toBe(400);
    expect((await call("/settings", admin.cookie, { method: "PUT", body: { linkedin: { clientSecret: "a b" } } })).status).toBe(400);
  });
});

describe("connect flow (OAuth)", () => {
  it("start requires credentials; the state is stored server-side with an expiry", async () => {
    expect((await call("/accounts/linkedin/connect", admin.cookie, { method: "POST" })).status).toBe(422);
    await saveLinkedInCreds();
    const res = await call("/accounts/linkedin/connect", admin.cookie, { method: "POST" });
    expect(res.status).toBe(200);
    const { authorizationUrl, redirectUrl } = (await res.json()) as { authorizationUrl: string; redirectUrl: string };
    const u = new URL(authorizationUrl);
    expect(u.origin + u.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(u.searchParams.get("redirect_uri")).toBe(redirectUrl);
    expect(u.searchParams.get("client_id")).toBe("li-client-id");
    const [st] = await db.select().from(s.distributionOauthStates);
    expect(st!.state).toBe(u.searchParams.get("state"));
    expect(st!.expiresAt.getTime()).toBe(nowMs + 10 * 60_000);
    expect(st!.codeVerifierEnc).toBeNull();
    expect(JSON.stringify(await (await call("/accounts/github/connect", admin.cookie, { method: "POST" })).json())).toContain("OAuth");
  });

  it("callback exchanges the code, stores the account ENCRYPTED, redirects to the panel; replay fails", async () => {
    await saveLinkedInCreds();
    const { authorizationUrl } = (await (await call("/accounts/linkedin/connect", admin.cookie, { method: "POST" })).json()) as { authorizationUrl: string };
    const state = stateOf(authorizationUrl);
    const res = await call(`/callback/linkedin?code=AUTHCODE123&state=${state}`, admin.cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://blog.example.test/admin/sozlamalar?tab=tarqatish&dist=connected&provider=linkedin");
    const exchange = mock.calls.find((c) => c.host === "www.linkedin.com")!;
    const form = Object.fromEntries(new URLSearchParams(exchange.body as string));
    expect(form).toMatchObject({ grant_type: "authorization_code", code: "AUTHCODE123", client_id: "li-client-id", client_secret: LI_SECRET, redirect_uri: "https://api.example.test/admin/distribution/callback/linkedin" });
    const [acc] = await db.select().from(s.distributionAccounts);
    expect(acc!.accessTokenEnc.startsWith("enc:v1:")).toBe(true);
    expect(JSON.stringify(acc)).not.toContain(sup.TOKENS.li);
    expect(acc).toMatchObject({ provider: "linkedin", externalId: "li-owner-1", displayName: "Test Owner", status: "active" });
    expect(await db.select().from(s.distributionOauthStates)).toHaveLength(0);

    mock.reset();
    const replay = await call(`/callback/linkedin?code=AUTHCODE123&state=${state}`, admin.cookie);
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toContain("dist=error");
    expect(mock.calls).toHaveLength(0); // ikkinchi almashtirish yo'q

    const settings = await (await call("/settings", admin.cookie)).text();
    for (const t of Object.values(sup.TOKENS)) expect(settings).not.toContain(t);
    expect(settings).not.toContain(LI_SECRET);
    expect(settings).toContain("Test Owner");
  });

  it("X uses PKCE: the verifier is stored encrypted and sent on exchange; challenge is S256", async () => {
    const r = await call("/settings", admin.cookie, { method: "PUT", body: { x: {} } });
    expect(r.status).toBe(200);
    const { authorizationUrl } = (await (await call("/accounts/x/connect", admin.cookie, { method: "POST" })).json()) as { authorizationUrl: string };
    const u = new URL(authorizationUrl);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    const [st] = await db.select().from(s.distributionOauthStates);
    expect(st!.codeVerifierEnc!.startsWith("enc:v1:")).toBe(true);
    const res = await call(`/callback/x?code=XCODE&state=${u.searchParams.get("state")}`, admin.cookie);
    expect(res.headers.get("location")).toContain("dist=connected");
    const tokenCall = mock.calls.find((c) => c.host === "api.x.com" && new URL(c.url).pathname === "/2/oauth2/token")!;
    const form = Object.fromEntries(new URLSearchParams(tokenCall.body as string));
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(form.code_verifier!).digest("base64url")).toBe(u.searchParams.get("code_challenge"));
    const [acc] = await db.select().from(s.distributionAccounts);
    expect(acc!.refreshTokenEnc!.startsWith("enc:v1:")).toBe(true);
  });

  it("tampered / unknown / wrong-provider / expired state and provider error are all rejected and consumed", async () => {
    await saveLinkedInCreds();
    await call("/settings", admin.cookie, { method: "PUT", body: { x: {} } });
    const start = async (p: string) => stateOf(((await (await call(`/accounts/${p}/connect`, admin.cookie, { method: "POST" })).json()) as { authorizationUrl: string }).authorizationUrl);
    const reason = (res: Response) => new URL(res.headers.get("location")!).searchParams;

    const unknown = await call("/callback/linkedin?code=C&state=not-a-real-state", admin.cookie);
    expect(reason(unknown).get("dist")).toBe("error");
    expect((await call("/callback/linkedin?code=C", admin.cookie)).headers.get("location")).toContain("dist=error");

    const stateX = await start("x");
    const wrong = await call(`/callback/linkedin?code=C&state=${stateX}`, admin.cookie);
    expect(reason(wrong).get("dist")).toBe("error");
    expect(await db.select().from(s.distributionOauthStates)).toHaveLength(0); // sarflangan

    const expiredState = await start("linkedin");
    nowMs += 11 * 60_000;
    const expired = await call(`/callback/linkedin?code=C&state=${expiredState}`, admin.cookie);
    // INTENTIONAL CHANGE: the redirect carries a short reason CODE (the web app maps it to a fixed text), not free text.
    expect(reason(expired).get("reason")).toBe("state_expired");
    nowMs -= 11 * 60_000;

    const deniedState = await start("linkedin");
    const denied = await call(`/callback/linkedin?error=access_denied&error_description=secret&state=${deniedState}`, admin.cookie);
    expect(reason(denied).get("dist")).toBe("error");
    expect(reason(denied).get("reason")).toBe("denied");
    expect(await db.select().from(s.distributionOauthStates)).toHaveLength(0);

    const otherState = await start("linkedin");
    const other = await call(`/callback/linkedin?code=C&state=${otherState}`, admin2.cookie);
    expect(reason(other).get("dist")).toBe("error");
    expect(mock.calls.filter((c) => c.host === "www.linkedin.com")).toHaveLength(0); // hech qaysida kod almashtirilmadi
    expect(await db.select().from(s.distributionAccounts)).toHaveLength(0);
  });

  it("platform exchange failure -> error redirect, nothing stored, no secret echoed", async () => {
    await saveLinkedInCreds();
    mock.use((c) => (c.path === "/oauth/v2/accessToken" ? new Response(JSON.stringify({ error: "invalid_grant", error_description: `bad code, client_secret ${LI_SECRET}` }), { status: 400 }) : undefined));
    const state = stateOf(((await (await call("/accounts/linkedin/connect", admin.cookie, { method: "POST" })).json()) as { authorizationUrl: string }).authorizationUrl);
    const res = await call(`/callback/linkedin?code=BAD&state=${state}`, admin.cookie);
    const loc = res.headers.get("location")!;
    expect(loc).toContain("dist=error");
    expect(decodeURIComponent(loc)).not.toContain(LI_SECRET);
    expect(await db.select().from(s.distributionAccounts)).toHaveLength(0);
  });
});

describe("GitHub pasted token, disconnect", () => {
  it("validates the token through the provider, stores it encrypted, never returns it", async () => {
    const res = await call("/accounts/github/token", admin.cookie, { method: "POST", body: { token: sup.TOKENS.gh } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(sup.TOKENS.gh);
    expect(text).toContain("owner");
    const [acc] = await db.select().from(s.distributionAccounts);
    expect(acc!.accessTokenEnc.startsWith("enc:v1:")).toBe(true);
    expect(acc!.accessTokenExpiresAt!.toISOString()).toBe("2027-03-01T10:00:00.000Z");
  });
  it("a rejected token stores nothing", async () => {
    mock.use((c) => (c.path === "/user" ? new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }) : undefined));
    const res = await call("/accounts/github/token", admin.cookie, { method: "POST", body: { token: "github_pat_BADTOKEN12345" } });
    expect(res.status).toBe(422);
    expect(await res.text()).not.toContain("github_pat_BADTOKEN12345");
    expect(await db.select().from(s.distributionAccounts)).toHaveLength(0);
  });
  it("disconnect deletes the tokens and makes no platform call (no revoke endpoint in the provider modules)", async () => {
    await fx.insertAccount("github", new Date(nowMs));
    mock.reset();
    const res = await call("/accounts/github", admin.cookie, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await db.select().from(s.distributionAccounts)).toHaveLength(0);
    expect(mock.calls).toHaveLength(0);
  });
  it("reconnecting the same account updates it in place; a different account deactivates the old one (a second is not impossible)", async () => {
    await fx.insertAccount("github", new Date(nowMs));
    await call("/accounts/github/token", admin.cookie, { method: "POST", body: { token: sup.TOKENS.gh } });
    expect(await db.select().from(s.distributionAccounts)).toHaveLength(1);
    mock.use((c) => (c.path === "/user" ? new Response(JSON.stringify({ login: "other-owner" }), { status: 200, headers: { "content-type": "application/json" } }) : undefined));
    await call("/accounts/github/token", admin.cookie, { method: "POST", body: { token: "github_pat_OTHERTOKEN1" } });
    const rows = await db.select().from(s.distributionAccounts);
    expect(rows.map((r) => `${r.externalId}:${r.status}`).sort()).toEqual(["other-owner:active", "owner:inactive"]);
  });
});

describe("post-level routes", () => {
  it("preview -> draft -> send (queued, not sent) -> status in the post list; nothing sent automatically", async () => {
    const post = await fx.insertPost();
    await fx.insertAccount("x", new Date(nowMs));
    const pv = await call(`/posts/${post.id}/x/preview`, admin.cookie, { method: "POST", body: {} });
    expect(pv.status).toBe(200);
    const preview = (await pv.json()) as { text: string; length: number; limit: number; unit: string; canSend: boolean; checks: Array<{ id: string; status: string }>; image: { source: string } };
    expect(preview).toMatchObject({ limit: 280, unit: "weighted", canSend: true });
    expect(preview.image.source).toBe("cover");
    expect(preview.checks.some((c) => c.id === "text.length")).toBe(true);

    const draft = await call(`/posts/${post.id}/x/draft`, admin.cookie, { method: "PUT", body: { text: "Qo'lda yozilgan matn" } });
    expect(draft.status).toBe(200);
    expect((await draft.json() as { status: string; text: string })).toMatchObject({ status: "draft", text: "Qo'lda yozilgan matn" });
    expect(mock.calls).toHaveLength(0);

    const sent = await call(`/posts/${post.id}/x/send`, admin.cookie, { method: "POST", body: {} });
    expect(sent.status).toBe(200);
    expect(((await sent.json()) as { status: string }).status).toBe("scheduled");
    expect(mock.calls).toHaveLength(0);

    const list = (await (await call(`/posts/${post.id}`, admin.cookie)).json()) as { autoPost: boolean; channels: Array<{ id: string; readOnly: boolean }>; distributions: Array<{ status: string; text: string }> };
    expect(list.autoPost).toBe(false);
    expect(list.channels.map((c) => c.id)).toEqual(["linkedin", "x", "threads", "instagram", "github", "telegram"]);
    expect(list.channels.find((c) => c.id === "telegram")!.readOnly).toBe(true);
    expect(list.distributions).toHaveLength(1);
  });
  it("preflight failures are 422 with the checklist; invalid bodies 400; unknown ids 404", async () => {
    const post = await fx.insertPost();
    const r = await call(`/posts/${post.id}/linkedin/send`, admin.cookie, { method: "POST", body: {} });
    expect(r.status).toBe(422);
    const body = (await r.json()) as { checks: Array<{ id: string; status: string }>; errorCount: number };
    expect(body.errorCount).toBeGreaterThan(0);
    expect(body.checks.some((c) => c.id === "dist.account" && c.status === "error")).toBe(true);
    expect((await call(`/posts/${post.id}/linkedin/send`, admin.cookie, { method: "POST", body: { nonsense: 1 } })).status).toBe(400);
    expect((await call(`/posts/${post.id}/myspace/send`, admin.cookie, { method: "POST", body: {} })).status).toBe(404);
    expect((await call("/posts/not-a-uuid", admin.cookie)).status).toBe(404);
    expect((await call(`/posts/00000000-0000-4000-8000-000000000000/x/send`, admin.cookie, { method: "POST", body: {} })).status).toBe(404);
  });
  it("schedule / cancel / resolve / retry / remove routes", async () => {
    const post = await fx.insertPost();
    await fx.insertAccount("linkedin", new Date(nowMs));
    const at = new Date(nowMs + 3_600_000).toISOString();
    const sch = await call(`/posts/${post.id}/linkedin/schedule`, admin.cookie, { method: "POST", body: { scheduledAt: at } });
    expect(sch.status).toBe(200);
    const item = (await sch.json()) as { id: string; scheduledAt: string };
    expect(item.scheduledAt).toBe(at);
    expect((await call(`/posts/${post.id}/linkedin/schedule`, admin.cookie, { method: "POST", body: { scheduledAt: "2020-01-01T00:00:00Z" } })).status).toBe(400);
    expect((await call(`/items/${item.id}/cancel`, admin.cookie, { method: "POST" })).status).toBe(200);
    expect((await call(`/items/${item.id}/cancel`, admin.cookie, { method: "POST" })).status).toBe(409);
    expect((await call(`/items/${item.id}`, admin.cookie)).status).toBe(200);
    expect((await call(`/items/${item.id}/resolve`, admin.cookie, { method: "POST", body: { action: "mark_sent", url: "https://x.com/1" } })).status).toBe(409);
    expect((await call(`/items/${item.id}/retry`, admin.cookie, { method: "POST" })).status).toBe(409);
    expect((await call(`/items/${item.id}/remove`, admin.cookie, { method: "POST" })).status).toBe(409);
    expect((await call(`/items/${item.id}/resolve`, admin.cookie, { method: "POST", body: { action: "explode" } })).status).toBe(400);
  });
  it("audit: connect/credentials/send entries carry no secrets", async () => {
    await saveLinkedInCreds();
    const { authorizationUrl } = (await (await call("/accounts/linkedin/connect", admin.cookie, { method: "POST" })).json()) as { authorizationUrl: string };
    await call(`/callback/linkedin?code=AUTHCODE&state=${stateOf(authorizationUrl)}`, admin.cookie);
    const post = await fx.insertPost();
    await call(`/posts/${post.id}/linkedin/send`, admin.cookie, { method: "POST", body: {} });
    const rows = await db.select().from(s.auditLog);
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["distribution.credentials_update", "distribution.account_connect_start", "distribution.account_connect", "distribution.send"]));
    const dump = JSON.stringify(rows);
    for (const secret of [...Object.values(sup.TOKENS), LI_SECRET, "AUTHCODE", stateOf(authorizationUrl)]) expect(dump).not.toContain(secret);
  });
});

describe("GET /admin/me exposes the flag (so the web app needs no 404 probes)", () => {
  it("admin: distributionEnabled true; staff: unchanged (no field)", async () => {
    const a = (await (await app.request("/admin/me", { headers: { cookie: admin.cookie } })).json()) as Record<string, unknown>;
    expect(a.distributionEnabled).toBe(true);
    const st = (await (await app.request("/admin/me", { headers: { cookie: staff.cookie } })).json()) as Record<string, unknown>;
    expect(Object.keys(st).sort()).toEqual(["email", "id", "name", "role"]);
  });
});

describe("GET /posts/:id for a post in the trash", () => {
  it("lists its distributions read-only (postDeleted) and lets a sent one be removed", async () => {
    await fx.insertAccount("x", new Date(nowMs));
    const post = await fx.insertPost();
    const [d] = await db.insert(s.distributions).values({ postId: post.id, provider: "x", status: "sent", externalId: "tw1", externalUrl: "https://x.com/o/status/tw1", sentAt: new Date(nowMs) }).returning();
    await db.update(s.posts).set({ deletedAt: new Date(nowMs) }).where(eq(s.posts.id, post.id));
    const res = await call(`/posts/${post.id}`, admin.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { postDeleted?: boolean; distributions: Array<{ id: string }> };
    expect(body.postDeleted).toBe(true);
    expect(body.distributions.map((x) => x.id)).toEqual([d!.id]);
    expect((await call(`/posts/${post.id}/x/send`, admin.cookie, { method: "POST", body: {} })).status).toBe(404);
    expect((await call(`/items/${d!.id}/remove`, admin.cookie, { method: "POST" })).status).toBe(200);
  });
});

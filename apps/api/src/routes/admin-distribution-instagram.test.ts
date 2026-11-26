import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { migrateTestDb } from "../test/migrate-test-db.js";
import { createTestUser, type TestUser } from "../test/auth-test-helpers.js";

vi.hoisted(() => {
  process.env.DISTRIBUTION_ENABLED = "true";
  process.env.API_ORIGIN = "https://api.example.test";
  process.env.WEB_ORIGIN = "https://blog.example.test";
  process.env.ADMIN_WRITE_RATE_LIMIT_MAX = "0";
});

const notices: string[] = [];
vi.mock("../lib/distribution/service/notify.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/distribution/service/notify.js")>("../lib/distribution/service/notify.js");
  return {
    ...actual,
    notifyOwner: async (text: string) => {
      notices.push(text);
      return "sent" as const;
    },
  };
});

let app: Hono;
let admin: TestUser;
let db: typeof import("../db/index.js").db;
let s: typeof import("../db/schema.js");
let sup: typeof import("../lib/distribution/service/test-support.js");
let fx: typeof import("../lib/distribution/service/fixtures.js");
let env: typeof import("../lib/distribution/service/env.js");
let accounts: typeof import("../lib/distribution/service/accounts.js");
let mock: ReturnType<typeof import("../lib/distribution/service/test-support.js").createPlatformMock>;
let nowMs = Date.parse("2026-11-26T10:00:00Z");

const META_SECRET = "META-APP-SECRET-VALUE-4242";
const GRAPH = "graph.facebook.com";

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
  accounts = await import("../lib/distribution/service/accounts.js");
  mock = sup.createPlatformMock();
  env.setDistributionFetch(mock.fetch);
  env.setDistributionClock(() => new Date(nowMs));
  admin = await createTestUser({ role: "admin", name: "Admin" });
});

afterAll(() => {
  env.setDistributionFetch(null);
  env.setDistributionClock(null);
});

beforeEach(async () => {
  nowMs = Date.parse("2026-11-26T10:00:00Z");
  mock.reset();
  notices.length = 0;
  await fx.clearAll();
  await db.delete(s.siteSettings).where(eq(s.siteSettings.key, "settings:distribution"));
});

const saveCreds = (instagram: Record<string, string> = { clientId: "meta-app-id", clientSecret: META_SECRET, configId: "555123" }) => call("/settings", admin.cookie, { method: "PUT", body: { instagram } });
const stateOf = (url: string) => new URL(url).searchParams.get("state")!;
const start = async () => ((await (await call("/accounts/instagram/connect", admin.cookie, { method: "POST" })).json()) as { authorizationUrl: string }).authorizationUrl;
const params = (res: Response) => new URL(res.headers.get("location")!).searchParams;

type SettingsView = { providers: Array<{ id: string; credentialsReady: boolean; credentialLabels?: Record<string, string>; credentials: { clientId: { value: string; source: string }; clientSecret: { value: string }; configId?: { value: string; source: string; envVar: string; isSet?: boolean } } | null; account: { neverExpires?: boolean; expiresAt: string | null; tokenState: string; displayName: string; username: string | null; daysLeft: number | null } | null }> };
const igView = async () => ((await (await call("/settings", admin.cookie)).json()) as SettingsView).providers.find((p) => p.id === "instagram")!;

describe("Instagram settings: Meta App ID / Meta App Secret / Config ID", () => {
  it("the secret is encrypted and only masked; the Config ID is plain and not secret; labels come from the server", async () => {
    const res = await saveCreds();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(META_SECRET);
    const ig = (JSON.parse(text) as SettingsView).providers.find((p) => p.id === "instagram")!;
    expect(ig.credentials!.clientSecret.value).toBe(`••••${META_SECRET.slice(-4)}`);
    expect(ig.credentials!.configId).toMatchObject({ value: "555123", source: "db", envVar: "DISTRIBUTION_INSTAGRAM_CONFIG_ID" });
    expect(ig.credentialLabels).toEqual({ clientId: "Meta App ID", clientSecret: "Meta App Secret", configId: "Config ID" });
    expect(ig.credentialsReady).toBe(true);
    const [row] = await db.select().from(s.siteSettings).where(eq(s.siteSettings.key, "settings:distribution"));
    expect(JSON.stringify(row!.value)).not.toContain(META_SECRET);
    expect(JSON.stringify(row!.value)).toContain("555123");
    // maska qaytsa o'zgarmaydi
    await saveCreds({ clientId: "meta-app-id", clientSecret: ig.credentials!.clientSecret.value, configId: "555123" });
    expect((await igView()).credentials!.clientSecret.value).toBe(`••••${META_SECRET.slice(-4)}`);
  });
  it("a missing Config ID means not ready, and Ulash is refused with a clear message", async () => {
    await saveCreds({ clientId: "meta-app-id", clientSecret: META_SECRET });
    const ig = await igView();
    expect(ig.credentialsReady).toBe(false);
    const res = await call("/accounts/instagram/connect", admin.cookie, { method: "POST" });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("Config ID");
    // keyin Config ID ni kiritsak tayyor bo'ladi
    await saveCreds({ configId: "555123" });
    expect((await igView()).credentialsReady).toBe(true);
  });
  it("Config ID must be digits only (bounded): clear Uzbek error at save time", async () => {
    for (const bad of ["CFG-555", "12 34", "12a", "1".repeat(33), "../1"]) {
      const res = await saveCreds({ configId: bad });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { fields: Record<string, string> }).fields["instagram.configId"]).toBe("Config ID faqat raqamlardan iborat bo'lishi kerak (1–32 ta raqam)");
    }
    expect((await saveCreds({ configId: "123456789012345678" })).status).toBe(200);
  });
  it("an already stored non-digit Config ID does not crash reading: it reads as not configured, with the same message on Ulash", async () => {
    await saveCreds();
    const [row] = await db.select().from(s.siteSettings).where(eq(s.siteSettings.key, "settings:distribution"));
    const v = row!.value as Record<string, Record<string, string>>;
    v.instagram!.configId = "OLD-CFG";
    await db.update(s.siteSettings).set({ value: v }).where(eq(s.siteSettings.key, "settings:distribution"));
    const ig = await igView();
    expect(ig.credentialsReady).toBe(false);
    expect(ig.credentials!.configId).toMatchObject({ value: "", isSet: false, source: "none" });
    const res = await call("/accounts/instagram/connect", admin.cookie, { method: "POST" });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("Config ID");
  });
  it("Config ID: whitespace is rejected; other channels do not accept it; clearing makes it not ready", async () => {
    expect((await saveCreds({ configId: "a b" })).status).toBe(400);
    const other = await call("/settings", admin.cookie, { method: "PUT", body: { linkedin: { configId: "1" } } });
    expect(other.status).toBe(400);
    expect(((await other.json()) as { fields: Record<string, string> }).fields["linkedin.configId"]).toBeTruthy();
    await saveCreds();
    await saveCreds({ configId: "" });
    expect((await igView()).credentialsReady).toBe(false);
  });
  it("LinkedIn/Threads/X/GitHub settings carry no Config ID and no custom labels", async () => {
    const view = (await (await call("/settings", admin.cookie)).json()) as SettingsView;
    for (const p of view.providers.filter((x) => x.id !== "instagram")) {
      expect(p.credentials?.configId).toBeUndefined();
      expect(p.credentialLabels).toBeUndefined();
    }
  });
});

describe("Instagram connect flow", () => {
  it("Ulash builds the Facebook Login for Business dialog URL (config_id, no scope) with a stored state", async () => {
    await saveCreds();
    const url = new URL(await start());
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/dialog/oauth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: "meta-app-id", config_id: "555123", redirect_uri: "https://api.example.test/admin/distribution/callback/instagram", response_type: "code" });
    expect(url.searchParams.has("scope")).toBe(false);
    expect(await db.select().from(s.distributionOauthStates)).toHaveLength(1);
  });

  it("callback: exchanges the code, stores the account id/username/client_business_id, card shows a non-expiring token; the token is stored encrypted", async () => {
    await saveCreds();
    const state = stateOf(await start());
    const res = await call(`/callback/instagram?code=AUTH-CODE-1&state=${state}`, admin.cookie);
    expect(res.headers.get("location")).toBe("https://blog.example.test/admin/sozlamalar?tab=tarqatish&dist=connected&provider=instagram");
    const tokenCall = mock.calls.find((c) => c.host === GRAPH && new URL(c.url).pathname === "/v27.0/oauth/access_token")!;
    expect(tokenCall.method).toBe("GET");
    expect(Object.fromEntries(new URL(tokenCall.url).searchParams)).toEqual({ client_id: "meta-app-id", client_secret: META_SECRET, code: "AUTH-CODE-1", redirect_uri: "https://api.example.test/admin/distribution/callback/instagram" });
    const [row] = await db.select().from(s.distributionAccounts);
    expect(row).toMatchObject({ provider: "instagram", externalId: "17841400000001", username: "owner_ig", displayName: "owner_ig", accessTokenExpiresAt: null, refreshTokenEnc: null, status: "active" });
    expect(row!.meta).toEqual({ clientBusinessId: "BIZ1" });
    expect(row!.accessTokenEnc).toContain("enc:v1:");
    expect(JSON.stringify(row)).not.toContain(sup.TOKENS.ig);
    const ig = await igView();
    expect(ig.account).toMatchObject({ displayName: "owner_ig", username: "owner_ig", neverExpires: true, expiresAt: null, tokenState: "ok", daysLeft: null });
    const body = JSON.stringify(ig);
    expect(body).not.toContain(sup.TOKENS.ig);
    expect(body).not.toContain(META_SECRET);
  });

  it("a token that never expires is never refreshed and never triggers expiry reminders", async () => {
    await saveCreds();
    await call(`/callback/instagram?code=C1&state=${stateOf(await start())}`, admin.cookie);
    mock.calls.length = 0;
    nowMs += 400 * 86_400_000;
    expect(await accounts.runTokenRefreshes(new Date(nowMs))).toBe(0);
    expect(await accounts.runTokenReminders(new Date(nowMs))).toBe(0);
    expect(notices).toEqual([]);
    expect(mock.calls).toHaveLength(0);
    expect((await db.select().from(s.distributionAccounts))[0]!.status).toBe("active");
  });

  it("a token WITH an expiry (configuration set to 60 days) is reminded and then expires; it is not refreshed", async () => {
    await saveCreds();
    mock.use((c) => (c.host === GRAPH && c.path === "/v27.0/oauth/access_token" ? new Response(JSON.stringify({ access_token: sup.TOKENS.ig, expires_in: 60 * 86_400 }), { status: 200 }) : undefined));
    await call(`/callback/instagram?code=C1&state=${stateOf(await start())}`, admin.cookie);
    const ig = await igView();
    expect(ig.account!.neverExpires).toBeUndefined();
    expect(ig.account!.daysLeft).toBe(60);
    mock.calls.length = 0;
    nowMs += 55 * 86_400_000;
    expect(await accounts.runTokenRefreshes(new Date(nowMs))).toBe(0);
    expect(await accounts.runTokenReminders(new Date(nowMs))).toBe(1);
    expect(notices[0]).toContain("Instagram");
    nowMs += 10 * 86_400_000;
    await accounts.runTokenReminders(new Date(nowMs));
    expect((await db.select().from(s.distributionAccounts))[0]!.status).toBe("reauth_required");
    expect(mock.calls).toHaveLength(0);
  });

  describe("distinct error reasons", () => {
    it("cancelled login -> denied (no token call)", async () => {
      await saveCreds();
      const res = await call(`/callback/instagram?error=access_denied&error_reason=user_denied&error_description=Permissions+error.&state=${stateOf(await start())}`, admin.cookie);
      expect(params(res).get("reason")).toBe("denied");
      expect(mock.calls.filter((c) => c.host === GRAPH)).toHaveLength(0);
    });
    it("another login error -> login_failed; a config error from Meta -> config_invalid", async () => {
      await saveCreds();
      const a = await call(`/callback/instagram?error=server_error&error_description=Something+went+wrong&state=${stateOf(await start())}`, admin.cookie);
      expect(params(a).get("reason")).toBe("login_failed");
      const b = await call(`/callback/instagram?error=invalid_request&error_description=Invalid+config_id&state=${stateOf(await start())}`, admin.cookie);
      expect(params(b).get("reason")).toBe("config_invalid");
    });
    it("other channels keep a single 'denied' reason for any provider error", async () => {
      await call("/settings", admin.cookie, { method: "PUT", body: { linkedin: { clientId: "li", clientSecret: "li-secret-value" } } });
      const url = ((await (await call("/accounts/linkedin/connect", admin.cookie, { method: "POST" })).json()) as { authorizationUrl: string }).authorizationUrl;
      const res = await call(`/callback/linkedin?error=server_error&state=${stateOf(url)}`, admin.cookie);
      expect(params(res).get("reason")).toBe("denied");
    });
    it("empty account list -> no_instagram_account, nothing stored", async () => {
      await saveCreds();
      mock.use((c) => (c.host === GRAPH && c.path === "/v27.0/me/assigned_instagram_accounts" ? new Response(JSON.stringify({ data: [] }), { status: 200 }) : undefined));
      const res = await call(`/callback/instagram?code=C1&state=${stateOf(await start())}`, admin.cookie);
      expect(params(res).get("reason")).toBe("no_instagram_account");
      expect(await db.select().from(s.distributionAccounts)).toHaveLength(0);
    });
    it("several assigned accounts -> multiple_instagram_accounts, nothing stored, usernames only in the audit message, never in the URL", async () => {
      await saveCreds();
      mock.use((c) => (c.host === GRAPH && c.path === "/v27.0/me/assigned_instagram_accounts" ? new Response(JSON.stringify({ data: [{ id: "111", username: "first_acc" }, { id: "222", username: "second_acc" }] }), { status: 200 }) : undefined));
      const res = await call(`/callback/instagram?code=C1&state=${stateOf(await start())}`, admin.cookie);
      expect(params(res).get("reason")).toBe("multiple_instagram_accounts");
      expect(decodeURIComponent(res.headers.get("location")!)).not.toMatch(/first_acc|second_acc/);
      expect(await db.select().from(s.distributionAccounts)).toHaveLength(0);
      const audit = JSON.stringify(await db.select().from(s.auditLog));
      expect(audit).toContain("multiple_instagram_accounts");
      expect(audit).toContain("@first_acc");
    });
    it("token exchange failure -> exchange_failed, and no secret/code is echoed", async () => {
      await saveCreds();
      mock.use((c) => (c.host === GRAPH && c.path === "/v27.0/oauth/access_token" ? new Response(JSON.stringify({ error: { message: `bad code SECRETCODE-9 secret ${META_SECRET}`, code: 100 } }), { status: 400 }) : undefined));
      const res = await call(`/callback/instagram?code=SECRETCODE-9&state=${stateOf(await start())}`, admin.cookie);
      expect(params(res).get("reason")).toBe("exchange_failed");
      expect(decodeURIComponent(res.headers.get("location")!)).not.toMatch(/SECRETCODE-9|META-APP-SECRET/);
      expect(await db.select().from(s.distributionAccounts)).toHaveLength(0);
    });
    it("wrong config_id reported by Meta at exchange -> config_invalid", async () => {
      await saveCreds();
      mock.use((c) => (c.host === GRAPH && c.path === "/v27.0/oauth/access_token" ? new Response(JSON.stringify({ error: { message: "Invalid config_id", code: 100 } }), { status: 400 }) : undefined));
      const res = await call(`/callback/instagram?code=C1&state=${stateOf(await start())}`, admin.cookie);
      expect(params(res).get("reason")).toBe("config_invalid");
    });
    it("account lookup rejected (missing instagram_basic) -> account_lookup_failed", async () => {
      await saveCreds();
      mock.use((c) => (c.host === GRAPH && c.path === "/v27.0/me/assigned_instagram_accounts" ? new Response(JSON.stringify({ error: { message: "(#10) Application does not have permission", code: 10 } }), { status: 403 }) : undefined));
      const res = await call(`/callback/instagram?code=C1&state=${stateOf(await start())}`, admin.cookie);
      expect(params(res).get("reason")).toBe("account_lookup_failed");
    });
  });

  it("audit entries carry no secrets, code or token", async () => {
    await saveCreds();
    await call(`/callback/instagram?code=AUTH-CODE-9&state=${stateOf(await start())}`, admin.cookie);
    const rows = JSON.stringify(await db.select().from(s.auditLog));
    for (const secret of [META_SECRET, "AUTH-CODE-9", sup.TOKENS.ig]) expect(rows).not.toContain(secret);
    expect(rows).toContain("distribution.account_connect");
  });
});

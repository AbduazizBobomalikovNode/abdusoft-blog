import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { migrateTestDb } from "../../../test/migrate-test-db.js";

vi.hoisted(() => {
  process.env.DISTRIBUTION_ENABLED = "true";
  process.env.API_ORIGIN = "https://api.example.test";
  process.env.WEB_ORIGIN = "https://blog.example.test";
  process.env.DISTRIBUTION_X_CLIENT_ID = "x-client";
});

const sent: string[] = [];
let notifyResult: "sent" | "skipped" | "error" = "sent";
vi.mock("./notify.js", async () => {
  const actual = await vi.importActual<typeof import("./notify.js")>("./notify.js");
  return {
    ...actual,
    notifyOwner: async (text: string) => {
      if (notifyResult === "sent") sent.push(text);
      return notifyResult;
    },
  };
});

let accounts: typeof import("./accounts.js");
let actions: typeof import("./actions.js");
let runner: typeof import("./runner.js");
let tick: typeof import("./tick.js");
let env: typeof import("./env.js");
let fx: typeof import("./fixtures.js");
let sup: typeof import("./test-support.js");
let crypto: typeof import("../../crypto.js");
let db: typeof import("../../../db/index.js").db;
let s: typeof import("../../../db/schema.js");
let mock: ReturnType<typeof import("./test-support.js").createPlatformMock>;
const T0 = Date.parse("2026-11-26T10:00:00Z");
let nowMs = T0;
const DAY = 86_400_000;
const now = () => new Date(nowMs);

beforeAll(async () => {
  await migrateTestDb();
  accounts = await import("./accounts.js");
  actions = await import("./actions.js");
  runner = await import("./runner.js");
  tick = await import("./tick.js");
  env = await import("./env.js");
  fx = await import("./fixtures.js");
  sup = await import("./test-support.js");
  crypto = await import("../../crypto.js");
  ({ db } = await import("../../../db/index.js"));
  s = await import("../../../db/schema.js");
  mock = sup.createPlatformMock();
  env.setDistributionFetch(mock.fetch);
  env.setDistributionClock(now);
  const images = await import("./images.js");
  images.setSocialImageLoader((url) => sup.fakePreparedImage(url));
});

afterAll(() => {
  env.setDistributionFetch(null);
  env.setDistributionClock(null);
});

beforeEach(async () => {
  nowMs = T0;
  notifyResult = "sent";
  sent.length = 0;
  mock.reset();
  accounts.resetRefreshThrottle();
  await fx.clearAll();
});

const accRow = async () => (await db.select().from(s.distributionAccounts))[0]!;
const decRefresh = async () => crypto.decryptSecret((await accRow()).refreshTokenEnc);
const decAccess = async () => crypto.decryptSecret((await accRow()).accessTokenEnc);
const callPath = (c: { url: string }) => new URL(c.url).pathname;

describe("token refresh (X, rotating refresh token)", () => {
  it("persists the rotated account BEFORE the new access token is used", async () => {
    await fx.insertAccount("x", now(), { accessTokenExpiresAt: new Date(T0 + 5 * 60_000) }); // 10 daqiqadan kam qoldi
    const post = await fx.insertPost();
    let refreshAtUse = "";
    let accessAtUse = "";
    let authHeader = "";
    mock.use(async (c) => {
      if (c.path === "/2/tweets" && c.method === "POST") {
        refreshAtUse = await decRefresh();
        accessAtUse = await decAccess();
        authHeader = c.headers.authorization ?? "";
      }
      return undefined;
    });
    mock.use((c) => (c.path === "/2/oauth2/token" ? new Response(JSON.stringify({ access_token: sup.TOKENS.xAccess2, refresh_token: sup.TOKENS.xRefresh2, expires_in: 7200 }), { status: 200, headers: { "content-type": "application/json" } }) : undefined));
    const r = await actions.sendNow(fx.ADMIN_ACTOR, post.id, "x");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await runner.runDistribution(r.data.id)).toBe("sent");
    expect(mock.calls.map(callPath)).toEqual(["/2/oauth2/token", "/2/media/upload", "/2/tweets"]);
    expect(refreshAtUse).toBe(sup.TOKENS.xRefresh2); // tweet ketayotgan paytda yangi refresh token allaqachon bazada
    expect(accessAtUse).toBe(sup.TOKENS.xAccess2);
    expect(authHeader).toBe(`Bearer ${sup.TOKENS.xAccess2}`);
    const row = await accRow();
    expect(row.accessTokenEnc.startsWith("enc:v1:")).toBe(true);
    expect(row.lastRefreshAt).not.toBeNull();
  });

  it("the scheduler tick refreshes due accounts and not-due ones are left alone", async () => {
    await fx.insertAccount("x", now(), { accessTokenExpiresAt: new Date(T0 + 5 * 60_000) });
    await fx.insertAccount("threads", now());
    const res = await tick.runDistributionTick(now());
    expect(res.refreshed).toBe(1);
    expect(mock.calls.map(callPath)).toEqual(["/2/oauth2/token"]);
    const x = (await db.select().from(s.distributionAccounts).where(eq(s.distributionAccounts.provider, "x")))[0]!;
    expect(crypto.decryptSecret(x.refreshTokenEnc)).toBe(sup.TOKENS.xRefresh); // mock standart javobi (X_REFRESH_TOKEN_0001)
  });

  it("refresh_ambiguous (timeout): old tokens kept, flag set, send fails without retry; a second failure -> reauth_required", async () => {
    const acc0 = await fx.insertAccount("x", now(), { accessTokenExpiresAt: new Date(T0 + 5 * 60_000) });
    const post = await fx.insertPost();
    mock.use((c) => (c.path === "/2/oauth2/token" ? new Error("timeout") : undefined));
    const r = await actions.sendNow(fx.ADMIN_ACTOR, post.id, "x");
    if (!r.ok) throw new Error(r.error.message);
    expect(await runner.runDistribution(r.data.id)).toBe("failed");
    let row = await accRow();
    expect(row.refreshAmbiguousAt).not.toBeNull();
    expect(row.status).toBe("active");
    expect(await decRefresh()).toBe(sup.TOKENS.xRefresh);
    const d = (await db.select().from(s.distributions))[0]!;
    expect(d).toMatchObject({ status: "failed", lastErrorKind: "refresh_ambiguous" });
    expect(d.nextAttemptAt).toBeNull();
    expect(mock.calls.some((c) => callPath(c) === "/2/tweets")).toBe(false);

    // keyingi yangilash ham xato (400 invalid_grant) -> qayta ulash kerak
    accounts.resetRefreshThrottle();
    mock.reset();
    mock.use((c) => (c.path === "/2/oauth2/token" ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }) : undefined));
    nowMs += 60_000;
    await tick.runDistributionTick(now());
    row = await accRow();
    expect(row.status).toBe("reauth_required");
    expect(sent.some((m) => m.includes("qayta ulang"))).toBe(true);
    expect(row.id).toBe(acc0.id);
  });

  it("refresh_ambiguous twice in a row -> reauth_required; a later success clears the flag", async () => {
    await fx.insertAccount("x", now(), { accessTokenExpiresAt: new Date(T0 + 5 * 60_000) });
    mock.use((c) => (c.path === "/2/oauth2/token" ? new Error("socket hang up") : undefined));
    await tick.runDistributionTick(now());
    expect((await accRow()).refreshAmbiguousAt).not.toBeNull();
    accounts.resetRefreshThrottle();
    await tick.runDistributionTick(now());
    expect((await accRow()).status).toBe("reauth_required");

    await fx.clearAll();
    mock.reset();
    await fx.insertAccount("x", now(), { accessTokenExpiresAt: new Date(T0 + 5 * 60_000), refreshAmbiguousAt: new Date(T0 - 1000) });
    await tick.runDistributionTick(now());
    const row = await accRow();
    expect(row.refreshAmbiguousAt).toBeNull();
    expect(row.status).toBe("active");
  });

  it("a transient refresh error keeps the account usable and does not mark it", async () => {
    await fx.insertAccount("x", now(), { accessTokenExpiresAt: new Date(T0 + 5 * 60_000) });
    mock.use((c) => (c.path === "/2/oauth2/token" ? new Response("{}", { status: 429 }) : undefined));
    await tick.runDistributionTick(now());
    expect((await accRow()).status).toBe("active");
  });

  it("Threads self-exchange refresh happens only when due and after 24h", async () => {
    await fx.insertAccount("threads", now(), { accessTokenExpiresAt: new Date(T0 + 20 * DAY), issuedAt: new Date(T0 - 2 * DAY) });
    await tick.runDistributionTick(now());
    expect(mock.calls.map(callPath)).toEqual(["/refresh_access_token"]);
    expect(await decAccess()).toBe("THREADS-LONG-TOKEN-0002");
  });
});

describe("LinkedIn 60-day token reminders (fake clock)", () => {
  it("reminds from 10 days before expiry, at most once per day, once on expiry, then stops", async () => {
    await fx.insertAccount("linkedin", now(), { accessTokenExpiresAt: new Date(T0 + 60 * DAY) });
    nowMs = T0 + 49 * DAY;
    expect(await accounts.runTokenReminders(now())).toBe(0);
    nowMs = T0 + 50 * DAY;
    expect(await accounts.runTokenReminders(now())).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("LinkedIn");
    expect(sent[0]).toContain("10 kundan keyin");
    nowMs += 3_600_000;
    expect(await accounts.runTokenReminders(now())).toBe(0); // kuniga bitta
    nowMs = T0 + 50 * DAY + 25 * 3_600_000;
    expect(await accounts.runTokenReminders(now())).toBe(1);
    expect(sent).toHaveLength(2);
    nowMs = T0 + 59 * DAY + 3_600_000;
    expect(await accounts.runTokenReminders(now())).toBe(1);
    expect(sent[2]).toContain("kundan keyin");
    nowMs = T0 + 60 * DAY + 60_000;
    expect(await accounts.runTokenReminders(now())).toBe(1);
    expect(sent[3]).toContain("muddati tugadi");
    expect((await accRow()).status).toBe("reauth_required");
    nowMs += 2 * DAY;
    expect(await accounts.runTokenReminders(now())).toBe(0);
    expect(sent).toHaveLength(4);
  });
  it("does not spam when the bot is not configured; retries when sending errors", async () => {
    await fx.insertAccount("linkedin", now(), { accessTokenExpiresAt: new Date(T0 + 60 * DAY) });
    nowMs = T0 + 51 * DAY;
    notifyResult = "error";
    expect(await accounts.runTokenReminders(now())).toBe(0);
    expect((await accRow()).lastReminderAt).toBeNull(); // xato: keyingi tick'da qayta uriniladi
    notifyResult = "skipped";
    await accounts.runTokenReminders(now());
    expect((await accRow()).lastReminderAt).not.toBeNull(); // bot yo'q: har daqiqa urinmaydi
  });
  it("GitHub token reminders use the same rule; X/Threads (refreshable) are not nagged", async () => {
    await fx.insertAccount("github", now(), { accessTokenExpiresAt: new Date(T0 + 20 * DAY) });
    await fx.insertAccount("threads", now(), { accessTokenExpiresAt: new Date(T0 + 3 * DAY) });
    nowMs = T0 + 7 * DAY; // GitHub: 13 kun qoldi (<=14)
    expect(await accounts.runTokenReminders(now())).toBe(1);
    expect(sent[0]).toContain("GitHub");
  });
});

describe("scheduler tick", () => {
  it("sends due distributions, recovers stale sending rows, drops expired OAuth states", async () => {
    await fx.insertAccount("x", now());
    const post = await fx.insertPost();
    const post2 = await fx.insertPost();
    const r = await actions.schedule(fx.ADMIN_ACTOR, post.id, "x", new Date(T0 + 3_600_000));
    if (!r.ok) throw new Error(r.error.message);
    await db.insert(s.distributions).values({ postId: post2.id, provider: "x", status: "sending", updatedAt: new Date(T0 - 60 * 60_000) });
    await db.insert(s.distributionOauthStates).values({ state: "old-state", provider: "linkedin", expiresAt: new Date(T0 - 1000) });
    let res = await tick.runDistributionTick(now());
    expect(res).toMatchObject({ recovered: 1, ran: 0 });
    expect(await db.select().from(s.distributionOauthStates)).toHaveLength(0);
    nowMs = T0 + 3_600_001;
    res = await tick.runDistributionTick(now());
    expect(res.ran).toBe(1);
    const row = (await db.select().from(s.distributions).where(eq(s.distributions.id, r.data.id)))[0]!;
    expect(row.status).toBe("sent");
  });
  it("startScheduler registers the extra job only when the flag is on", async () => {
    const { startScheduler } = await import("../../scheduler.js");
    const jobs = startScheduler();
    expect(jobs).toHaveLength(4);
    for (const j of jobs) j.stop();
  });
});

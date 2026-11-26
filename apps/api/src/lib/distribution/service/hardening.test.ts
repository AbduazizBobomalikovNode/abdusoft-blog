import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { migrateTestDb } from "../../../test/migrate-test-db.js";

vi.hoisted(() => {
  process.env.DISTRIBUTION_ENABLED = "true";
  process.env.API_ORIGIN = "https://api.example.test";
  process.env.WEB_ORIGIN = "https://blog.example.test";
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
let credentials: typeof import("./credentials.js");
let channels: typeof import("./channels.js");
let settingsView: typeof import("./settings-view.js");
let prepare: typeof import("./prepare.js");
let db: typeof import("../../../db/index.js").db;
let s: typeof import("../../../db/schema.js");
let mock: ReturnType<typeof import("./test-support.js").createPlatformMock>;
const T0 = Date.parse("2026-11-26T10:00:00Z");
let nowMs = T0;
const now = () => new Date(nowMs);

/** `BETTER_AUTH_SECRET` almashtirilgandan keyingi holat: format to'g'ri, lekin GCM tegi mos kelmaydi -> `decryptSecret` "" qaytaradi. */
const UNREADABLE = `enc:v1:${Buffer.alloc(12, 1).toString("base64")}:${Buffer.alloc(16, 2).toString("base64")}:${Buffer.alloc(20, 3).toString("base64")}`;

const rowOf = async (id: string) => (await db.select().from(s.distributions).where(eq(s.distributions.id, id)))[0]!;
const accRows = async () => db.select().from(s.distributionAccounts);
const A = () => fx.ADMIN_ACTOR;

beforeAll(async () => {
  await migrateTestDb();
  accounts = await import("./accounts.js");
  actions = await import("./actions.js");
  runner = await import("./runner.js");
  tick = await import("./tick.js");
  env = await import("./env.js");
  fx = await import("./fixtures.js");
  sup = await import("./test-support.js");
  credentials = await import("./credentials.js");
  channels = await import("./channels.js");
  settingsView = await import("./settings-view.js");
  prepare = await import("./prepare.js");
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
  await db.delete(s.siteSettings).where(eq(s.siteSettings.key, "settings:distribution"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("undecryptable stored tokens read as 'reconnect required', never 'active'", () => {
  it("settings view, channel readiness, preview/preflight and send all agree; no outbound request is made", async () => {
    await fx.insertAccount("x", now(), { accessTokenEnc: UNREADABLE, refreshTokenEnc: UNREADABLE });
    const post = await fx.insertPost();

    const view = await settingsView.buildSettingsView();
    const x = view.providers.find((p) => p.id === "x")!;
    expect(x.account).toMatchObject({ status: "reauth_required", tokenState: "expired", secretUnreadable: true });

    const ch = await channels.channelFor("x");
    expect(ch).toMatchObject({ connected: true, ready: false });
    expect(ch.notReadyReason).toBe(accounts.UNREADABLE_TOKEN_MESSAGE);
    expect(ch.notReadyReason).toMatch(/qayta ulang/);

    const preview = await prepare.buildPreview(post.id, "x");
    expect(preview!.canSend).toBe(false);
    expect(preview!.checks.find((c) => c.id === "dist.account")).toMatchObject({ status: "error", message: accounts.UNREADABLE_TOKEN_MESSAGE });

    const r = await actions.sendNow(A(), post.id, "x");
    expect(r.ok).toBe(false);
    expect(await actions.removeFromPlatform(A(), (await db.insert(s.distributions).values({ postId: post.id, provider: "x", status: "sent", externalId: "t1" }).returning())[0]!.id)).toMatchObject({ ok: false });
    expect(mock.calls).toHaveLength(0);
  });

  it("a distribution already scheduled for such an account fails at send time WITHOUT any request (empty bearer token is never sent)", async () => {
    await fx.insertAccount("linkedin", now(), { accessTokenEnc: UNREADABLE });
    const post = await fx.insertPost();
    const [d] = await db.insert(s.distributions).values({ postId: post.id, provider: "linkedin", status: "scheduled", scheduledAt: now() }).returning();
    expect(await runner.runDistribution(d!.id)).toBe("failed");
    expect(mock.calls).toHaveLength(0);
    const row = await rowOf(d!.id);
    expect(row).toMatchObject({ status: "failed", lastErrorKind: "auth_expired" });
    expect(row.lastErrorMessage).toContain("maxfiy kalit o'zgargan");
    expect((await accRows())[0]!.status).toBe("reauth_required");
  });

  it("a healthy account next to it is unaffected", async () => {
    await fx.insertAccount("x", now());
    const view = await settingsView.buildSettingsView();
    expect(view.providers.find((p) => p.id === "x")!.account).toMatchObject({ status: "active", tokenState: "ok" });
    expect(view.providers.find((p) => p.id === "x")!.account!.secretUnreadable).toBeUndefined();
  });

  it("token upkeep: no refresh attempt, the account becomes reauth_required with ONE owner notification", async () => {
    await fx.insertAccount("x", now(), { accessTokenEnc: UNREADABLE, refreshTokenEnc: UNREADABLE, accessTokenExpiresAt: new Date(T0 + 5 * 60_000) });
    await fx.insertAccount("linkedin", now(), { accessTokenEnc: UNREADABLE });
    const first = await tick.runDistributionTick(now());
    expect(first.refreshed).toBe(0);
    expect(mock.calls).toHaveLength(0);
    expect((await accRows()).every((a) => a.status === "reauth_required")).toBe(true);
    expect(sent).toHaveLength(2); // akkaunt boshiga bitta
    await tick.runDistributionTick(now());
    nowMs += 3_600_000;
    await tick.runDistributionTick(now());
    expect(sent).toHaveLength(2);
    expect(mock.calls).toHaveLength(0);
  });

  it("an undecryptable client secret means 'credentials not configured' (also for X, which can otherwise be a public client)", async () => {
    const { upsertSiteSetting } = await import("../../site-settings.js");
    await upsertSiteSetting("settings:distribution", { x: { clientId: "x-client", clientSecret: UNREADABLE }, linkedin: { clientId: "li-client", clientSecret: UNREADABLE } });
    const creds = await credentials.getCredentials("x");
    expect(creds).toMatchObject({ clientId: "x-client", clientSecret: "", secretUnreadable: true });
    expect(credentials.credentialsReady("x", creds)).toBe(false);
    expect(credentials.credentialsReady("linkedin", await credentials.getCredentials("linkedin"))).toBe(false);
    const view = await settingsView.buildSettingsView();
    for (const id of ["x", "linkedin"]) {
      const p = view.providers.find((v) => v.id === id)!;
      expect(p).toMatchObject({ credentialsReady: false, credentialsUnreadable: true });
      expect(p.credentials!.clientSecret.isSet).toBe(false);
    }
    const start = await accounts.startConnect(A(), "x");
    expect(start).toMatchObject({ ok: false });
    if (!start.ok) expect(start.error.message).toBe(credentials.UNREADABLE_CREDENTIALS_MESSAGE);
    expect(mock.calls).toHaveLength(0);
  });

  it("token upkeep with an unreadable client secret: no refresh request, reconnect required once", async () => {
    const { upsertSiteSetting } = await import("../../site-settings.js");
    await upsertSiteSetting("settings:distribution", { x: { clientId: "x-client", clientSecret: UNREADABLE } });
    await fx.insertAccount("x", now(), { accessTokenExpiresAt: new Date(T0 + 5 * 60_000) });
    await tick.runDistributionTick(now());
    expect(mock.calls).toHaveLength(0);
    expect((await accRows())[0]!.status).toBe("reauth_required");
    expect(sent).toHaveLength(1);
  });

  it("a normal secret still round-trips (no false positives)", async () => {
    await credentials.saveCredentials({ linkedin: { clientId: "li", clientSecret: "s3cret-value" } });
    const creds = await credentials.getCredentials("linkedin");
    expect(creds).toMatchObject({ clientId: "li", clientSecret: "s3cret-value" });
    expect(creds.secretUnreadable).toBeUndefined();
    expect(credentials.credentialsReady("linkedin", creds)).toBe(true);
  });
});

describe("startup recovery does not misjudge a send still in flight during a deploy overlap", () => {
  it("on start only STALE sending rows become needs_checking; a fresh one is left to the process that is finishing it", async () => {
    const p1 = await fx.insertPost();
    const p2 = await fx.insertPost();
    const [fresh] = await db.insert(s.distributions).values({ postId: p1.id, provider: "x", status: "sending", attempts: 1, updatedAt: new Date(T0 - 60_000) }).returning();
    const [stale] = await db.insert(s.distributions).values({ postId: p2.id, provider: "linkedin", status: "sending", attempts: 1, updatedAt: new Date(T0 - 30 * 60_000) }).returning();
    await tick.recoverDistributionsOnStart();
    expect((await rowOf(fresh!.id)).status).toBe("sending");
    expect((await rowOf(stale!.id)).status).toBe("needs_checking");
    // O'lgan jarayonning qatori keyingi tick'larda eskirganda baribir tekshirishga o'tadi (hech qachon avtomatik qayta yuborilmaydi).
    nowMs = T0 + 25 * 60_000;
    await tick.runDistributionTick(now());
    expect((await rowOf(fresh!.id)).status).toBe("needs_checking");
    expect(await runner.runDueDistributions(now())).toBe(0);
    expect(mock.calls).toHaveLength(0);
  });

  it("if recovery already flipped the row while the old process was finishing, the finished send is still recorded (id + url) - and no second post is made", async () => {
    await fx.insertAccount("linkedin", now());
    const post = await fx.insertPost();
    const q = await actions.sendNow(A(), post.id, "linkedin");
    if (!q.ok) throw new Error(q.error.message);
    // Platforma so'rovi ketayotgan paytda "yangi jarayon" qatorni needs_checking'ga o'tkazadi.
    let flipped = 0;
    mock.use(async (c) => {
      if (c.host === "api.linkedin.com" && c.path === "/rest/posts" && c.method === "POST") flipped = await runner.recoverInterruptedDistributions(now(), true);
      return undefined;
    });
    expect(await runner.runDistribution(q.data.id)).toBe("sent");
    expect(flipped).toBe(1);
    const row = await rowOf(q.data.id);
    expect(row).toMatchObject({ status: "sent", externalId: "urn:li:share:7000001", lastErrorKind: null });
    expect(row.sentText).toBeTruthy();
    const audit = await db.select().from(s.auditLog).where(eq(s.auditLog.action, "distribution.sent"));
    expect((audit[0]!.meta as Record<string, unknown>).recordedAfterRecovery).toBe(true);
    expect(mock.calls.filter((c) => new URL(c.url).pathname === "/rest/posts" && c.method === "POST")).toHaveLength(1);
    expect(await runner.runDueDistributions(now())).toBe(0);
  });

  it("a row the owner already resolved by hand is never overwritten by a late result", async () => {
    await fx.insertAccount("linkedin", now());
    const post = await fx.insertPost();
    const q = await actions.sendNow(A(), post.id, "linkedin");
    if (!q.ok) throw new Error(q.error.message);
    mock.use(async (c) => {
      if (c.host === "api.linkedin.com" && c.path === "/rest/posts" && c.method === "POST") {
        await runner.recoverInterruptedDistributions(now(), true);
        await actions.resolveNeedsChecking(A(), q.data.id, { action: "not_posted" });
      }
      return undefined;
    });
    await runner.runDistribution(q.data.id);
    expect((await rowOf(q.data.id)).status).toBe("cancelled");
  });
});

describe("scheduled sends go to the account they were prepared for, with the text that was previewed", () => {
  it("a different account connected after scheduling -> failed with a clear reason, NO post to the new account", async () => {
    await fx.insertAccount("x", now());
    const post = await fx.insertPost();
    const r = await actions.schedule(A(), post.id, "x", new Date(T0 + 3_600_000));
    if (!r.ok) throw new Error(r.error.message);
    // Egasi boshqa X akkauntini ulaydi (eskisi inactive bo'ladi)
    await db.update(s.distributionAccounts).set({ status: "inactive" }).where(eq(s.distributionAccounts.provider, "x"));
    await db.insert(s.distributionAccounts).values({
      provider: "x", externalId: "x-OTHER-9", displayName: "Boshqa", accessTokenEnc: (await import("../../crypto.js")).encryptSecret(sup.TOKENS.xAccess), refreshTokenEnc: null,
      accessTokenExpiresAt: new Date(T0 + 7_200_000), scopes: [], meta: {}, status: "active", issuedAt: now(), connectedAt: new Date(T0 + 1000),
    });
    nowMs = T0 + 3_600_001;
    expect(await runner.runDistribution(r.data.id)).toBe("failed");
    expect(mock.calls).toHaveLength(0);
    const row = await rowOf(r.data.id);
    expect(row).toMatchObject({ status: "failed", lastErrorKind: "validation_rejected" });
    expect(row.lastErrorMessage).toBe(runner.ACCOUNT_CHANGED_MESSAGE);
    expect(row.lastErrorMessage).toMatch(/BOSHQA akkaunt/);
  });

  it("reconnecting the SAME account (even after a disconnect) still sends", async () => {
    await fx.insertAccount("x", now());
    const post = await fx.insertPost();
    const r = await actions.schedule(A(), post.id, "x", new Date(T0 + 3_600_000));
    if (!r.ok) throw new Error(r.error.message);
    expect((await rowOf(r.data.id)).accountExternalId).toBe("x-owner-1");
    await accounts.disconnectAccount(A(), "x");
    await fx.insertAccount("x", new Date(T0 + 1000)); // xuddi shu platforma akkaunti qayta ulandi
    nowMs = T0 + 3_600_001;
    expect(await runner.runDistribution(r.data.id)).toBe("sent");
  });

  it("freezes the previewed text: a later edit of the post does not change what a scheduled, un-edited distribution posts", async () => {
    await fx.insertAccount("x", now());
    const post = await fx.insertPost({ title: "Birinchi sarlavha", excerpt: "Birinchi tavsif" });
    const preview = await prepare.buildPreview(post.id, "x");
    const r = await actions.schedule(A(), post.id, "x", new Date(T0 + 3_600_000));
    if (!r.ok) throw new Error(r.error.message);
    const stored = await rowOf(r.data.id);
    expect(stored.text).toBeNull(); // qo'lda tahrirlanmagan
    expect(stored.renderedText).toBe(preview!.text);
    await db.update(s.posts).set({ title: "Butunlay boshqa sarlavha", excerpt: "Yangi tavsif" }).where(eq(s.posts.id, post.id));
    expect((await prepare.buildPreview(post.id, "x"))!.text).not.toBe(preview!.text); // jonli ko'rinish o'zgargan
    nowMs = T0 + 3_600_001;
    expect(await runner.runDistribution(r.data.id)).toBe("sent");
    const done = await rowOf(r.data.id);
    expect(done.sentText).toBe(preview!.text);
    const tweet = mock.calls.find((c) => new URL(c.url).pathname === "/2/tweets" && c.method === "POST")!;
    expect(JSON.parse(tweet.body as string).text).toBe(preview!.text);
    expect(JSON.parse(tweet.body as string).text).not.toContain("Butunlay boshqa");
  });

  it("editing the text of a scheduled distribution refreshes the frozen text; a hand-edited text is what is frozen", async () => {
    await fx.insertAccount("x", now());
    const post = await fx.insertPost();
    const r = await actions.schedule(A(), post.id, "x", new Date(T0 + 3_600_000), { text: "Qo'lda yozilgan matn" });
    if (!r.ok) throw new Error(r.error.message);
    expect((await rowOf(r.data.id)).renderedText).toBe("Qo'lda yozilgan matn");
    const saved = await actions.saveDraft(A(), post.id, "x", { text: "Yangilangan matn" });
    expect(saved.ok).toBe(true);
    expect((await rowOf(r.data.id)).renderedText).toBe("Yangilangan matn");
    nowMs = T0 + 3_600_001;
    await runner.runDistribution(r.data.id);
    expect((await rowOf(r.data.id)).sentText).toBe("Yangilangan matn");
  });
});

describe("one failing item does not stop the tick or the upkeep loops", () => {
  it("runDueDistributions continues with the next distribution after one throws outside its own handling", async () => {
    await fx.insertAccount("x", now());
    await fx.insertAccount("linkedin", now());
    const p1 = await fx.insertPost();
    const p2 = await fx.insertPost();
    const [d1] = await db.insert(s.distributions).values({ postId: p1.id, provider: "x", status: "scheduled", scheduledAt: new Date(T0 - 1000) }).returning();
    const [d2] = await db.insert(s.distributions).values({ postId: p2.id, provider: "linkedin", status: "scheduled", scheduledAt: new Date(T0 - 1000) }).returning();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(env, "getProvider").mockImplementationOnce(() => {
      throw new Error("baza xatosi (sinov)");
    });
    expect(await runner.runDueDistributions(now())).toBe(1);
    const rows = [await rowOf(d1!.id), await rowOf(d2!.id)];
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "sending")).toHaveLength(1); // yiqilgani tiklash tomonidan "tekshirish kerak"ka o'tadi, qayta yuborilmaydi
    expect(errors).toHaveBeenCalled();
  });

  it("runTokenRefreshes and runTokenReminders continue with the next account after one throws", async () => {
    await fx.insertAccount("x", now(), { accessTokenExpiresAt: new Date(T0 + 5 * 60_000) });
    await fx.insertAccount("x", now(), { externalId: "x-owner-2", accessTokenExpiresAt: new Date(T0 + 5 * 60_000) });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(env, "getProvider").mockImplementationOnce(() => {
      throw new Error("baza xatosi (sinov)");
    });
    expect(await accounts.runTokenRefreshes(now())).toBe(1);
    expect(mock.calls.filter((c) => new URL(c.url).pathname === "/2/oauth2/token")).toHaveLength(1);
    expect(errors).toHaveBeenCalled();
    vi.restoreAllMocks();

    await db.delete(s.distributionAccounts);
    await fx.insertAccount("linkedin", now(), { accessTokenExpiresAt: new Date(T0 + 60 * 86_400_000) });
    await fx.insertAccount("github", now(), { accessTokenExpiresAt: new Date(T0 + 10 * 86_400_000) });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(env, "getProvider").mockImplementationOnce(() => {
      throw new Error("baza xatosi (sinov)");
    });
    nowMs = T0 + 55 * 86_400_000;
    expect(await accounts.runTokenReminders(now())).toBe(1);
    expect(sent).toHaveLength(1);
  });
});

describe("token reminders when Telegram is not configured", () => {
  it("record the undelivered reminder once and try again the next day (not every minute)", async () => {
    await fx.insertAccount("linkedin", now(), { accessTokenExpiresAt: new Date(T0 + 60 * 86_400_000) });
    nowMs = T0 + 51 * 86_400_000;
    notifyResult = "skipped";
    expect(await accounts.runTokenReminders(now())).toBe(0);
    const acc = (await accRows())[0]!;
    expect(acc.lastReminderAt?.getTime()).toBe(nowMs);
    const audit = await db.select().from(s.auditLog).where(eq(s.auditLog.action, "distribution.reminder_undelivered"));
    expect(audit).toHaveLength(1);
    for (let i = 1; i <= 5; i++) {
      nowMs += 60_000;
      await accounts.runTokenReminders(now());
    }
    expect(await db.select().from(s.auditLog).where(eq(s.auditLog.action, "distribution.reminder_undelivered"))).toHaveLength(1);
    nowMs = T0 + 51 * 86_400_000 + 25 * 3_600_000;
    notifyResult = "sent";
    expect(await accounts.runTokenReminders(now())).toBe(1);
    expect(sent).toHaveLength(1);
  });
});

describe("posts in the trash", () => {
  it("their distributions can still be listed (marked postDeleted) so sent posts can be removed from the platform; new sends stay blocked", async () => {
    await fx.insertAccount("x", now());
    const post = await fx.insertPost();
    const [d] = await db.insert(s.distributions).values({ postId: post.id, provider: "x", status: "sent", externalId: "t1", externalUrl: "https://x.com/o/status/t1", sentAt: now() }).returning();
    const live = await actions.listPostDistributions(post.id);
    expect(live.ok && live.data.postDeleted).toBeUndefined();
    await db.update(s.posts).set({ deletedAt: now() }).where(eq(s.posts.id, post.id));
    const trashed = await actions.listPostDistributions(post.id);
    expect(trashed.ok).toBe(true);
    if (trashed.ok) {
      expect(trashed.data.postDeleted).toBe(true);
      expect(trashed.data.distributions.map((x) => x.id)).toEqual([d!.id]);
    }
    expect((await actions.sendNow(A(), post.id, "x")).ok).toBe(false);
    expect((await actions.saveDraft(A(), post.id, "x", { text: "a" })).ok).toBe(false);
    const removed = await actions.removeFromPlatform(A(), d!.id);
    expect(removed.ok).toBe(true);
    expect(mock.calls.map((c) => c.method)).toEqual(["DELETE"]);
    expect((await actions.listPostDistributions("00000000-0000-4000-8000-000000000000")).ok).toBe(false);
  });
});

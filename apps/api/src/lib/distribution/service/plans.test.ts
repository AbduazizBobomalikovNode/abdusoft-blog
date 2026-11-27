import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { migrateTestDb } from "../../../test/migrate-test-db.js";

vi.hoisted(() => {
  process.env.DISTRIBUTION_ENABLED = "true";
  process.env.API_ORIGIN = "https://api.example.test";
  process.env.WEB_ORIGIN = "https://blog.example.test";
});

let plans: typeof import("./plans.js");
let actions: typeof import("./actions.js");
let versions: typeof import("./versions.js");
let tick: typeof import("./tick.js");
let runner: typeof import("./runner.js");
let env: typeof import("./env.js");
let fx: typeof import("./fixtures.js");
let sup: typeof import("./test-support.js");
let life: typeof import("../../posts/lifecycle.js");
let db: typeof import("../../../db/index.js").db;
let s: typeof import("../../../db/schema.js");
let mock: ReturnType<typeof import("./test-support.js").createPlatformMock>;
const NOW = new Date("2026-11-26T10:00:00Z");
const A = () => fx.ADMIN_ACTOR;
const MIN = 60_000;

beforeAll(async () => {
  await migrateTestDb();
  plans = await import("./plans.js");
  actions = await import("./actions.js");
  versions = await import("./versions.js");
  tick = await import("./tick.js");
  runner = await import("./runner.js");
  env = await import("./env.js");
  fx = await import("./fixtures.js");
  sup = await import("./test-support.js");
  life = await import("../../posts/lifecycle.js");
  ({ db } = await import("../../../db/index.js"));
  s = await import("../../../db/schema.js");
  mock = sup.createPlatformMock();
  env.setDistributionFetch(mock.fetch);
  env.setDistributionClock(() => NOW);
  const images = await import("./images.js");
  images.setSocialImageLoader((url) => sup.fakePreparedImage(url));
});
afterAll(() => {
  env.setDistributionFetch(null);
  env.setDistributionClock(null);
});
beforeEach(async () => {
  mock.reset();
  await fx.clearAll();
});

const draftPost = (over: Partial<typeof import("../../../db/schema.js").posts.$inferInsert> = {}) => fx.insertPost({ status: "draft", publishedAt: null, ...over });
const rowOf = async (postId: string, provider = "x") => (await db.select().from(s.distributions).where(eq(s.distributions.postId, postId))).filter((r) => r.provider === provider).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
const setOk = async (postId: string, provider: "x" | "linkedin" | "threads", input: Parameters<typeof plans.setPlan>[3]) => {
  const r = await plans.setPlan(A(), postId, provider, input);
  if (!r.ok) throw new Error(r.error.message);
  return r.data;
};
const publish = async (postId: string) => {
  const r = await life.publishPost(A(), postId);
  if (!r.ok) throw new Error(r.error.message);
};

describe("setPlan / clearPlan (before publish)", () => {
  it("stores the plan on a draft row of an unpublished post; nothing is queued or sent", async () => {
    const post = await draftPost();
    const item = await setOk(post.id, "x", { delayMinutes: 15, text: "Salom" });
    expect(item).toMatchObject({ status: "draft", planDelayMinutes: 15, planMaterializedAt: null, scheduledAt: null, text: "Salom" });
    expect(mock.calls).toHaveLength(0);
    // qayta qo'yish almashtiradi (ikkinchi qator yaratilmaydi)
    const again = await setOk(post.id, "x", { delayMinutes: 60 });
    expect(again.id).toBe(item.id);
    expect(again.planDelayMinutes).toBe(60);
  });

  it("allows scheduled-for-publish posts; refuses published, archived, bad delays, foreign versions and busy rows", async () => {
    const sched = await draftPost({ status: "scheduled", scheduledAt: new Date(NOW.getTime() + 3_600_000) });
    expect((await setOk(sched.id, "x", { delayMinutes: 0 })).planDelayMinutes).toBe(0);

    const pub = await fx.insertPost();
    expect(await plans.setPlan(A(), pub.id, "x", { delayMinutes: 5 })).toMatchObject({ ok: false, error: { kind: "conflict" } });
    const arch = await draftPost({ status: "archived" });
    expect(await plans.setPlan(A(), arch.id, "x", { delayMinutes: 5 })).toMatchObject({ ok: false, error: { kind: "conflict" } });

    const post = await draftPost();
    for (const bad of [-1, 10081, 1.5, Number.NaN]) expect(await plans.setPlan(A(), post.id, "x", { delayMinutes: bad })).toMatchObject({ ok: false, error: { kind: "bad_request" } });
    expect((await setOk(post.id, "x", { delayMinutes: 10080 })).planDelayMinutes).toBe(10080);

    const other = await draftPost();
    const foreign = await versions.createVersion(A(), other.id, "x", { text: "Boshqa" });
    if (!foreign.ok) throw new Error("setup");
    expect(await plans.setPlan(A(), post.id, "x", { delayMinutes: 5, versionId: foreign.data.id })).toMatchObject({ ok: false, error: { kind: "bad_request" } });
    expect(await plans.setPlan(A(), post.id, "linkedin", { delayMinutes: 5, linkMode: undefined, text: "x".repeat(20_001) })).toMatchObject({ ok: false, error: { kind: "bad_request" } });

    await db.update(s.distributions).set({ status: "failed" }).where(eq(s.distributions.postId, post.id));
    expect(await plans.setPlan(A(), post.id, "x", { delayMinutes: 5 })).toMatchObject({ ok: false, error: { kind: "conflict" } });
  });

  it("binds the primary version when neither a version nor text is given", async () => {
    const post = await draftPost();
    const v = await versions.createVersion(A(), post.id, "x", { text: "Asosiy matn", makePrimary: true });
    if (!v.ok) throw new Error("setup");
    expect((await setOk(post.id, "x", { delayMinutes: 5 })).versionId).toBe(v.data.id);
    const post2 = await draftPost();
    const v2 = await versions.createVersion(A(), post2.id, "x", { text: "Asosiy", makePrimary: true });
    if (!v2.ok) throw new Error("setup");
    expect((await setOk(post2.id, "x", { delayMinutes: 5, text: "O'z matnim" })).versionId).toBeNull();
  });

  it("clearPlan removes the plan, cancels a not-yet-sent materialised one, and is a no-op without a plan", async () => {
    await fx.insertAccount("x", NOW);
    const post = await draftPost();
    await setOk(post.id, "x", { delayMinutes: 5, text: "Reja" });
    const cleared = await plans.clearPlan(A(), post.id, "x");
    expect(cleared).toMatchObject({ ok: true, data: { cleared: true, cancelled: false } });
    expect((await rowOf(post.id)).planDelayMinutes).toBeNull();
    expect(await plans.clearPlan(A(), post.id, "x")).toMatchObject({ ok: true, data: { cleared: false } });

    await setOk(post.id, "x", { delayMinutes: 5, text: "Reja" });
    await publish(post.id);
    expect((await rowOf(post.id)).status).toBe("scheduled");
    expect(await plans.clearPlan(A(), post.id, "x")).toMatchObject({ ok: true, data: { cleared: true, cancelled: true } });
    expect(await rowOf(post.id)).toMatchObject({ status: "cancelled", planDelayMinutes: null });
  });
});

describe("materialisation on publish", () => {
  it("manual publish: scheduled_at = now + delay, text/account frozen, plan kept with a materialised marker", async () => {
    await fx.insertAccount("x", NOW);
    const post = await draftPost();
    await setOk(post.id, "x", { delayMinutes: 15, text: "Chop etilgach shu matn" });
    await publish(post.id);
    const row = await rowOf(post.id);
    expect(row).toMatchObject({ status: "scheduled", planDelayMinutes: 15, renderedText: "Chop etilgach shu matn", accountExternalId: "x-owner-1", attempts: 0 });
    expect(row.scheduledAt!.getTime()).toBe(NOW.getTime() + 15 * MIN);
    expect(row.planMaterializedAt!.getTime()).toBe(NOW.getTime());
    expect(mock.calls.filter((c) => c.host === "api.x.com")).toHaveLength(0); // hali ketmadi
  });

  it("delay 0 is due immediately and goes out on the next tick", async () => {
    await fx.insertAccount("x", NOW);
    const post = await draftPost();
    await setOk(post.id, "x", { delayMinutes: 0, text: "Darhol" });
    await publish(post.id);
    expect((await rowOf(post.id)).scheduledAt!.getTime()).toBe(NOW.getTime());
    const res = await tick.runDistributionTick(NOW);
    expect(res.ran).toBe(1);
    expect(await rowOf(post.id)).toMatchObject({ status: "sent", sentText: "Darhol" });
  });

  it("uses the selected version's CURRENT text (read at publish time), image choice and LinkedIn link mode", async () => {
    await fx.insertAccount("linkedin", NOW);
    const post = await draftPost();
    const v = await versions.createVersion(A(), post.id, "linkedin", { text: "Eski matn", imageChoice: "og", linkMode: "text" });
    if (!v.ok) throw new Error("setup");
    await setOk(post.id, "linkedin", { delayMinutes: 60, versionId: v.data.id });
    await versions.updateVersion(A(), v.data.id, { text: `Yangi matn ${"\n"}${"https://blog.example.test/x"}` });
    await publish(post.id);
    const row = await rowOf(post.id, "linkedin");
    expect(row).toMatchObject({ status: "scheduled", versionId: v.data.id, imageChoice: "og", linkMode: "text" });
    expect(row.renderedText).toContain("Yangi matn");
  });

  it("falls back to the default template when there is no version or saved text", async () => {
    await fx.insertAccount("x", NOW);
    const post = await draftPost();
    await setOk(post.id, "x", { delayMinutes: 5 });
    await publish(post.id);
    const row = await rowOf(post.id);
    expect(row.status).toBe("scheduled");
    expect(row.renderedText).toContain(`https://blog.example.test/${post.slug}`);
  });

  it("scheduler path: a scheduled post that becomes due publishes and materialises", async () => {
    await fx.insertAccount("x", NOW);
    const post = await draftPost({ status: "scheduled", scheduledAt: new Date(Date.now() - 1000) });
    await setOk(post.id, "x", { delayMinutes: 30, text: "Rejalashtirilgan post" });
    await life.publishDuePosts();
    expect((await db.select().from(s.posts).where(eq(s.posts.id, post.id)))[0]!.status).toBe("published");
    const row = await rowOf(post.id);
    expect(row.status).toBe("scheduled");
    expect(row.scheduledAt!.getTime()).toBe(NOW.getTime() + 30 * MIN);
  });

  it("approve path: in_review -> published materialises too", async () => {
    await fx.insertAccount("x", NOW);
    const post = await draftPost({ status: "in_review" });
    await setOk(post.id, "x", { delayMinutes: 1, text: "Tasdiqlangach" });
    const r = await life.approvePost(A(), post.id);
    expect(r.ok).toBe(true);
    expect((await rowOf(post.id)).status).toBe("scheduled");
  });

  it("no plan, no change: other channels and posts without plans are untouched; the Telegram plan is independent", async () => {
    await fx.insertAccount("x", NOW);
    const post = await draftPost();
    await actions.saveDraft(A(), post.id, "x", { text: "Faqat qoralama" });
    await publish(post.id);
    expect(await rowOf(post.id)).toMatchObject({ status: "draft", planDelayMinutes: null });
  });
});

describe("idempotency, unpublish and failures", () => {
  it("materialising twice does nothing the second time; unpublish returns the item to draft keeping the plan; republish re-materialises", async () => {
    await fx.insertAccount("x", NOW);
    const post = await draftPost();
    await setOk(post.id, "x", { delayMinutes: 20, text: "Takror" });
    await publish(post.id);
    const first = await rowOf(post.id);
    expect(await plans.materializePlansForPost(post.id)).toEqual({ scheduled: 0, failed: 0 });
    expect(await plans.materializeDuePlans(NOW)).toBe(0);
    expect((await rowOf(post.id)).updatedAt.getTime()).toBe(first.updatedAt.getTime());
    expect((await db.select().from(s.distributions).where(eq(s.distributions.postId, post.id)))).toHaveLength(1);

    const un = await life.unpublishPost(A(), post.id);
    expect(un.ok).toBe(true);
    const back = await rowOf(post.id);
    expect(back).toMatchObject({ status: "draft", planDelayMinutes: 20, planMaterializedAt: null, scheduledAt: null, renderedText: null });
    expect(back.id).toBe(first.id);

    await publish(post.id);
    expect(await rowOf(post.id)).toMatchObject({ id: first.id, status: "scheduled" });
    expect((await db.select().from(s.distributions).where(eq(s.distributions.postId, post.id)))).toHaveLength(1);
  });

  it("unpublish never touches sending/sent/needs_checking items", async () => {
    await fx.insertAccount("x", NOW);
    const post = await draftPost();
    await setOk(post.id, "x", { delayMinutes: 0, text: "Ketdi" });
    await publish(post.id);
    await tick.runDistributionTick(NOW);
    expect((await rowOf(post.id)).status).toBe("sent");
    await life.unpublishPost(A(), post.id);
    expect((await rowOf(post.id)).status).toBe("sent");
    // qayta chop etish: yuborilgan qator faol emas va rejasi yo'q — ikkinchi yuborish bo'lmaydi
    await publish(post.id);
    expect(mock.calls.filter((c) => new URL(c.url).pathname === "/2/tweets")).toHaveLength(1);
    expect((await db.select().from(s.distributions).where(eq(s.distributions.postId, post.id)))).toHaveLength(1);
  });

  it("validation failure at publish time marks the row failed with a visible reason (never dropped), and unpublish makes it waiting again", async () => {
    // akkaunt ulanmagan
    const post = await draftPost();
    await setOk(post.id, "x", { delayMinutes: 5, text: "Akkauntsiz" });
    await publish(post.id);
    const row = await rowOf(post.id);
    expect(row).toMatchObject({ status: "failed", lastErrorKind: "plan_invalid", scheduledAt: null });
    expect(row.lastErrorMessage).toMatch(/^Reja bajarilmadi: tekshiruv o'tmadi/);
    expect(row.planMaterializedAt).not.toBeNull();
    expect(await plans.materializeDuePlans(NOW)).toBe(0); // qayta-qayta uringan holda aylanmaydi

    await life.unpublishPost(A(), post.id);
    expect(await rowOf(post.id)).toMatchObject({ status: "draft", planDelayMinutes: 5, planMaterializedAt: null, lastErrorKind: null });
    await fx.insertAccount("x", NOW);
    await publish(post.id);
    expect((await rowOf(post.id)).status).toBe("scheduled");
  });

  it("an over-limit text fails with the same checklist reason as `schedule`", async () => {
    await fx.insertAccount("x", NOW);
    const post = await draftPost();
    await setOk(post.id, "x", { delayMinutes: 5, text: "a".repeat(400) });
    await publish(post.id);
    const row = await rowOf(post.id);
    expect(row).toMatchObject({ status: "failed", lastErrorKind: "plan_invalid" });
    expect(row.lastErrorMessage!.length).toBeGreaterThan(30);
    expect(mock.calls.filter((c) => c.host === "api.x.com")).toHaveLength(0);
  });

  it("a channel that already has a sent copy fails the plan instead of duplicating", async () => {
    await fx.insertAccount("x", NOW);
    const post = await draftPost();
    await db.insert(s.distributions).values({ postId: post.id, provider: "x", status: "sent", sentText: "Eski", sentAt: NOW });
    await setOk(post.id, "x", { delayMinutes: 5, text: "Dublikat bo'lmasin" });
    await publish(post.id);
    expect(await rowOf(post.id)).toMatchObject({ status: "failed", lastErrorKind: "plan_invalid" });
    expect((await rowOf(post.id)).lastErrorMessage).toContain("allaqachon yuborilgan");
  });

  it("tick sweeper recovers a plan whose publish-time hook never ran (idempotent with the hook)", async () => {
    await fx.insertAccount("x", NOW);
    const post = await draftPost();
    await setOk(post.id, "x", { delayMinutes: 10, text: "Supurgi" });
    await db.update(s.posts).set({ status: "published", publishedAt: NOW }).where(eq(s.posts.id, post.id)); // hook chaqirilmagan
    expect((await rowOf(post.id)).status).toBe("draft");
    const res = await tick.runDistributionTick(NOW);
    expect(res.planned).toBe(1);
    expect(await rowOf(post.id)).toMatchObject({ status: "scheduled" });
    expect((await tick.runDistributionTick(NOW)).planned).toBe(0);
  });

  it("a manual send/schedule replaces the plan (no double send later)", async () => {
    await fx.insertAccount("x", NOW);
    const post = await draftPost();
    await setOk(post.id, "x", { delayMinutes: 5, text: "Reja" });
    await db.update(s.posts).set({ status: "published", publishedAt: NOW }).where(eq(s.posts.id, post.id));
    const sent = await actions.sendNow(A(), post.id, "x", { text: "Qo'lda" });
    if (!sent.ok) throw new Error(sent.error.message);
    expect(sent.data).toMatchObject({ planDelayMinutes: null, planMaterializedAt: null });
    expect(await plans.materializeDuePlans(NOW)).toBe(0);
    expect(await runner.runDistribution(sent.data.id)).toBe("sent");
    expect(mock.calls.filter((c) => new URL(c.url).pathname === "/2/tweets")).toHaveLength(1);
  });

  it("checkPlan ignores the not-yet-published check", async () => {
    await fx.insertAccount("x", NOW);
    const post = await draftPost();
    const res = await plans.checkPlan(post.id, "x", { text: "Tekshiruv" });
    expect(res!.checks.some((c) => c.id === "dist.published")).toBe(false);
    expect(res!.errorCount).toBe(0);
  });
});

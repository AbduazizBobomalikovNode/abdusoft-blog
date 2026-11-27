import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { migrateTestDb } from "../../../test/migrate-test-db.js";

vi.hoisted(() => {
  process.env.DISTRIBUTION_ENABLED = "true";
  process.env.API_ORIGIN = "https://api.example.test";
  process.env.WEB_ORIGIN = "https://blog.example.test";
});

type Svc = {
  actions: typeof import("./actions.js");
  runner: typeof import("./runner.js");
  env: typeof import("./env.js");
  images: typeof import("./images.js");
  prepare: typeof import("./prepare.js");
  fx: typeof import("./fixtures.js");
  sup: typeof import("./test-support.js");
  store: typeof import("../../media/store.js");
};
let svc: Svc;
let db: typeof import("../../../db/index.js").db;
let s: typeof import("../../../db/schema.js");
let mock: ReturnType<typeof import("./test-support.js").createPlatformMock>;
let nowMs = Date.parse("2026-11-26T10:00:00Z");
const now = () => new Date(nowMs);

beforeAll(async () => {
  await migrateTestDb();
  svc = {
    actions: await import("./actions.js"),
    runner: await import("./runner.js"),
    env: await import("./env.js"),
    images: await import("./images.js"),
    prepare: await import("./prepare.js"),
    fx: await import("./fixtures.js"),
    sup: await import("./test-support.js"),
    store: await import("../../media/store.js"),
  };
  ({ db } = await import("../../../db/index.js"));
  s = await import("../../../db/schema.js");
  mock = svc.sup.createPlatformMock();
  svc.env.setDistributionFetch(mock.fetch);
  svc.env.setDistributionClock(now);
  svc.env.setDistributionSleep(async () => undefined);
  svc.images.setSocialImageLoader((url) => svc.sup.fakePreparedImage(url));
});

afterAll(async () => {
  const imgs = await db.select().from(s.distributionImages);
  for (const i of imgs) await svc.store.deleteStoredFile(i.storageKey);
  svc.env.setDistributionFetch(null);
  svc.env.setDistributionClock(null);
});

beforeEach(async () => {
  nowMs = Date.parse("2026-11-26T10:00:00Z");
  mock.reset();
  const imgs = await db.select().from(s.distributionImages);
  for (const i of imgs) await svc.store.deleteStoredFile(i.storageKey);
  await svc.fx.clearAll();
});

const A = () => svc.fx.ADMIN_ACTOR;
const rowOf = async (id: string) => (await db.select().from(s.distributions).where(eq(s.distributions.id, id)))[0]!;
const THREAD_TEXT = "Birinchi tvit\n---\nIkkinchi tvit\n---\nUchinchi tvit";
const send = async (postId: string, input: Record<string, unknown> = { text: THREAD_TEXT, xThread: true }) => {
  const r = await svc.actions.sendNow(A(), postId, "x", input);
  if (!r.ok) throw new Error(`sendNow failed: ${r.error.message}`);
  return r.data;
};
const pathOf = (c: { url: string }) => new URL(c.url).pathname;
const tweetPosts = () => mock.calls.filter((c) => pathOf(c) === "/2/tweets" && c.method === "POST");
const bodyOf = (c: { body: string | Uint8Array | undefined }) => JSON.parse(c.body as string) as { text: string; reply?: { in_reply_to_tweet_id: string }; media?: { media_ids: string[] } };

/** Tvit yaratish mock'i: har chaqiruvda tw-1, tw-2, ...; `failAt` (1-asosli) — shu tartib raqamli so'rov `fail` javobini oladi (id sarflanmaydi). */
function tweetMock(opts: { failAt?: () => number | null; fail?: () => Response | Error } = {}) {
  let n = 0;
  let seen = 0;
  mock.use((c) => {
    if (!(c.path === "/2/tweets" && c.method === "POST")) return undefined;
    seen += 1;
    const failAt = opts.failAt?.() ?? null;
    if (failAt !== null && seen === failAt) return opts.fail?.() ?? new Response(JSON.stringify({ detail: "bad" }), { status: 400 });
    n += 1;
    return new Response(JSON.stringify({ data: { id: `tw-${n}` } }), { status: 201, headers: { "content-type": "application/json" } });
  });
  return { reset: () => { n = 0; seen = 0; } };
}

describe("X thread: sending", () => {
  it("default (thread off) stays ONE tweet with no reply field, even if the text contains ---", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("x", now());
    tweetMock();
    const d = await send(post.id, { text: THREAD_TEXT });
    expect(d).toMatchObject({ xThread: false, xThreadNumbering: false, threadPosted: 0 });
    expect(await svc.runner.runDistribution(d.id)).toBe("sent");
    expect(tweetPosts()).toHaveLength(1);
    expect(bodyOf(tweetPosts()[0]!).reply).toBeUndefined();
    const row = await rowOf(d.id);
    expect(row.threadIds).toBeNull();
  });

  it("happy path: image only on the first tweet, each next tweet replies to the previous one, URL = first tweet", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("x", now());
    tweetMock();
    const d = await send(post.id);
    expect(d).toMatchObject({ xThread: true, status: "scheduled" });
    expect(mock.calls).toHaveLength(0); // so'rov ichida yuborilmaydi
    expect(await svc.runner.runDistribution(d.id)).toBe("sent");
    const posts = tweetPosts().map(bodyOf);
    expect(posts.map((p) => p.text)).toEqual(["Birinchi tvit", "Ikkinchi tvit", "Uchinchi tvit"]);
    expect(posts[0]!.reply).toBeUndefined();
    expect(posts[0]!.media).toEqual({ media_ids: ["media-1"] });
    expect(posts[1]!.reply).toEqual({ in_reply_to_tweet_id: "tw-1" });
    expect(posts[1]!.media).toBeUndefined();
    expect(posts[2]!.reply).toEqual({ in_reply_to_tweet_id: "tw-2" });
    expect(posts[2]!.media).toBeUndefined();
    expect(mock.calls.filter((c) => pathOf(c) === "/2/media/upload")).toHaveLength(1);
    const row = await rowOf(d.id);
    expect(row).toMatchObject({ status: "sent", externalId: "tw-1", partial: null, step: null });
    expect(row.threadIds).toEqual(["tw-1", "tw-2", "tw-3"]);
    expect(row.externalUrl).toBe("https://x.com/owner/status/tw-1");
  });

  it("numbering is part of the frozen text parts and counted in the weight", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("x", now());
    tweetMock();
    const d = await send(post.id, { text: THREAD_TEXT, xThread: true, xThreadNumbering: true });
    await svc.runner.runDistribution(d.id);
    expect(tweetPosts().map((c) => bodyOf(c).text)).toEqual(["Birinchi tvit 1/3", "Ikkinchi tvit 2/3", "Uchinchi tvit 3/3"]);
  });

  it("a long single block is auto-split into a chain of tweets, each within 280", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("x", now());
    tweetMock();
    const long = Array.from({ length: 20 }, (_, i) => `Bu ${i + 1}-gap va u ancha uzun matn.`).join(" ");
    const d = await send(post.id, { text: long, xThread: true });
    await svc.runner.runDistribution(d.id);
    const posts = tweetPosts().map(bodyOf);
    expect(posts.length).toBeGreaterThan(2);
    expect(posts.map((p) => p.text).join(" ")).toBe(long);
    posts.forEach((p, i) => expect(p.reply?.in_reply_to_tweet_id).toBe(i === 0 ? undefined : `tw-${i}`));
  });
});

describe("X thread: partial failure and resume", () => {
  it("failure at part 2: progress persisted, then retry RESUMES at part 2 and never re-posts part 1 (no new media upload either)", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("x", now());
    let failAt: number | null = 2;
    tweetMock({ failAt: () => failAt });
    const d = await send(post.id);
    expect(await svc.runner.runDistribution(d.id)).toBe("failed");
    let row = await rowOf(d.id);
    expect(row).toMatchObject({ status: "failed", lastErrorKind: "validation_rejected", step: "publish" });
    expect(row.threadIds).toEqual(["tw-1"]);
    expect(row.lastErrorMessage).toContain("1 ta tvit yuborilgan");
    expect(row.lastErrorMessage).toContain("2-tvit");
    expect(row.externalId).toBeNull();
    const dto = (await svc.actions.getDistributionDto(d.id))!;
    expect(dto.ok && dto.data).toMatchObject({ threadPosted: 1, canResume: true });

    failAt = null;
    mock.calls.length = 0;
    expect((await svc.actions.retry(A(), d.id)).ok).toBe(true);
    expect(await svc.runner.runDistribution(d.id)).toBe("sent");
    const posts = tweetPosts().map(bodyOf);
    expect(posts.map((p) => p.text)).toEqual(["Ikkinchi tvit", "Uchinchi tvit"]);
    expect(posts[0]!.reply).toEqual({ in_reply_to_tweet_id: "tw-1" });
    expect(posts[0]!.media).toBeUndefined();
    expect(mock.calls.filter((c) => pathOf(c) === "/2/media/upload")).toHaveLength(0);
    row = await rowOf(d.id);
    expect(row).toMatchObject({ status: "sent", externalId: "tw-1" });
    expect(row.threadIds).toEqual(["tw-1", "tw-2", "tw-3"]);
  });

  it("failure at part 1 (nothing posted yet): the uploaded media id is kept for the retry", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("x", now());
    let failAt: number | null = 1;
    tweetMock({ failAt: () => failAt });
    const d = await send(post.id);
    expect(await svc.runner.runDistribution(d.id)).toBe("failed");
    const row = await rowOf(d.id);
    expect(row.threadIds).toBeNull();
    expect(row.partial).toEqual({ mediaId: "media-1" });
    failAt = null;
    mock.calls.length = 0;
    await svc.actions.retry(A(), d.id);
    expect(await svc.runner.runDistribution(d.id)).toBe("sent");
    expect(mock.calls.filter((c) => pathOf(c) === "/2/media/upload")).toHaveLength(0);
    expect(bodyOf(tweetPosts()[0]!).media).toEqual({ media_ids: ["media-1"] });
  });

  it("rate limit at part 2 -> automatic retry later resumes from part 2", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("x", now());
    let failAt: number | null = 2;
    tweetMock({ failAt: () => failAt, fail: () => new Response("{}", { status: 429, headers: { "content-type": "application/json" } }) });
    const d = await send(post.id);
    expect(await svc.runner.runDistribution(d.id)).toBe("retry");
    expect((await rowOf(d.id)).threadIds).toEqual(["tw-1"]);
    failAt = null;
    mock.calls.length = 0;
    nowMs += 3_600_000;
    expect(await svc.runner.runDueDistributions(now())).toBe(1);
    expect(tweetPosts().map((c) => bodyOf(c).text)).toEqual(["Ikkinchi tvit", "Uchinchi tvit"]);
    const row = await rowOf(d.id);
    expect(row).toMatchObject({ status: "sent" });
    expect(row.threadIds).toEqual(["tw-1", "tw-2", "tw-3"]);
  });

  it("ambiguous failure (5xx / timeout) at part 2 -> needs_checking, never auto-retried, posted ids kept; human retry resumes after the known parts", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("x", now());
    let failAt: number | null = 2;
    tweetMock({ failAt: () => failAt, fail: () => new Response("{}", { status: 502 }) });
    const d = await send(post.id);
    expect(await svc.runner.runDistribution(d.id)).toBe("needs_checking");
    let row = await rowOf(d.id);
    expect(row).toMatchObject({ status: "needs_checking", lastErrorKind: "outcome_unknown" });
    expect(row.threadIds).toEqual(["tw-1"]);
    mock.calls.length = 0;
    nowMs += 24 * 3_600_000;
    expect(await svc.runner.runDueDistributions(now())).toBe(0);
    expect(mock.calls).toHaveLength(0);
    // odam platformada tekshirib, bilib turib qayta uradi -> 2-qismdan davom etadi
    failAt = null;
    expect((await svc.actions.resolveNeedsChecking(A(), d.id, { action: "retry", confirmDuplicateRisk: true })).ok).toBe(true);
    expect(await svc.runner.runDistribution(d.id)).toBe("sent");
    expect(tweetPosts().map((c) => bodyOf(c).text)).toEqual(["Ikkinchi tvit", "Uchinchi tvit"]);
    row = await rowOf(d.id);
    expect(row.threadIds).toEqual(["tw-1", "tw-2", "tw-3"]);
  });

  it("timeout at part 2 is also needs_checking", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("x", now());
    tweetMock({ failAt: () => 2, fail: () => new Error("socket hang up") });
    const d = await send(post.id);
    expect(await svc.runner.runDistribution(d.id)).toBe("needs_checking");
    expect((await rowOf(d.id)).threadIds).toEqual(["tw-1"]);
  });

  it("text and thread mode are frozen once a part is on the platform (draft save conflicts; send ignores new text)", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("x", now());
    let failAt: number | null = 2;
    tweetMock({ failAt: () => failAt });
    const d = await send(post.id);
    await svc.runner.runDistribution(d.id);
    const saved = await svc.actions.saveDraft(A(), post.id, "x", { text: "Butunlay boshqa matn" });
    expect(saved.ok).toBe(false);
    failAt = null;
    mock.calls.length = 0;
    const r = await svc.actions.sendNow(A(), post.id, "x", { text: "Butunlay boshqa matn", xThread: false });
    expect(r.ok).toBe(true);
    expect(await svc.runner.runDistribution(d.id)).toBe("sent");
    expect(tweetPosts().map((c) => bodyOf(c).text)).toEqual(["Ikkinchi tvit", "Uchinchi tvit"]);
  });
});

describe("X thread: removal", () => {
  it("deletes ALL posted parts in reverse order", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("x", now());
    tweetMock();
    const d = await send(post.id);
    await svc.runner.runDistribution(d.id);
    mock.calls.length = 0;
    const r = await svc.actions.removeFromPlatform(A(), d.id);
    expect(r.ok).toBe(true);
    expect(mock.calls.map((c) => `${c.method} ${pathOf(c)}`)).toEqual(["DELETE /2/tweets/tw-3", "DELETE /2/tweets/tw-2", "DELETE /2/tweets/tw-1"]);
    const row = await rowOf(d.id);
    expect(row.status).toBe("cancelled");
    expect(row.removedAt).not.toBeNull();
    expect(row.threadIds).toEqual([]);
  });

  it("a delete failure midway keeps the remaining ids; the next attempt deletes only those", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("x", now());
    tweetMock();
    const d = await send(post.id);
    await svc.runner.runDistribution(d.id);
    let breakId: string | null = "tw-2";
    mock.use((c) => (c.method === "DELETE" && breakId && c.path === `/2/tweets/${breakId}` ? new Response("{}", { status: 500 }) : undefined));
    mock.calls.length = 0;
    const r1 = await svc.actions.removeFromPlatform(A(), d.id);
    expect(r1.ok).toBe(false);
    expect((await rowOf(d.id)).status).toBe("sent");
    expect((await rowOf(d.id)).threadIds).toEqual(["tw-1", "tw-2"]);
    breakId = null;
    mock.calls.length = 0;
    expect((await svc.actions.removeFromPlatform(A(), d.id)).ok).toBe(true);
    expect(mock.calls.map((c) => `${c.method} ${pathOf(c)}`)).toEqual(["DELETE /2/tweets/tw-2", "DELETE /2/tweets/tw-1"]);
  });

  it("a single (non-thread) tweet is still removed by externalId", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("x", now());
    tweetMock();
    const d = await send(post.id, { text: "Oddiy" });
    await svc.runner.runDistribution(d.id);
    mock.calls.length = 0;
    expect((await svc.actions.removeFromPlatform(A(), d.id)).ok).toBe(true);
    expect(mock.calls.map((c) => `${c.method} ${pathOf(c)}`)).toEqual(["DELETE /2/tweets/tw-1"]);
  });
});

describe("X thread: validation and checklist", () => {
  it("thread off: the single-tweet 280 limit is unchanged; a --- line only warns", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("x", now());
    const long = await svc.prepare.buildPreview(post.id, "x", { overrides: { text: "a ".repeat(200) } });
    expect(long!.canSend).toBe(false);
    expect(long!.threadParts).toBeNull();
    const sep = await svc.prepare.buildPreview(post.id, "x", { overrides: { text: "A\n---\nB" } });
    expect(sep!.canSend).toBe(true);
    expect(sep!.checks.find((c) => c.id === "x.thread.separator")?.status).toBe("warn");
  });

  it("thread on: the same long text becomes a valid chain; preview exposes the parts", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("x", now());
    const p = await svc.prepare.buildPreview(post.id, "x", { overrides: { text: "a ".repeat(200), xThread: true, xThreadNumbering: true } });
    expect(p!.canSend).toBe(true);
    expect(p!.xThread).toBe(true);
    expect(p!.threadParts!.length).toBeGreaterThan(1);
    expect(p!.threadParts!.every((x) => x.weight <= 280 && !x.over)).toBe(true);
    expect(p!.checks.find((c) => c.id === "x.thread.count")?.status).toBe("ok");
  });

  it("more than 15 tweets is an error and nothing is queued", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("x", now());
    const text = Array.from({ length: 16 }, (_, i) => `t${i}`).join("\n---\n");
    const p = await svc.prepare.buildPreview(post.id, "x", { overrides: { text, xThread: true } });
    expect(p!.canSend).toBe(false);
    expect(p!.checks.find((c) => c.id === "x.thread.count")).toMatchObject({ status: "error", value: "16 ta", limit: "15 ta" });
    const r = await svc.actions.sendNow(A(), post.id, "x", { text, xThread: true });
    expect(r.ok).toBe(false);
    expect(await db.select().from(s.distributions)).toHaveLength(0);
  });

  it("thread mode is X only", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("linkedin", now());
    const r = await svc.actions.saveDraft(A(), post.id, "linkedin", { xThread: true });
    expect(r.ok).toBe(false);
    expect((await svc.actions.saveDraft(A(), post.id, "linkedin", { xThread: false })).ok).toBe(true);
  });
});

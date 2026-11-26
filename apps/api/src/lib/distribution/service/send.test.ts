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
  rows: typeof import("./rows.js");
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
    rows: await import("./rows.js"),
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
  svc.runner; // eslint-disable-line @typescript-eslint/no-unused-expressions
  const imgs = await db.select().from(s.distributionImages);
  for (const i of imgs) await svc.store.deleteStoredFile(i.storageKey);
  await svc.fx.clearAll();
});

const A = () => svc.fx.ADMIN_ACTOR;
const rowOf = async (id: string) => (await db.select().from(s.distributions).where(eq(s.distributions.id, id)))[0]!;
const send = async (postId: string, provider: "linkedin" | "x" | "threads" | "instagram" | "github", input = {}) => {
  const r = await svc.actions.sendNow(A(), postId, provider, input);
  if (!r.ok) throw new Error(`sendNow failed: ${r.error.message}`);
  return r.data;
};
const callPaths = () => mock.calls.map((c) => `${c.method} ${c.host}${new URL(c.url).pathname}`);

describe("send success — documented multi-step sequences per provider", () => {
  it("LinkedIn article: initializeUpload -> PUT bytes -> POST /rest/posts; stored as sent with the post URL", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("linkedin", now());
    const d = await send(post.id, "linkedin");
    expect(d.status).toBe("scheduled"); // so'rov ichida yuborilmaydi
    expect(mock.calls).toHaveLength(0);
    expect(await svc.runner.runDistribution(d.id)).toBe("sent");
    expect(callPaths()).toEqual(["POST api.linkedin.com/rest/images", "PUT www.linkedin.com/dms-uploads/upload-1", "POST api.linkedin.com/rest/posts"]);
    const body = JSON.parse(mock.calls[2]!.body as string);
    expect(body.content.article.source).toContain("https://blog.example.test/");
    expect(body.content.article.thumbnail).toBe("urn:li:image:IMG1");
    expect(mock.calls[1]!.headers["content-type"]).toBe("image/jpeg");
    const row = await rowOf(d.id);
    expect(row).toMatchObject({ status: "sent", externalId: "urn:li:share:7000001", attempts: 1, step: null });
    expect(row.externalUrl).toContain("linkedin.com");
    expect(row.sentText).toBe(row.sentText && row.sentText.length > 0 ? row.sentText : "x");
  });

  it("LinkedIn text mode: no image upload; the link is in the commentary", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("linkedin", now());
    const d = await send(post.id, "linkedin", { linkMode: "text" });
    await svc.runner.runDistribution(d.id);
    expect(callPaths()).toEqual(["POST api.linkedin.com/rest/posts"]);
    const body = JSON.parse(mock.calls[0]!.body as string);
    expect(body.commentary).toContain(`https://blog.example.test/${post.slug}`);
    expect(body.content).toBeUndefined();
  });

  it("X: media upload then tweet with media id", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("x", now());
    const d = await send(post.id, "x");
    expect(await svc.runner.runDistribution(d.id)).toBe("sent");
    expect(callPaths()).toEqual(["POST api.x.com/2/media/upload", "POST api.x.com/2/tweets"]);
    expect(JSON.parse(mock.calls[1]!.body as string).media.media_ids).toEqual(["media-1"]);
    expect((await rowOf(d.id)).externalUrl).toBe("https://x.com/owner/status/tweet-1");
  });

  it("Threads: text post, image comes from the blog's own public storage URL (cached per post)", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("threads", now());
    const d = await send(post.id, "threads");
    expect(await svc.runner.runDistribution(d.id)).toBe("sent");
    expect(callPaths()).toEqual(["POST graph.threads.com/v1.0/T1/threads", "GET graph.threads.com/v1.0/TC1", "POST graph.threads.com/v1.0/T1/threads_publish", "GET graph.threads.com/v1.0/TM1"]);
    const form = Object.fromEntries(new URLSearchParams(mock.calls[0]!.body as string));
    expect(form.media_type).toBe("IMAGE");
    expect(form.image_url).toMatch(/^https:\/\/api\.example\.test\/uploads\/.+\.jpg$/);
    const imgs = await db.select().from(s.distributionImages);
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.url).toBe(form.image_url);
  });

  it("Instagram: container -> status -> media_publish", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("instagram", now());
    const d = await send(post.id, "instagram");
    expect(await svc.runner.runDistribution(d.id)).toBe("sent");
    expect(callPaths()).toEqual(["POST graph.facebook.com/v27.0/IG1/media", "GET graph.facebook.com/v27.0/5001", "POST graph.facebook.com/v27.0/IG1/media_publish", "GET graph.facebook.com/v27.0/6001"]);
    expect((await rowOf(d.id)).externalUrl).toBe("https://www.instagram.com/p/6001/");
  });

  it("GitHub: regenerates the block from the N most recent published posts (full list, newest first)", async () => {
    const a = await svc.fx.insertPost({ title: "Birinchi", publishedAt: new Date("2026-11-01T00:00:00Z") });
    const b = await svc.fx.insertPost({ title: "Ikkinchi", publishedAt: new Date("2026-11-10T00:00:00Z") });
    const c = await svc.fx.insertPost({ title: "Uchinchi", publishedAt: new Date("2026-11-20T00:00:00Z") });
    await svc.fx.insertPost({ title: "Qoralama", status: "draft", publishedAt: null });
    await svc.fx.insertAccount("github", now());
    const d = await send(a.id, "github");
    expect(await svc.runner.runDistribution(d.id)).toBe("sent");
    expect(callPaths()).toEqual(["GET api.github.com/repos/owner/owner/contents/README.md", "PUT api.github.com/repos/owner/owner/contents/README.md"]);
    const put = JSON.parse(mock.calls[1]!.body as string);
    const content = Buffer.from(put.content, "base64").toString("utf8");
    expect(content).toContain("# Salom");
    expect(content).not.toContain("- eski");
    expect(content.indexOf("Uchinchi")).toBeLessThan(content.indexOf("Ikkinchi"));
    expect(content.indexOf("Ikkinchi")).toBeLessThan(content.indexOf("Birinchi"));
    expect(content).not.toContain("Qoralama");
    expect(put.sha).toBe("readme-sha-1");
    void b;
    void c;
    expect((await rowOf(d.id)).externalUrl).toContain("github.com");
  });
});

describe("error classes -> status and retry behaviour", () => {
  async function linkedinFailsWith(res: Response | Error, opts: { text?: boolean } = {}) {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("linkedin", now());
    mock.use((c) => (c.host === "api.linkedin.com" && c.path === "/rest/posts" && c.method === "POST" ? res : undefined));
    const d = await send(post.id, "linkedin", opts.text ? { linkMode: "text" } : {});
    const outcome = await svc.runner.runDistribution(d.id);
    return { d, outcome, row: await rowOf(d.id), post };
  }
  const resp = (status: number, body: unknown = { message: "x" }, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  it("401 -> failed(auth_expired) + account must be reconnected", async () => {
    const { outcome, row } = await linkedinFailsWith(resp(401));
    expect(outcome).toBe("failed");
    expect(row).toMatchObject({ status: "failed", lastErrorKind: "auth_expired" });
    const acc = (await db.select().from(s.distributionAccounts))[0]!;
    expect(acc.status).toBe("reauth_required");
  });
  it("403 -> failed(permission_missing), no automatic retry", async () => {
    const { outcome, row } = await linkedinFailsWith(resp(403));
    expect(outcome).toBe("failed");
    expect(row.lastErrorKind).toBe("permission_missing");
    expect(row.nextAttemptAt).toBeNull();
  });
  it("422 duplicate -> failed(duplicate_content)", async () => {
    const { row } = await linkedinFailsWith(resp(422, { message: "Content is a duplicate of urn:li:share:1" }));
    expect(row).toMatchObject({ status: "failed", lastErrorKind: "duplicate_content" });
  });
  it("400 -> failed(validation_rejected) with a safe message", async () => {
    const { row } = await linkedinFailsWith(resp(400, { message: "bad commentary" }));
    expect(row).toMatchObject({ status: "failed", lastErrorKind: "validation_rejected" });
    expect(row.lastErrorMessage).toContain("bad commentary");
  });
  it("429 -> rate_limited: scheduled again after the platform's retry-after, bounded attempts", async () => {
    const { outcome, row } = await linkedinFailsWith(resp(429, { message: "limit" }, { "retry-after": "600" }));
    expect(outcome).toBe("retry");
    expect(row).toMatchObject({ status: "scheduled", lastErrorKind: "rate_limited", attempts: 1 });
    expect(row.nextAttemptAt!.getTime() - nowMs).toBe(600_000);
    // vaqti kelmaguncha tick hech narsa qilmaydi
    mock.reset();
    expect(await svc.runner.runDueDistributions(now())).toBe(0);
    expect(mock.calls).toHaveLength(0);
  });
  it("transient (5xx before the create step) -> exponential backoff then failed after the bound", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("linkedin", now());
    mock.use((c) => (c.host === "api.linkedin.com" && c.path === "/rest/images" ? new Response("{}", { status: 503 }) : undefined));
    const d = await send(post.id, "linkedin");
    const waits: number[] = [];
    for (let i = 0; i < svc.runner.MAX_AUTO_ATTEMPTS; i++) {
      const out = await svc.runner.runDistribution(d.id, now());
      const row = await rowOf(d.id);
      if (i < svc.runner.MAX_AUTO_ATTEMPTS - 1) {
        expect(out).toBe("retry");
        waits.push(row.nextAttemptAt!.getTime() - nowMs);
        nowMs = row.nextAttemptAt!.getTime();
      } else {
        expect(out).toBe("failed");
        expect(row).toMatchObject({ status: "failed", attempts: svc.runner.MAX_AUTO_ATTEMPTS, lastErrorKind: "transient", step: "init" });
        expect(row.nextAttemptAt).toBeNull();
      }
    }
    expect(waits).toEqual([60_000, 300_000, 900_000, 3_600_000]);
    mock.reset();
    nowMs += 10 * 3_600_000;
    expect(await svc.runner.runDueDistributions(now())).toBe(0); // chegaradan keyin avtomatik urinish yo'q
  });
  it("5xx on the create step -> outcome_unknown -> needs_checking and NEVER retried automatically", async () => {
    const { outcome, row } = await linkedinFailsWith(resp(500));
    expect(outcome).toBe("needs_checking");
    expect(row).toMatchObject({ status: "needs_checking", lastErrorKind: "outcome_unknown" });
    mock.reset();
    nowMs += 24 * 3_600_000;
    expect(await svc.runner.runDueDistributions(now())).toBe(0);
    expect(mock.calls).toHaveLength(0);
  });
  it("timeout/dropped connection on create -> needs_checking too", async () => {
    const { row } = await linkedinFailsWith(new Error("socket hang up"));
    expect(row).toMatchObject({ status: "needs_checking", lastErrorKind: "outcome_unknown" });
  });
  it("X payment_required (402) -> failed, not retried", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("x", now());
    mock.use((c) => (c.path === "/2/tweets" && c.method === "POST" ? resp(402, { title: "CreditsDepleted" }) : undefined));
    const d = await send(post.id, "x");
    await svc.runner.runDistribution(d.id);
    expect(await rowOf(d.id)).toMatchObject({ status: "failed", lastErrorKind: "payment_required" });
  });
  it("secrets never end up in the stored error message", async () => {
    const { row } = await linkedinFailsWith(resp(400, { message: `rejected token ${"LI-ACCESS-TOKEN-0001"} for Bearer LI-ACCESS-TOKEN-0001` }));
    expect(row.lastErrorMessage).not.toContain("LI-ACCESS-TOKEN-0001");
  });
  it("evil upload host from the platform -> refused before any request to it (allow-list)", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("linkedin", now());
    mock.use((c) => (c.path === "/rest/images" ? new Response(JSON.stringify({ value: { uploadUrl: "https://evil.example.org/dms-uploads/x", image: "urn:li:image:IMG1" } }), { status: 200, headers: { "content-type": "application/json" } }) : undefined));
    const d = await send(post.id, "linkedin");
    await svc.runner.runDistribution(d.id);
    expect((await rowOf(d.id)).status).toBe("failed");
    expect(mock.calls.some((c) => c.host === "evil.example.org")).toBe(false);
  });
});

describe("resume from partial", () => {
  it("LinkedIn: image uploaded, create rate-limited -> retry reuses the image URN (no second upload)", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("linkedin", now());
    let limited = true;
    mock.use((c) => (limited && c.path === "/rest/posts" && c.method === "POST" ? new Response("{}", { status: 429, headers: { "retry-after": "60" } }) : undefined));
    const d = await send(post.id, "linkedin");
    await svc.runner.runDistribution(d.id);
    let row = await rowOf(d.id);
    expect(row).toMatchObject({ status: "scheduled", step: "publish", partial: { imageUrn: "urn:li:image:IMG1" } });
    limited = false;
    mock.calls.length = 0;
    nowMs += 120_000;
    expect(await svc.runner.runDueDistributions(now())).toBe(1);
    expect(callPaths()).toEqual(["POST api.linkedin.com/rest/posts"]);
    row = await rowOf(d.id);
    expect(row).toMatchObject({ status: "sent", attempts: 2, partial: null });
  });
  it("Instagram: container made, publish fails permanently -> manual retry resumes with the container", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("instagram", now());
    let fail = true;
    mock.use((c) => (fail && c.path.endsWith("/media_publish") ? new Response(JSON.stringify({ error: { message: "nope", code: 100 } }), { status: 400 }) : undefined));
    const d = await send(post.id, "instagram");
    await svc.runner.runDistribution(d.id);
    expect(await rowOf(d.id)).toMatchObject({ status: "failed", step: "publish", partial: { containerId: "5001" } });
    fail = false;
    mock.calls.length = 0;
    const r = await svc.actions.retry(A(), d.id);
    expect(r.ok).toBe(true);
    await svc.runner.runDistribution(d.id);
    expect(callPaths()).toEqual(["GET graph.facebook.com/v27.0/5001", "POST graph.facebook.com/v27.0/IG1/media_publish", "GET graph.facebook.com/v27.0/6001"]);
    expect((await rowOf(d.id)).status).toBe("sent");
  });
  it("X: media uploaded, tweet fails -> failed keeps mediaId", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("x", now());
    mock.use((c) => (c.path === "/2/tweets" && c.method === "POST" ? new Response(JSON.stringify({ detail: "bad" }), { status: 400 }) : undefined));
    const d = await send(post.id, "x");
    await svc.runner.runDistribution(d.id);
    expect(await rowOf(d.id)).toMatchObject({ status: "failed", partial: { mediaId: "media-1" } });
  });
});

describe("double-send prevention", () => {
  it("parallel send requests -> one distribution, one platform post", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("x", now());
    const results = await Promise.all([svc.actions.sendNow(A(), post.id, "x"), svc.actions.sendNow(A(), post.id, "x"), svc.actions.sendNow(A(), post.id, "x")]);
    expect(results.some((r) => r.ok)).toBe(true);
    const rows = await db.select().from(s.distributions);
    expect(rows).toHaveLength(1);
    const outcomes = await Promise.all([svc.runner.runDistribution(rows[0]!.id), svc.runner.runDistribution(rows[0]!.id), svc.runner.runDueDistributions(now())]);
    void outcomes;
    expect(mock.calls.filter((c) => new URL(c.url).pathname === "/2/tweets" && c.method === "POST")).toHaveLength(1);
    expect((await rowOf(rows[0]!.id)).status).toBe("sent");
  });
  it("the unique index forbids two active distributions of one post+channel", async () => {
    const post = await svc.fx.insertPost();
    await db.insert(s.distributions).values({ postId: post.id, provider: "x" });
    await expect(db.insert(s.distributions).values({ postId: post.id, provider: "x", status: "scheduled" })).rejects.toThrow();
    await db.insert(s.distributions).values({ postId: post.id, provider: "threads" }); // boshqa kanal — mumkin
  });
  it("a second send after success needs an explicit 'again' (duplicate protection)", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("x", now());
    const d = await send(post.id, "x");
    await svc.runner.runDistribution(d.id);
    const again = await svc.actions.sendNow(A(), post.id, "x");
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.extra?.code).toBe("already_sent");
    const forced = await svc.actions.sendNow(A(), post.id, "x", { again: true });
    expect(forced.ok).toBe(true);
  });
});

describe("scheduling, cancel, preflight gating", () => {
  it("schedule: nothing before the time, sent once after; cancel prevents sending", async () => {
    const post = await svc.fx.insertPost();
    const post2 = await svc.fx.insertPost();
    await svc.fx.insertAccount("x", now());
    const at = new Date(nowMs + 3_600_000);
    const r1 = await svc.actions.schedule(A(), post.id, "x", at);
    const r2 = await svc.actions.schedule(A(), post2.id, "x", at);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(await svc.runner.runDueDistributions(now())).toBe(0);
    const cancelled = await svc.actions.cancel(A(), r2.data.id);
    expect(cancelled.ok).toBe(true);
    nowMs += 3_600_001;
    expect(await svc.runner.runDueDistributions(now())).toBe(1);
    expect((await rowOf(r1.data.id)).status).toBe("sent");
    expect((await rowOf(r2.data.id)).status).toBe("cancelled");
    expect(mock.calls.filter((c) => new URL(c.url).pathname === "/2/tweets")).toHaveLength(1);
  });
  it("rejects past/too-far times and cannot cancel what is sending or sent", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("x", now());
    expect((await svc.actions.schedule(A(), post.id, "x", new Date(nowMs - 1000))).ok).toBe(false);
    expect((await svc.actions.schedule(A(), post.id, "x", new Date(nowMs + 400 * 86_400_000))).ok).toBe(false);
    const d = await send(post.id, "x");
    await svc.runner.runDistribution(d.id);
    const c = await svc.actions.cancel(A(), d.id);
    expect(c.ok).toBe(false);
  });
  it("preflight errors block queueing: nothing is stored as scheduled and nothing is sent", async () => {
    const post = await svc.fx.insertPost();
    // akkaunt ulanmagan
    const r = await svc.actions.sendNow(A(), post.id, "linkedin");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("unprocessable");
    // matn uzun
    await svc.fx.insertAccount("x", now());
    const long = await svc.actions.sendNow(A(), post.id, "x", { text: "a".repeat(300) });
    expect(long.ok).toBe(false);
    // chop etilmagan post
    const draft = await svc.fx.insertPost({ status: "draft", publishedAt: null });
    expect((await svc.actions.sendNow(A(), draft.id, "x")).ok).toBe(false);
    expect(await db.select().from(s.distributions)).toHaveLength(0);
    expect(mock.calls).toHaveLength(0);
  });
  it("a post unpublished after scheduling is not sent", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("x", now());
    const d = await send(post.id, "x");
    await db.update(s.posts).set({ status: "draft" }).where(eq(s.posts.id, post.id));
    await svc.runner.runDistribution(d.id);
    expect(await rowOf(d.id)).toMatchObject({ status: "failed", lastErrorKind: "validation_rejected" });
    expect(mock.calls).toHaveLength(0);
  });
});

describe("needs checking resolution", () => {
  async function makeNeedsChecking() {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("x", now());
    mock.use((c) => (c.path === "/2/tweets" && c.method === "POST" ? new Response("{}", { status: 502 }) : undefined));
    const d = await send(post.id, "x");
    await svc.runner.runDistribution(d.id);
    expect((await rowOf(d.id)).status).toBe("needs_checking");
    return d;
  }
  it("retry() refuses; mark_sent needs a public https URL", async () => {
    const d = await makeNeedsChecking();
    expect((await svc.actions.retry(A(), d.id)).ok).toBe(false);
    expect((await svc.actions.cancel(A(), d.id)).ok).toBe(false);
    expect((await svc.actions.resolveNeedsChecking(A(), d.id, { action: "mark_sent", url: "http://x.com/1" })).ok).toBe(false);
    const ok = await svc.actions.resolveNeedsChecking(A(), d.id, { action: "mark_sent", url: "https://x.com/owner/status/123" });
    expect(ok.ok).toBe(true);
    expect(await rowOf(d.id)).toMatchObject({ status: "sent", externalUrl: "https://x.com/owner/status/123" });
  });
  it("knowing retry requires confirmation and then runs again (resume)", async () => {
    const d = await makeNeedsChecking();
    expect((await svc.actions.resolveNeedsChecking(A(), d.id, { action: "retry", confirmDuplicateRisk: false })).ok).toBe(false);
    mock.reset();
    const r = await svc.actions.resolveNeedsChecking(A(), d.id, { action: "retry", confirmDuplicateRisk: true });
    expect(r.ok).toBe(true);
    await svc.runner.runDistribution(d.id);
    expect((await rowOf(d.id)).status).toBe("sent");
  });
  it("not_posted closes it and frees the channel for a new distribution", async () => {
    const d = await makeNeedsChecking();
    expect((await svc.actions.resolveNeedsChecking(A(), d.id, { action: "not_posted" })).ok).toBe(true);
    expect((await rowOf(d.id)).status).toBe("cancelled");
    expect((await svc.actions.saveDraft(A(), d.postId, "x", { text: "yangi" })).ok).toBe(true);
  });
  it("a crashed 'sending' row becomes needs_checking, never auto-retried", async () => {
    const post = await svc.fx.insertPost();
    const [row] = await db.insert(s.distributions).values({ postId: post.id, provider: "x", status: "sending" }).returning();
    expect(await svc.runner.recoverInterruptedDistributions(now(), true)).toBe(1);
    expect((await rowOf(row!.id)).status).toBe("needs_checking");
    expect(await svc.runner.runDueDistributions(now())).toBe(0);
  });
});

describe("removal", () => {
  it("LinkedIn: DELETE the post; row becomes cancelled with removedAt", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("linkedin", now());
    const d = await send(post.id, "linkedin");
    await svc.runner.runDistribution(d.id);
    mock.calls.length = 0;
    const r = await svc.actions.removeFromPlatform(A(), d.id);
    expect(r.ok).toBe(true);
    expect(callPaths()).toEqual(["DELETE api.linkedin.com/rest/posts/urn%3Ali%3Ashare%3A7000001"]);
    const row = await rowOf(d.id);
    expect(row.status).toBe("cancelled");
    expect(row.removedAt).not.toBeNull();
  });
  it("Instagram / GitHub: not supported -> explained, nothing called", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("instagram", now());
    const d = await send(post.id, "instagram");
    await svc.runner.runDistribution(d.id);
    mock.calls.length = 0;
    const r = await svc.actions.removeFromPlatform(A(), d.id);
    expect(r.ok).toBe(false);
    expect(mock.calls).toHaveLength(0);
  });
});

describe("image preparation and caching", () => {
  it("falls back to the site's OG image (own web origin) when there is no cover", async () => {
    const post = await svc.fx.insertPost({ coverUrl: null });
    const seen: string[] = [];
    svc.images.setSocialImageLoader((url) => {
      seen.push(url);
      return svc.sup.fakePreparedImage(url, 1200, 630);
    });
    await svc.fx.insertAccount("linkedin", now());
    const p = await svc.prepare.buildPreview(post.id, "linkedin");
    expect(p!.image.source).toBe("og");
    expect(seen).toEqual([`https://blog.example.test/${post.slug}/opengraph-image-${svc.images.OG_IMAGE_ROUTE_SUFFIX}`]);
    svc.images.setSocialImageLoader((url) => svc.sup.fakePreparedImage(url));
  });
  it("surfaces in preflight when the image cannot be produced (Instagram: error, X: warning)", async () => {
    const post = await svc.fx.insertPost();
    svc.images.setSocialImageLoader(async (url) => ({ ok: false, url, error: "yuklab bo'lmadi", kind: "unreachable" as const }));
    await svc.fx.insertAccount("instagram", now());
    await svc.fx.insertAccount("x", now());
    const ig = await svc.prepare.buildPreview(post.id, "instagram");
    expect(ig!.canSend).toBe(false);
    expect(ig!.checks.some((c) => c.id === "dist.image" && c.status === "error")).toBe(true);
    const x = await svc.prepare.buildPreview(post.id, "x");
    expect(x!.canSend).toBe(true);
    expect(x!.checks.some((c) => c.id === "dist.image" && c.status === "warn")).toBe(true);
    svc.images.setSocialImageLoader((url) => svc.sup.fakePreparedImage(url));
  });
  it("is cached per post: same image -> one stored file; a changed image replaces the old cache row", async () => {
    const post = await svc.fx.insertPost();
    const image = await svc.images.prepareSocialImage(post, "cover");
    if (!image || !image.ok) throw new Error("image");
    const u1 = await svc.images.ensurePublicImageUrl(post.id, image);
    const u2 = await svc.images.ensurePublicImageUrl(post.id, image);
    expect(u1).toBe(u2);
    expect(await db.select().from(s.distributionImages)).toHaveLength(1);
    svc.images.setSocialImageLoader((url) => svc.sup.fakePreparedImage(url, 800, 800));
    const image2 = await svc.images.prepareSocialImage(post, "cover");
    if (!image2 || !image2.ok) throw new Error("image2");
    const u3 = await svc.images.ensurePublicImageUrl(post.id, image2);
    expect(u3).not.toBe(u1);
    expect(await db.select().from(s.distributionImages)).toHaveLength(1);
    svc.images.setSocialImageLoader((url) => svc.sup.fakePreparedImage(url));
  });
  it("crops to the allowed aspect ratio and caps the long side", async () => {
    const post = await svc.fx.insertPost();
    svc.images.setSocialImageLoader((url) => svc.sup.fakePreparedImage(url, 3000, 600)); // 5:1
    const image = await svc.images.prepareSocialImage(post, "cover");
    if (!image || !image.ok) throw new Error("image");
    expect(image.width / image.height).toBeLessThanOrEqual(1.91 + 0.01);
    expect(image.width).toBeLessThanOrEqual(1440);
    svc.images.setSocialImageLoader((url) => svc.sup.fakePreparedImage(url));
  });
});

describe("audit entries", () => {
  it("one entry per action and outcome, and never any token or secret", async () => {
    const post = await svc.fx.insertPost();
    await svc.fx.insertAccount("x", now());
    const d = await send(post.id, "x", { text: "Salom dunyo" });
    await svc.runner.runDistribution(d.id);
    await svc.actions.sendNow(A(), post.id, "x", { again: true });
    const rows = await db.select().from(s.auditLog);
    const actions = rows.map((r) => r.action).sort();
    expect(actions).toEqual(["distribution.send", "distribution.send", "distribution.sent"]);
    const dump = JSON.stringify(rows);
    for (const secret of Object.values(svc.sup.TOKENS)) expect(dump).not.toContain(secret);
  });
});

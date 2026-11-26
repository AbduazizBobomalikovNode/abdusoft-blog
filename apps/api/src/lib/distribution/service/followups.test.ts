import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { migrateTestDb } from "../../../test/migrate-test-db.js";

vi.hoisted(() => {
  process.env.DISTRIBUTION_ENABLED = "true";
  process.env.API_ORIGIN = "https://api.example.test";
  process.env.WEB_ORIGIN = "https://blog.example.test";
});

const notices: string[] = [];
vi.mock("./notify.js", async () => {
  const actual = await vi.importActual<typeof import("./notify.js")>("./notify.js");
  return {
    ...actual,
    notifyOwner: async (text: string) => {
      notices.push(text);
      return "sent" as const;
    },
  };
});

let actions: typeof import("./actions.js");
let runner: typeof import("./runner.js");
let env: typeof import("./env.js");
let fx: typeof import("./fixtures.js");
let sup: typeof import("./test-support.js");
let prepare: typeof import("./prepare.js");
let db: typeof import("../../../db/index.js").db;
let s: typeof import("../../../db/schema.js");
let mock: ReturnType<typeof import("./test-support.js").createPlatformMock>;
const T0 = Date.parse("2026-11-26T10:00:00Z");
let nowMs = T0;
const now = () => new Date(nowMs);

const rowOf = async (id: string) => (await db.select().from(s.distributions).where(eq(s.distributions.id, id)))[0]!;
const A = () => fx.ADMIN_ACTOR;
const tweets = () => mock.calls.filter((c) => c.host === "api.x.com" && new URL(c.url).pathname === "/2/tweets" && c.method === "POST");
const tweetText = (i: number) => JSON.parse(tweets()[i]!.body as string).text as string;
const isTweetPost = (c: { host: string; path: string; method: string }) => c.host === "api.x.com" && c.path === "/2/tweets" && c.method === "POST";
const rejectTweets = () => mock.use((c) => (isTweetPost(c) ? new Response(JSON.stringify({ title: "Bad" }), { status: 400 }) : undefined));
const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

beforeAll(async () => {
  await migrateTestDb();
  actions = await import("./actions.js");
  runner = await import("./runner.js");
  env = await import("./env.js");
  fx = await import("./fixtures.js");
  sup = await import("./test-support.js");
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
  notices.length = 0;
  mock.reset();
  await fx.clearAll();
});

describe("an owner-initiated retry posts what the preview shows now", () => {
  async function failedWithText(text?: string) {
    await fx.insertAccount("x", now());
    const post = await fx.insertPost({ title: "Birinchi sarlavha", excerpt: "Birinchi tavsif" });
    const q = await actions.sendNow(A(), post.id, "x", text === undefined ? {} : { text });
    if (!q.ok) throw new Error(q.error.message);
    rejectTweets();
    expect(await runner.runDistribution(q.data.id)).toBe("failed");
    mock.reset();
    return { post, id: q.data.id };
  }

  it("schedule with text A -> fails -> owner saves text B -> retry posts B", async () => {
    const { post, id } = await failedWithText("Matn A");
    expect((await rowOf(id)).renderedText).toBe("Matn A");
    expect((await actions.saveDraft(A(), post.id, "x", { text: "Matn B" })).ok).toBe(true);
    expect((await actions.retry(A(), id)).ok).toBe(true);
    expect((await rowOf(id)).renderedText).toBe("Matn B");
    expect(await runner.runDistribution(id)).toBe("sent");
    expect(tweetText(0)).toBe("Matn B");
    expect((await rowOf(id)).sentText).toBe("Matn B");
  });

  it("no hand edit: the title changes after the failure -> retry posts the text the preview shows now", async () => {
    const { post, id } = await failedWithText();
    const before = (await rowOf(id)).renderedText;
    await db.update(s.posts).set({ title: "Butunlay yangi sarlavha" }).where(eq(s.posts.id, post.id));
    const preview = (await prepare.buildPreview(post.id, "x"))!.text;
    expect(preview).not.toBe(before);
    expect((await actions.retry(A(), id)).ok).toBe(true);
    expect(await runner.runDistribution(id)).toBe("sent");
    expect(tweetText(0)).toBe(preview);
    expect(tweetText(0)).toContain("Butunlay yangi sarlavha");
  });

  it("resolve -> retry (needs_checking) refreezes too", async () => {
    await fx.insertAccount("x", now());
    const post = await fx.insertPost();
    const q = await actions.sendNow(A(), post.id, "x", { text: "Matn A" });
    if (!q.ok) throw new Error(q.error.message);
    mock.use((c) => (isTweetPost(c) ? new Response("{}", { status: 502 }) : undefined));
    expect(await runner.runDistribution(q.data.id)).toBe("needs_checking");
    mock.reset();
    // needs_checking qatori tahrirni qabul qilmaydi: ko'rsatilgan matn o'zgargani post orqali bo'ladi
    await db.update(s.posts).set({ title: "Hal qilingandan keyingi sarlavha" }).where(eq(s.posts.id, post.id));
    await db.update(s.distributions).set({ text: null }).where(eq(s.distributions.id, q.data.id));
    const preview = (await prepare.buildPreview(post.id, "x"))!.text;
    expect((await actions.resolveNeedsChecking(A(), q.data.id, { action: "retry", confirmDuplicateRisk: true })).ok).toBe(true);
    expect(await runner.runDistribution(q.data.id)).toBe("sent");
    expect(tweetText(0)).toBe(preview);
  });

  it("an AUTOMATIC retry of a transient failure keeps the already frozen text", async () => {
    await fx.insertAccount("x", now());
    const post = await fx.insertPost({ title: "Birinchi sarlavha" });
    const q = await actions.sendNow(A(), post.id, "x");
    if (!q.ok) throw new Error(q.error.message);
    const frozen = (await rowOf(q.data.id)).renderedText!;
    let first = true;
    mock.use((c) => {
      if (!(c.host === "api.x.com" && c.path === "/2/media/upload") || !first) return undefined;
      first = false;
      return new Response("{}", { status: 503 });
    });
    expect(await runner.runDistribution(q.data.id)).toBe("retry");
    await db.update(s.posts).set({ title: "Keyingi sarlavha" }).where(eq(s.posts.id, post.id));
    nowMs += 61_000;
    expect(await runner.runDistribution(q.data.id, now())).toBe("sent");
    expect(tweetText(tweets().length - 1)).toBe(frozen);
  });
});

describe("late results never touch a newer attempt", () => {
  /** Birinchi urinish tweet POST'da to'xtab turadi; qolgan urinishlar o'z darvozasida. */
  function gates() {
    const waiting: Array<(r: Response) => void> = [];
    mock.use((c) => (isTweetPost(c) ? new Promise<Response>((resolve) => waiting.push(resolve)) : undefined));
    return { release: (i: number, id: string) => waiting[i]!(new Response(JSON.stringify({ data: { id } }), { status: 201 })), count: () => waiting.length };
  }

  it("a late success of an OLD attempt is not written over a NEW in-flight attempt", async () => {
    await fx.insertAccount("x", now());
    const post = await fx.insertPost();
    const q = await actions.sendNow(A(), post.id, "x");
    if (!q.ok) throw new Error(q.error.message);
    const g = gates();
    const p1 = runner.runDistribution(q.data.id, now());
    await waitFor(() => g.count() === 1);
    expect(await runner.recoverInterruptedDistributions(now(), true)).toBe(1);
    nowMs += 5_000;
    expect((await actions.resolveNeedsChecking(A(), q.data.id, { action: "retry", confirmDuplicateRisk: true })).ok).toBe(true);
    const p2 = runner.runDistribution(q.data.id, now());
    await waitFor(() => g.count() === 2);
    expect(await rowOf(q.data.id)).toMatchObject({ status: "sending", attempts: 1 });
    g.release(0, "OLD-1");
    await p1;
    const mid = await rowOf(q.data.id);
    expect(mid).toMatchObject({ status: "sending", externalId: null });
    g.release(1, "NEW-2");
    await p2;
    expect(await rowOf(q.data.id)).toMatchObject({ status: "sent", externalId: "NEW-2" });
    const late = await db.select().from(s.auditLog).where(eq(s.auditLog.action, "distribution.late_result"));
    expect(late).toHaveLength(1);
  });

  it("a late FAILURE of an old attempt does not fail a newer in-flight attempt", async () => {
    await fx.insertAccount("x", now());
    const post = await fx.insertPost();
    const q = await actions.sendNow(A(), post.id, "x");
    if (!q.ok) throw new Error(q.error.message);
    const waiting: Array<(r: Response) => void> = [];
    mock.use((c) => (isTweetPost(c) ? new Promise<Response>((resolve) => waiting.push(resolve)) : undefined));
    const p1 = runner.runDistribution(q.data.id, now());
    await waitFor(() => waiting.length === 1);
    await runner.recoverInterruptedDistributions(now(), true);
    nowMs += 5_000;
    await actions.resolveNeedsChecking(A(), q.data.id, { action: "retry", confirmDuplicateRisk: true });
    const p2 = runner.runDistribution(q.data.id, now());
    await waitFor(() => waiting.length === 2);
    waiting[0]!(new Response("{}", { status: 400 }));
    await p1;
    expect((await rowOf(q.data.id)).status).toBe("sending");
    waiting[1]!(new Response(JSON.stringify({ data: { id: "NEW-2" } }), { status: 201 }));
    await p2;
    expect(await rowOf(q.data.id)).toMatchObject({ status: "sent", externalId: "NEW-2" });
    expect(notices).toHaveLength(0);
  });

  it("a late success for a row the owner closed as 'not posted' keeps the decision but is audited and notified with its URL", async () => {
    await fx.insertAccount("x", now());
    const post = await fx.insertPost({ title: "Kech natija" });
    const q = await actions.sendNow(A(), post.id, "x");
    if (!q.ok) throw new Error(q.error.message);
    const g = gates();
    const p1 = runner.runDistribution(q.data.id, now());
    await waitFor(() => g.count() === 1);
    await runner.recoverInterruptedDistributions(now(), true);
    expect((await actions.resolveNeedsChecking(A(), q.data.id, { action: "not_posted" })).ok).toBe(true);
    g.release(0, "LATE-1");
    await p1;
    expect(await rowOf(q.data.id)).toMatchObject({ status: "cancelled", externalId: null });
    const late = await db.select().from(s.auditLog).where(eq(s.auditLog.action, "distribution.late_result"));
    expect(late).toHaveLength(1);
    expect(JSON.stringify(late[0]!.meta)).toContain("https://x.com/");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("https://x.com/");
    expect(notices[0]).toContain("Kech natija");
  });
});

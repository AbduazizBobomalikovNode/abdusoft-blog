import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { migrateTestDb } from "../../../test/migrate-test-db.js";

vi.hoisted(() => {
  process.env.DISTRIBUTION_ENABLED = "true";
  process.env.API_ORIGIN = "https://api.example.test";
  process.env.WEB_ORIGIN = "https://blog.example.test";
});

let v: typeof import("./versions.js");
let actions: typeof import("./actions.js");
let env: typeof import("./env.js");
let fx: typeof import("./fixtures.js");
let sup: typeof import("./test-support.js");
let db: typeof import("../../../db/index.js").db;
let s: typeof import("../../../db/schema.js");
let mock: ReturnType<typeof import("./test-support.js").createPlatformMock>;
const NOW = new Date("2026-11-26T10:00:00Z");
const A = () => fx.ADMIN_ACTOR;

beforeAll(async () => {
  await migrateTestDb();
  v = await import("./versions.js");
  actions = await import("./actions.js");
  env = await import("./env.js");
  fx = await import("./fixtures.js");
  sup = await import("./test-support.js");
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

const mk = async (postId: string, provider: "linkedin" | "x" | "threads" | "instagram", body = {}) => {
  const r = await v.createVersion(A(), postId, provider, body);
  if (!r.ok) throw new Error(r.error.message);
  return r.data;
};

describe("distribution versions service", () => {
  it("creates with default name/text, clones from another version, per post+channel isolation", async () => {
    const post = await fx.insertPost();
    const a = await mk(post.id, "x", { text: "Birinchi" });
    expect(a).toMatchObject({ name: "1-versiya", text: "Birinchi", isPrimary: false, imageChoice: "auto", linkMode: null });
    const b = await mk(post.id, "x", { fromVersionId: a.id, name: "Nusxa" });
    expect(b).toMatchObject({ name: "Nusxa", text: "Birinchi" });
    const d = await mk(post.id, "x"); // standart matn
    expect(d.text.length).toBeGreaterThan(0);
    await mk(post.id, "threads", { text: "Boshqa kanal" });
    const list = await v.listVersions(post.id, "x");
    expect(list.ok && list.data.map((x) => x.name)).toEqual(["1-versiya", "Nusxa", "3-versiya"]);
  });

  it("linkMode only for LinkedIn; github rejected; bad name/text rejected; text with fromVersionId rejected", async () => {
    const post = await fx.insertPost();
    expect((await v.createVersion(A(), post.id, "x", { linkMode: "text" })).ok).toBe(false);
    expect((await v.createVersion(A(), post.id, "github", { text: "a" })).ok).toBe(false);
    expect((await v.createVersion(A(), post.id, "x", { name: "  " })).ok).toBe(false);
    expect((await v.createVersion(A(), post.id, "x", { name: "n".repeat(81) })).ok).toBe(false);
    const li = await mk(post.id, "linkedin", { text: "a", linkMode: "text" });
    expect(li.linkMode).toBe("text");
    const x = await mk(post.id, "x", { text: "a" });
    expect((await v.createVersion(A(), post.id, "x", { fromVersionId: x.id, text: "b" })).ok).toBe(false);
    const missing = await v.createVersion(A(), post.id, "x", { fromVersionId: "00000000-0000-4000-8000-000000000000" });
    expect(!missing.ok && missing.error.kind).toBe("not_found");
  });

  it("allows at most 10 per post+channel (other channel unaffected)", async () => {
    const post = await fx.insertPost();
    for (let i = 0; i < 10; i++) await mk(post.id, "x", { text: `t${i}` });
    const eleventh = await v.createVersion(A(), post.id, "x", { text: "ortiqcha" });
    expect(!eleventh.ok && eleventh.error.kind).toBe("conflict");
    expect((await v.createVersion(A(), post.id, "threads", { text: "ok" })).ok).toBe(true);
  });

  it("primary is unique per post+channel: setting moves it, clear removes it, DB index forbids two", async () => {
    const post = await fx.insertPost();
    const a = await mk(post.id, "x", { text: "a", makePrimary: true });
    const b = await mk(post.id, "x", { text: "b" });
    expect(a.isPrimary).toBe(true);
    const r = await v.setPrimary(A(), b.id);
    expect(r.ok && r.data.isPrimary).toBe(true);
    const rows = await db.select().from(s.distributionVersions).where(eq(s.distributionVersions.postId, post.id));
    expect(rows.filter((x) => x.isPrimary).map((x) => x.id)).toEqual([b.id]);
    await expect(db.update(s.distributionVersions).set({ isPrimary: true }).where(eq(s.distributionVersions.id, a.id))).rejects.toBeTruthy();
    const other = await mk(post.id, "threads", { text: "c", makePrimary: true }); // boshqa kanal alohida asosiy
    expect(other.isPrimary).toBe(true);
    const cleared = await v.clearPrimary(A(), post.id, "x");
    expect(cleared.ok && cleared.data.cleared).toBe(1);
    expect((await db.select().from(s.distributionVersions).where(eq(s.distributionVersions.id, b.id)))[0]!.isPrimary).toBe(false);
  });

  it("update: partial fields, optimistic expectedUpdatedAt conflict, delete primary leaves none", async () => {
    const post = await fx.insertPost();
    const a = await mk(post.id, "linkedin", { text: "a", makePrimary: true });
    const u = await v.updateVersion(A(), a.id, { text: "yangi", name: "Nom", imageChoice: "none", linkMode: "text", expectedUpdatedAt: a.updatedAt });
    expect(u.ok && u.data).toMatchObject({ text: "yangi", name: "Nom", imageChoice: "none", linkMode: "text", isPrimary: true });
    const stale = await v.updateVersion(A(), a.id, { text: "eski", expectedUpdatedAt: "2020-01-01T00:00:00.000Z" });
    expect(!stale.ok && stale.error.kind).toBe("conflict");
    expect((await v.updateVersion(A(), a.id, { text: "x".repeat(20_001) })).ok).toBe(false);
    const del = await v.deleteVersion(A(), a.id);
    expect(del.ok && del.data.wasPrimary).toBe(true);
    expect(await db.select().from(s.distributionVersions)).toHaveLength(0);
    expect((await v.deleteVersion(A(), a.id)).ok).toBe(false);
  });

  it("version_id is stored on send/schedule and cleared (SET NULL) when the version is deleted; wrong post/channel version rejected", async () => {
    const post = await fx.insertPost();
    const other = await fx.insertPost();
    await fx.insertAccount("x", NOW);
    await fx.insertAccount("threads", NOW);
    const ver = await mk(post.id, "x", { text: "Versiya matni" });
    const foreign = await mk(other.id, "x", { text: "begona" });
    const wrongChannel = await mk(post.id, "threads", { text: "boshqa" });
    for (const bad of [foreign.id, wrongChannel.id]) {
      const r = await actions.sendNow(A(), post.id, "x", { text: "Versiya matni", versionId: bad });
      expect(!r.ok && r.error.kind).toBe("bad_request");
    }
    expect(await db.select().from(s.distributions)).toHaveLength(0);
    const sched = await actions.schedule(A(), post.id, "x", new Date(NOW.getTime() + 3_600_000), { text: "Versiya matni", versionId: ver.id });
    expect(sched.ok && sched.data).toMatchObject({ versionId: ver.id, text: "Versiya matni", status: "scheduled" });
    // Versiyasiz yuborish eski xatti-harakat: version_id bo'sh.
    await db.delete(s.distributions);
    const plain = await actions.sendNow(A(), post.id, "x", {});
    expect(plain.ok && plain.data.versionId).toBeNull();
    await db.delete(s.distributions);
    const sent = await actions.sendNow(A(), post.id, "x", { versionId: ver.id, text: ver.text });
    expect(sent.ok && sent.data.versionId).toBe(ver.id);
    await v.deleteVersion(A(), ver.id);
    expect((await db.select().from(s.distributions))[0]!.versionId).toBeNull();
  });

  it("listPostDistributions includes versions of all channels", async () => {
    const post = await fx.insertPost();
    await mk(post.id, "x", { text: "a" });
    await mk(post.id, "threads", { text: "b" });
    const r = await actions.listPostDistributions(post.id);
    expect(r.ok && r.data.versions.map((x) => x.provider).sort()).toEqual(["threads", "x"]);
  });
});

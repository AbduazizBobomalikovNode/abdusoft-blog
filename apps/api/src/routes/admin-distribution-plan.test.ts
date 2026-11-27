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

let app: Hono;
let admin: TestUser;
let staff: TestUser;
let fx: typeof import("../lib/distribution/service/fixtures.js");
let env: typeof import("../lib/distribution/service/env.js");
let db: typeof import("../db/index.js").db;
let s: typeof import("../db/schema.js");
const NOW = new Date("2026-11-26T10:00:00Z");

async function call(path: string, cookie: string | null, init: { method?: string; body?: unknown } = {}) {
  return app.request(`/admin/distribution${path}`, {
    method: init.method ?? "GET",
    headers: { ...(cookie ? { cookie } : {}), ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../app.js"));
  ({ db } = await import("../db/index.js"));
  s = await import("../db/schema.js");
  fx = await import("../lib/distribution/service/fixtures.js");
  env = await import("../lib/distribution/service/env.js");
  const sup = await import("../lib/distribution/service/test-support.js");
  const mock = sup.createPlatformMock();
  env.setDistributionFetch(mock.fetch);
  env.setDistributionClock(() => NOW);
  const images = await import("../lib/distribution/service/images.js");
  images.setSocialImageLoader((url) => sup.fakePreparedImage(url));
  admin = await createTestUser({ role: "admin", name: "Admin" });
  staff = await createTestUser({ role: "staff", name: "Staff" });
});
afterAll(() => {
  env.setDistributionFetch(null);
  env.setDistributionClock(null);
});
beforeEach(async () => {
  await fx.clearAll();
});

describe("admin distribution plan routes", () => {
  it("PUT/DELETE plan: admin only, validated, and the plan shows up in the post's distribution list", async () => {
    const post = await fx.insertPost({ status: "draft", publishedAt: null });
    const url = `/posts/${post.id}/linkedin/plan`;
    expect((await call(url, null, { method: "PUT", body: { delayMinutes: 5 } })).status).toBe(401);
    expect((await call(url, staff.cookie, { method: "PUT", body: { delayMinutes: 5 } })).status).toBe(403);
    expect((await call(url, staff.cookie, { method: "DELETE" })).status).toBe(403);

    for (const body of [{}, { delayMinutes: -1 }, { delayMinutes: 10081 }, { delayMinutes: 1.5 }, { delayMinutes: "5" }, { delayMinutes: 5, junk: 1 }]) {
      expect((await call(url, admin.cookie, { method: "PUT", body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call(`/posts/not-a-uuid/linkedin/plan`, admin.cookie, { method: "PUT", body: { delayMinutes: 5 } })).status).toBe(404);
    expect((await call(`/posts/${post.id}/myspace/plan`, admin.cookie, { method: "PUT", body: { delayMinutes: 5 } })).status).toBe(404);

    const put = await call(url, admin.cookie, { method: "PUT", body: { delayMinutes: 180, text: "Salom", linkMode: "text" } });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ provider: "linkedin", status: "draft", planDelayMinutes: 180, planMaterializedAt: null, text: "Salom", linkMode: "text" });

    const list = (await (await call(`/posts/${post.id}`, admin.cookie)).json()) as { distributions: Array<{ provider: string; planDelayMinutes: number | null }> };
    expect(list.distributions.find((d) => d.provider === "linkedin")?.planDelayMinutes).toBe(180);

    const del = await call(url, admin.cookie, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ cleared: true, cancelled: false });
    expect((await db.select().from(s.distributions).where(eq(s.distributions.postId, post.id)))[0]!.planDelayMinutes).toBeNull();
    expect(await (await call(url, admin.cookie, { method: "DELETE" })).json()).toMatchObject({ cleared: false });
  });

  it("a published post answers 409 (use the absolute schedule instead)", async () => {
    const post = await fx.insertPost();
    const res = await call(`/posts/${post.id}/x/plan`, admin.cookie, { method: "PUT", body: { delayMinutes: 5 } });
    expect(res.status).toBe(409);
  });
});

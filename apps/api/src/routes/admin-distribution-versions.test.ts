import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
let sup: typeof import("../lib/distribution/service/test-support.js");

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
  fx = await import("../lib/distribution/service/fixtures.js");
  env = await import("../lib/distribution/service/env.js");
  sup = await import("../lib/distribution/service/test-support.js");
  const mock = sup.createPlatformMock();
  env.setDistributionFetch(mock.fetch);
  const images = await import("../lib/distribution/service/images.js");
  images.setSocialImageLoader((url) => sup.fakePreparedImage(url));
  admin = await createTestUser({ role: "admin", name: "Admin" });
  staff = await createTestUser({ role: "staff", name: "Staff" });
});
afterAll(() => env.setDistributionFetch(null));
beforeEach(async () => {
  await fx.clearAll();
});

describe("admin distribution versions routes", () => {
  it("CRUD + primary over HTTP; list in the post response; admin only", async () => {
    const post = await fx.insertPost();
    const base = `/posts/${post.id}/linkedin/versions`;
    expect((await call(base, null)).status).toBe(401);
    expect((await call(base, staff.cookie)).status).toBe(403);
    expect((await call(base, staff.cookie, { method: "POST", body: {} })).status).toBe(403);

    const c = await call(base, admin.cookie, { method: "POST", body: { name: "Rasmiy", text: "Matn", linkMode: "text" } });
    expect(c.status).toBe(201);
    const ver = (await c.json()) as { id: string; updatedAt: string; linkMode: string };
    expect(ver.linkMode).toBe("text");
    expect(((await (await call(base, admin.cookie)).json()) as { versions: unknown[] }).versions).toHaveLength(1);

    const p = await call(`/versions/${ver.id}`, admin.cookie, { method: "PATCH", body: { text: "Yangilandi", expectedUpdatedAt: ver.updatedAt } });
    expect(p.status).toBe(200);
    expect(((await p.json()) as { text: string }).text).toBe("Yangilandi");
    expect((await call(`/versions/${ver.id}`, admin.cookie, { method: "PATCH", body: { text: "eski", expectedUpdatedAt: ver.updatedAt } })).status).toBe(409);
    expect((await call(`/versions/${ver.id}`, admin.cookie, { method: "PATCH", body: { bogus: 1 } })).status).toBe(400);

    const pr = await call(`/versions/${ver.id}/primary`, admin.cookie, { method: "POST" });
    expect(((await pr.json()) as { isPrimary: boolean }).isPrimary).toBe(true);
    const all = (await (await call(`/posts/${post.id}`, admin.cookie)).json()) as { versions: Array<{ id: string; isPrimary: boolean }> };
    expect(all.versions).toEqual([expect.objectContaining({ id: ver.id, isPrimary: true })]);
    expect(((await (await call(`/posts/${post.id}/linkedin/primary`, admin.cookie, { method: "DELETE" })).json()) as { cleared: number }).cleared).toBe(1);

    expect((await call(`/versions/${ver.id}`, admin.cookie, { method: "DELETE" })).status).toBe(200);
    expect((await call(`/versions/${ver.id}`, admin.cookie, { method: "DELETE" })).status).toBe(404);
    expect((await call(`/posts/${post.id}/github/versions`, admin.cookie, { method: "POST", body: { text: "a" } })).status).toBe(400);
  });

  it("the 11th version is refused with 409; send with versionId stores it", async () => {
    const post = await fx.insertPost();
    await fx.insertAccount("x", new Date());
    let last = "";
    for (let i = 0; i < 10; i++) {
      const r = await call(`/posts/${post.id}/x/versions`, admin.cookie, { method: "POST", body: { text: `t${i}` } });
      expect(r.status).toBe(201);
      last = ((await r.json()) as { id: string }).id;
    }
    expect((await call(`/posts/${post.id}/x/versions`, admin.cookie, { method: "POST", body: { text: "11" } })).status).toBe(409);
    const s = await call(`/posts/${post.id}/x/send`, admin.cookie, { method: "POST", body: { text: "t9", versionId: last } });
    expect(s.status).toBe(200);
    expect(((await s.json()) as { versionId: string }).versionId).toBe(last);
    expect((await call(`/posts/${post.id}/x/send`, admin.cookie, { method: "POST", body: { versionId: "nope" } })).status).toBe(400);
  });
});

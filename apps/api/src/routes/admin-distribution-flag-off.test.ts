import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../test/migrate-test-db.js";
import { createTestUser, type TestUser } from "../test/auth-test-helpers.js";
import { MAIN_ROUTE_TABLE } from "../test/main-route-table.js";

// DISTRIBUTION_ENABLED o'rnatilmagan (standart: o'chiq): yangi marshrut, scheduler ishi va UI kirish nuqtasi yo'q.
vi.hoisted(() => {
  delete process.env.DISTRIBUTION_ENABLED;
  delete process.env.MCP_ENABLED;
});

let app: Hono;
let admin: TestUser;
let db: typeof import("../db/index.js").db;
let s: typeof import("../db/schema.js");

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../app.js"));
  ({ db } = await import("../db/index.js"));
  s = await import("../db/schema.js");
  admin = await createTestUser({ role: "admin" });
});

describe("DISTRIBUTION_ENABLED off — no new surface, Telegram unchanged", () => {
  it("has exactly the route table of main", () => {
    expect(app.routes.map((r) => `${r.method} ${r.path}`)).toEqual([...MAIN_ROUTE_TABLE]);
  });

  it.each([
    ["GET", "/admin/distribution/settings"],
    ["PUT", "/admin/distribution/settings"],
    ["GET", "/admin/distribution/channels"],
    ["POST", "/admin/distribution/accounts/linkedin/connect"],
    ["GET", "/admin/distribution/callback/linkedin"],
    ["GET", "/admin/distribution/posts/00000000-0000-4000-8000-000000000000"],
    ["POST", "/admin/distribution/posts/00000000-0000-4000-8000-000000000000/x/send"],
    ["POST", "/admin/distribution/items/00000000-0000-4000-8000-000000000000/cancel"],
  ])("%s %s is not served (even for an admin)", async (method, path) => {
    const res = await app.request(path, { method, headers: { cookie: admin.cookie, "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
    expect(res.status).toBe(404);
  });

  it("registers no scheduler job and touches no distribution table", async () => {
    const { startScheduler } = await import("../lib/scheduler.js");
    const jobs = startScheduler();
    expect(jobs).toHaveLength(3);
    for (const j of jobs) j.stop();
    for (const table of [s.distributions, s.distributionAccounts, s.distributionOauthStates, s.distributionImages]) {
      expect(await db.select().from(table)).toHaveLength(0);
    }
  });

  it("Telegram admin endpoints still answer as before", async () => {
    const res = await app.request("/admin/telegram/status", { headers: { cookie: admin.cookie } });
    expect(res.status).toBe(200);
    expect((await app.request("/admin/telegram/status")).status).toBe(401);
  });
});

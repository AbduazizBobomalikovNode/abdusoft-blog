import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../test/migrate-test-db.js";
import { createTestUser, type TestUser } from "../test/auth-test-helpers.js";

vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/video-admin-test-${process.pid}`;
  process.env.VIDEO_ENABLED = "true";
  process.env.VIDEO_RUNNER = "github";
  process.env.VIDEO_RUNNER_SECRET = "a".repeat(40);
  process.env.VIDEO_DATA_DIR = `${dir}/data`;
  delete process.env.VIDEO_GITHUB_TOKEN;
  delete process.env.VIDEO_GITHUB_REPO;
  delete process.env.DISTRIBUTION_ENABLED;
});

type Rec = Record<string, Record<string, unknown> | string | boolean | null> & { token: Record<string, unknown>; repo: Record<string, unknown>; github: Record<string, unknown>; resources: Record<string, unknown> };
let app: Hono;
let admin: TestUser;
let staff: TestUser;
let db: typeof import("../db/index.js").db;
let s: typeof import("../db/schema.js");
const req = (p: string, who: TestUser | null, init: { method?: string; json?: unknown } = {}) =>
  app.request(p, { method: init.method ?? "GET", headers: { ...(who ? { cookie: who.cookie } : {}), ...(init.json !== undefined ? { "content-type": "application/json" } : {}) }, ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}) });

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../app.js"));
  ({ db } = await import("../db/index.js"));
  s = await import("../db/schema.js");
  admin = await createTestUser({ role: "admin" });
  staff = await createTestUser({ role: "staff" });
  (await import("../lib/video/resources.js")).setResourceProbeForTests(() => ({ freeDiskMb: 50_000, freeMemoryMb: 8000 }));
});

describe("videoEnabled capability in GET /admin/me", () => {
  it("an admin gets videoEnabled:true; staff and anonymous callers do not", async () => {
    const a = (await (await req("/admin/me", admin)).json()) as Record<string, unknown>;
    expect(a.videoEnabled).toBe(true);
    expect(a.distributionEnabled).toBeUndefined();
    const st = (await (await req("/admin/me", staff)).json()) as Record<string, unknown>;
    expect(Object.keys(st).sort()).toEqual(["email", "id", "name", "role"]);
    expect((await req("/admin/me", null)).status).toBe(401);
  });
});

describe("status and GitHub settings", () => {
  it("status shows the backend and WHAT is configured, never a value; the server does not look for a browser", async () => {
    const r = await req("/admin/video/status", admin);
    const body = (await r.json()) as Rec;
    expect(body).toMatchObject({ enabled: true, runner: "github", browser: null, local: null, github: { tokenConfigured: false, secretConfigured: true, repoConfigured: false, repo: null, lastSuccessAt: null } });
    expect(body.resources).toMatchObject({ freeMemoryMb: null, minFreeMemoryMb: 0 });
    expect(JSON.stringify(body)).not.toContain("aaaaaaaa");
  });

  it("saves the token encrypted, returns only a mask, locks nothing when env is empty, audits without the value", async () => {
    const put = await req("/admin/video/settings", admin, { method: "PUT", json: { githubToken: "github_pat_SUPERSECRET1234", githubRepo: "me/blog" } });
    expect(put.status).toBe(200);
    const view = (await put.json()) as Rec;
    expect(view.token).toMatchObject({ isSet: true, masked: "••••1234", source: "db" });
    expect(view.repo).toMatchObject({ value: "me/blog", source: "db" });
    expect(JSON.stringify(view)).not.toContain("SUPERSECRET");
    const [row] = await db.select().from(s.siteSettings).where((await import("drizzle-orm")).eq(s.siteSettings.key, "settings:video"));
    expect(JSON.stringify(row?.value)).not.toContain("SUPERSECRET");
    expect((row?.value as { githubToken: string }).githubToken).toMatch(/^enc:v1:/);
    const get = (await (await req("/admin/video/settings", admin)).json()) as Rec;
    expect(JSON.stringify(get)).not.toContain("SUPERSECRET");
    const status = (await (await req("/admin/video/status", admin)).json()) as Rec;
    expect(status.github).toMatchObject({ tokenConfigured: true, secretConfigured: true, repoConfigured: true, repo: "me/blog" });
    const audit = (await db.select().from(s.auditLog)).filter((a) => a.action === "video.settings_update");
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).not.toContain("SUPERSECRET");
  });

  it("a masked value means 'keep'; an empty string clears; a bad repository or a token with spaces is refused", async () => {
    const keep = await req("/admin/video/settings", admin, { method: "PUT", json: { githubToken: "••••1234" } });
    expect(((await keep.json()) as Rec).token.isSet).toBe(true);
    expect((await req("/admin/video/settings", admin, { method: "PUT", json: { githubRepo: "no slash" } })).status).toBe(422);
    expect((await req("/admin/video/settings", admin, { method: "PUT", json: { githubToken: "has space" } })).status).toBe(422);
    expect((await req("/admin/video/settings", admin, { method: "PUT", json: { extra: 1 } })).status).toBe(400);
    const clear = await req("/admin/video/settings", admin, { method: "PUT", json: { githubToken: "" } });
    expect(((await clear.json()) as Rec).token.isSet).toBe(false);
  });

  it("only admins may read or change the settings", async () => {
    expect((await req("/admin/video/settings", staff)).status).toBe(403);
    expect((await req("/admin/video/settings", staff, { method: "PUT", json: {} })).status).toBe(403);
    expect((await req("/admin/video/settings", null)).status).toBe(401);
  });
});

describe("the runner endpoints exist only for the github backend", () => {
  it("are mounted outside /admin and answer 401 to a stranger", async () => {
    const r = await app.request("/runner/video/jobs/00000000-0000-4000-8000-000000000000/claim", { method: "POST" });
    expect(r.status).toBe(401);
    expect(app.routes.some((x) => x.path.startsWith("/runner/video"))).toBe(true);
  });
});

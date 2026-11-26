import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { MCP_OFFLINE_SCOPE, MCP_SCOPES, grantableOAuthScopes, grantableScopeIds } from "@blog/shared";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, type TestUser } from "../../test/auth-test-helpers.js";
import { MAIN_ROUTE_TABLE } from "../../test/main-route-table.js";

// VIDEO_ENABLED is NOT set while the other optional features are ON: the result must be exactly what main produces in every switch state.
vi.hoisted(() => {
  delete process.env.VIDEO_ENABLED;
  delete process.env.VIDEO_RUNNER;
  process.env.MCP_ENABLED = "true";
  process.env.DISTRIBUTION_ENABLED = "true";
});

let app: Hono;
let admin: TestUser;
let staff: TestUser;
let config: Record<string, number | string | boolean>;

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  ({ config } = (await import("../../config.js")) as unknown as { config: Record<string, number | string | boolean> });
  admin = await createTestUser({ role: "admin" });
  staff = await createTestUser({ role: "staff" });
});

const VIDEO_TOOLS = ["get_storyboard_guide", "validate_storyboard", "preview_storyboard", "start_video_render", "get_video_job", "list_post_videos", "get_video_status", "cancel_video_job", "delete_video_job"];

describe("VIDEO_ENABLED off: nothing changes in any switch state", () => {
  it("the route table is main's, and neither /admin/video nor /runner/video exists", async () => {
    const routes = app.routes.map((r) => `${r.method} ${r.path}`);
    expect(routes.filter((r) => r.includes("/video"))).toEqual([]);
    // main's table is a subset (this file also turns the MCP and distribution routes on, which main has too)
    for (const r of MAIN_ROUTE_TABLE) expect(routes).toContain(r);
    expect(routes.filter((r) => /runner|\/video/.test(r))).toEqual([]);
    for (const p of ["/admin/video/status", "/admin/video/settings", "/runner/video/jobs/00000000-0000-4000-8000-000000000000/claim"]) {
      expect((await app.request(p, { method: p.includes("claim") ? "POST" : "GET", headers: { cookie: admin.cookie } })).status).toBe(404);
    }
  });

  it("GET /admin/me is exactly main's (only distributionEnabled for an admin): no videoEnabled field", async () => {
    const a = (await (await app.request("/admin/me", { headers: { cookie: admin.cookie } })).json()) as Record<string, unknown>;
    expect(Object.keys(a).sort()).toEqual(["distributionEnabled", "email", "id", "name", "role"]);
    const st = (await (await app.request("/admin/me", { headers: { cookie: staff.cookie } })).json()) as Record<string, unknown>;
    expect(Object.keys(st).sort()).toEqual(["email", "id", "name", "role"]);
  });

  for (const write of [false, true]) {
    for (const purge of [false, true]) {
      it(`tools/list names and scope lists equal main's with MCP_WRITE_TOOLS_ENABLED=${write}, MCP_PURGE_ENABLED=${purge}`, async () => {
        config.MCP_WRITE_TOOLS_ENABLED = write;
        config.MCP_PURGE_ENABLED = purge;
        const { getTools, TOOLS } = await import("../mcp/tools/index.js");
        const { WRITE_TOOLS } = await import("../mcp/tools/write-tools.js");
        const dist = await import("../mcp/tools/distribution-tools.js");
        const expected = write
          ? [...TOOLS, ...dist.DISTRIBUTION_READ_TOOLS, ...WRITE_TOOLS.filter((t) => !t.requiresPurgeSwitch || purge), ...dist.DISTRIBUTION_WRITE_TOOLS]
          : [...TOOLS, ...dist.DISTRIBUTION_READ_TOOLS];
        const names = getTools().map((t) => t.name);
        expect(names).toEqual(expected.map((t) => t.name));
        for (const n of VIDEO_TOOLS) expect(names).not.toContain(n);

        const scopes = await import("../mcp/scopes.js");
        // main's two-argument helpers give the same lists as the live ones (the video argument defaults to off)
        expect(scopes.grantableNow()).toEqual([...grantableOAuthScopes(write, true)]);
        expect(scopes.grantableIdsNow()).toEqual([...grantableScopeIds(write, true)]);
        expect(scopes.grantableNow()).not.toContain("video:render");
        expect(scopes.clampNow(["blog:read", "video:render", "social:post", MCP_OFFLINE_SCOPE])).toEqual(write ? ["blog:read", "social:post", MCP_OFFLINE_SCOPE] : ["blog:read", MCP_OFFLINE_SCOPE]);
        expect(scopes.challengeScopes()).toEqual(scopes.grantableNow());
        expect(Object.keys(scopes.scopeDescriptionsEn())).not.toContain("video:render");
        // consent data: what the consent page can list is the requested scopes that are grantable
        const consentIds = MCP_SCOPES.filter((s) => scopes.grantableIdsNow().includes(s.id)).map((s) => s.id);
        expect(consentIds).not.toContain("video:render");
      });
    }
  }

  it("the shared helpers with their old arguments return what they returned before video existed", () => {
    expect([...grantableScopeIds(true)]).toEqual(MCP_SCOPES.map((s) => s.id).filter((id) => id !== "social:post" && id !== "video:render"));
    expect([...grantableScopeIds(true, true)]).toEqual(MCP_SCOPES.map((s) => s.id).filter((id) => id !== "video:render"));
    expect([...grantableScopeIds(false, true, true)]).toEqual(["blog:read"]);
  });

  it("the scheduler registers no video job", async () => {
    const { startScheduler } = await import("../scheduler.js");
    const jobs = startScheduler();
    // main with distribution on: publish, cleanup, digest, MCP cleanup, distribution tick
    expect(jobs).toHaveLength(5);
    for (const j of jobs) j.stop();
  });
});

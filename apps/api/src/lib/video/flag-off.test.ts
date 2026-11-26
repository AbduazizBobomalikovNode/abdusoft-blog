import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { MAIN_ROUTE_TABLE } from "../../test/main-route-table.js";

// VIDEO_ENABLED is not set: the feature must leave no surface at all.
vi.hoisted(() => {
  delete process.env.VIDEO_ENABLED;
  process.env.MCP_ENABLED = "true";
  process.env.MCP_WRITE_TOOLS_ENABLED = "true";
});

let app: Hono;
beforeAll(async () => {
  await migrateTestDb();
});

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}

describe("VIDEO_ENABLED off - no surface", () => {
  it("adds no route (the admin video routes are not mounted)", async () => {
    ({ app } = await import("../../app.js"));
    const routes = app.routes.map((r) => `${r.method} ${r.path}`);
    expect(routes.filter((r) => r.includes("/admin/video"))).toEqual([]);
    expect((await app.request("/admin/video/status")).status).toBe(404);
  });

  it("registers no tool and grants no video permission", async () => {
    const { getTools } = await import("../mcp/tools/index.js");
    const names = getTools().map((t) => t.name);
    for (const n of ["get_storyboard_guide", "validate_storyboard", "preview_storyboard", "start_video_render", "get_video_job", "list_post_videos", "get_video_status", "cancel_video_job", "delete_video_job"]) expect(names).not.toContain(n);
    const { grantableNow, clampNow } = await import("../mcp/scopes.js");
    expect(grantableNow()).not.toContain("video:render");
    expect(clampNow(["blog:read", "video:render"])).toEqual(["blog:read"]);
  });

  it("starts no scheduler work and never loads the video modules", async () => {
    const { startScheduler } = await import("../scheduler.js");
    const jobs = startScheduler();
    expect(jobs).toHaveLength(4); // publish, cleanup, digest + MCP cleanup: nothing for video
    for (const j of jobs) j.stop();
    expect(MAIN_ROUTE_TABLE.some((r) => r.includes("video"))).toBe(false);
  });

  it("the API never imports the renderer: no static import of Remotion or the motion package outside the lazy loader", () => {
    const offenders = walk(srcRoot).filter((f) => {
      const text = readFileSync(f, "utf8");
      return /from\s+["'](@remotion|@blog\/motion|remotion)/.test(text) || /import\(\s*["'](@remotion|@blog\/motion)/.test(text);
    });
    expect(offenders).toEqual([]);
    // the only door to the motion package is the lazy loader; the worker entry is spawned, never imported
    const loader = readFileSync(path.join(srcRoot, "lib/video/motion.ts"), "utf8");
    expect(loader).toMatch(/import\(\/\* @vite-ignore \*\//);
    const importers = walk(srcRoot).filter((f) => /from\s+["'](\.\.?\/)+(lib\/)?video\//.test(readFileSync(f, "utf8")) || /import\(["']\.\/video\//.test(readFileSync(f, "utf8")));
    const names = importers.map((f) => path.relative(srcRoot, f)).sort();
    // every importer is itself flag-gated (dynamic import / mounted only when the flag is on)
    for (const n of names) expect(["lib/mcp/tools/video-tools.ts", "lib/scheduler.ts", "routes/admin-video.ts", "routes/runner-video.ts", "lib/mcp/tools/index.ts", "routes/admin.ts"]).toContain(n);
  });
});

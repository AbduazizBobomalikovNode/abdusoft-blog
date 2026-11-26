import { beforeAll, describe, expect, it, vi } from "vitest";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { ADMIN_ROUTE_EXCLUSIONS, ADMIN_ROUTE_TOOLS, SETTINGS_SECRET_SECTIONS } from "./admin-coverage.js";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_WRITE_TOOLS_ENABLED = "true";
  process.env.MCP_PURGE_ENABLED = "true";
  // Faqat tarqatish yoqilganda mavjud `/admin/distribution/*` marshrutlari va vositalari ham sanaladi.
  process.env.DISTRIBUTION_ENABLED = "true";
  // Faqat video yoqilganda mavjud `/admin/video/*` marshrutlari va vositalari ham sanaladi.
  process.env.VIDEO_ENABLED = "true";
});

let routes: string[];
let toolNames: Set<string>;

beforeAll(async () => {
  await migrateTestDb();
  const { app } = await import("../../app.js");
  routes = [...new Set(app.routes.filter((r) => r.path.startsWith("/admin/") && r.method !== "ALL").map((r) => `${r.method} ${r.path}`))];
  const { getTools } = await import("./tools/index.js");
  toolNames = new Set(getTools().map((t) => t.name));
});

/**
 * ENFORCEMENT: every admin route of the API is mapped to a connector tool or listed with a reason in `admin-coverage.ts`.
 * A pull request that adds an admin capability makes this test fail until it adds the tool (or the justified exclusion).
 */
describe("every admin route has a connector tool or a documented exclusion", () => {
  it("no admin route is left uncovered", () => {
    const uncovered = routes.filter((r) => !(r in ADMIN_ROUTE_TOOLS) && !(r in ADMIN_ROUTE_EXCLUSIONS));
    expect(uncovered, `Admin routes with neither a connector tool nor an exclusion - add the tool (apps/api/src/lib/mcp/tools) and map it, or add an exclusion with a reason in apps/api/src/lib/mcp/admin-coverage.ts:\n${uncovered.join("\n")}`).toEqual([]);
  });

  it("no route is both mapped and excluded; the files hold no stale routes", () => {
    for (const r of Object.keys(ADMIN_ROUTE_TOOLS)) expect(r in ADMIN_ROUTE_EXCLUSIONS, `${r} is both mapped and excluded`).toBe(false);
    const known = new Set(routes);
    const stale = [...Object.keys(ADMIN_ROUTE_TOOLS), ...Object.keys(ADMIN_ROUTE_EXCLUSIONS)].filter((r) => !known.has(r));
    expect(stale, `entries for routes that no longer exist:\n${stale.join("\n")}`).toEqual([]);
  });

  it("every mapped tool really exists in the registry (write switch and purge switch on)", () => {
    for (const [route, tools] of Object.entries(ADMIN_ROUTE_TOOLS)) {
      expect(tools.length, route).toBeGreaterThan(0);
      for (const tool of tools) expect(toolNames.has(tool), `${route} -> ${tool}`).toBe(true);
    }
  });

  it("every exclusion states a real reason", () => {
    for (const [route, reason] of Object.entries(ADMIN_ROUTE_EXCLUSIONS)) expect(reason.length, route).toBeGreaterThan(40);
    for (const [section, what] of Object.entries(SETTINGS_SECRET_SECTIONS)) expect(what.length, section).toBeGreaterThan(5);
  });

  it("every registered tool serves at least one admin route or is a connector-only tool", () => {
    const mapped = new Set(Object.values(ADMIN_ROUTE_TOOLS).flat());
    // Video: storyboard yozish/tekshirish/ko'rik/render boshlash faqat konnektor orqali (panelda storyboard muharriri yo'q).
    const connectorOnly = new Set<string>(["get_storyboard_guide", "validate_storyboard", "preview_storyboard", "start_video_render"]);
    const orphans = [...toolNames].filter((t) => !mapped.has(t) && !connectorOnly.has(t));
    // Tools without a dedicated HTTP route of their own are reachable through the capability they wrap; list them so a new tool is a conscious choice.
    expect(orphans.sort()).toEqual([]);
  });
});

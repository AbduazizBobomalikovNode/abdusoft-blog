import { describe, expect, it } from "vitest";
import { MCP_SCOPES, MCP_SCOPE_GROUPS, groupRequestedScopes, parseScopeString } from "./mcp.js";

describe("MCP scopes", () => {
  it("has unique ids and every scope has an Uzbek label, description and English text", () => {
    const ids = MCP_SCOPES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scope of MCP_SCOPES) {
      expect(scope.label.length).toBeGreaterThan(0);
      expect(scope.description.length).toBeGreaterThan(10);
      expect(scope.english.length).toBeGreaterThan(10);
      expect(MCP_SCOPE_GROUPS).toContain(scope.group);
    }
  });

  it("parses a scope string without blanks or duplicates", () => {
    expect(parseScopeString("  blog:read  posts:write blog:read ")).toEqual(["blog:read", "posts:write"]);
    expect(parseScopeString(null)).toEqual([]);
  });

  it("groups requested scopes in a fixed order and reports offline/unknown separately", () => {
    const view = groupRequestedScopes(["posts:delete", "blog:read", "offline_access", "weird:scope", "posts:publish"]);
    expect(view.groups.map((g) => g.group)).toEqual(["read", "publish", "danger"]);
    expect(view.offline).toBe(true);
    expect(view.unknown).toEqual(["weird:scope"]);
  });
});

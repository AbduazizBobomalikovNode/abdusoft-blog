import { describe, expect, it } from "vitest";
import { MCP_SCOPES, MCP_SCOPE_GROUPS, MCP_SENSITIVE_SCOPE_IDS } from "@blog/shared";
import { defaultScopeSelection, describeConnectionPermissions, hasDangerSelected, hasSensitiveSelected, sensitiveSelected, serializeScopeSelection, toggleScope } from "./oauth-flow";

const EVERY = [...MCP_SCOPES.map((s) => s.id), "offline_access"];

describe("account/site control permissions (staff, settings)", () => {
  it("staff:manage and settings:manage are sensitive, in the dangerous group, with Uzbek label and explanation", () => {
    expect([...MCP_SENSITIVE_SCOPE_IDS].sort()).toEqual(["settings:manage", "staff:manage"]);
    for (const id of MCP_SENSITIVE_SCOPE_IDS) {
      const scope = MCP_SCOPES.find((s) => s.id === id)!;
      expect(scope.group).toBe("danger");
      expect(scope.label.length).toBeGreaterThan(5);
      expect(scope.description.length).toBeGreaterThan(40);
    }
    expect(MCP_SCOPE_GROUPS).toContain("danger");
  });

  it("channels:prepare is a writing permission (nothing public), the others start UNTICKED", () => {
    expect(MCP_SCOPES.find((s) => s.id === "channels:prepare")!.group).toBe("write");
    const defaults = defaultScopeSelection(EVERY);
    expect(defaults).toContain("channels:prepare");
    expect(defaults).not.toContain("staff:manage");
    expect(defaults).not.toContain("settings:manage");
    expect(hasSensitiveSelected(defaults)).toBe(false);
  });

  it("selecting a sensitive permission is detected (and counts as dangerous), in catalogue order", () => {
    let selected = defaultScopeSelection(EVERY);
    selected = toggleScope(selected, "settings:manage", EVERY);
    selected = toggleScope(selected, "staff:manage", EVERY);
    expect(sensitiveSelected(selected)).toEqual(["staff:manage", "settings:manage"]);
    expect(hasSensitiveSelected(selected)).toBe(true);
    expect(hasDangerSelected(selected)).toBe(true);
    expect(hasSensitiveSelected(toggleScope(selected, "staff:manage", EVERY))).toBe(true);
    expect(hasSensitiveSelected(["blog:read", "comments:moderate", "posts:delete"])).toBe(false);
  });

  it("an unrequested sensitive permission cannot be ticked in; the consent POST carries exactly the ticked ones", () => {
    const requested = ["blog:read", "posts:write", "offline_access"];
    expect(toggleScope(["blog:read"], "staff:manage", requested)).toEqual(["blog:read"]);
    const selected = toggleScope(defaultScopeSelection(EVERY), "staff:manage", EVERY);
    expect(serializeScopeSelection(selected, EVERY).split(" ")).toContain("staff:manage");
    expect(serializeScopeSelection(defaultScopeSelection(EVERY), EVERY).split(" ")).not.toContain("staff:manage");
  });

  it("'Ulangan ilovalar' flags a connection that holds a sensitive permission", () => {
    expect(describeConnectionPermissions(["blog:read", "staff:manage"]).hasSensitive).toBe(true);
    expect(describeConnectionPermissions(["blog:read", "posts:delete"]).hasSensitive).toBe(false);
  });
});

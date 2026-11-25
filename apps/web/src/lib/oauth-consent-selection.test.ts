import { describe, expect, it } from "vitest";
import {
  defaultScopeSelection,
  describeConnectionPermissions,
  hasDangerSelected,
  inactiveConnectionScopes,
  isReadOnlySelection,
  selectionSummary,
  serializeScopeSelection,
  toggleScope,
} from "./oauth-flow";

const ALL = ["blog:read", "posts:write", "media:upload", "posts:publish", "channels:send", "comments:moderate", "posts:delete", "offline_access"];

describe("per-permission consent selection", () => {
  it("defaults: read + writing drafts + image upload on; publishing and dangerous groups off; only requested scopes", () => {
    expect(defaultScopeSelection(ALL)).toEqual(["blog:read", "posts:write", "media:upload"]);
    expect(defaultScopeSelection(ALL)).not.toContain("posts:publish");
    expect(defaultScopeSelection(ALL)).not.toContain("channels:send");
    expect(defaultScopeSelection(["blog:read", "offline_access"])).toEqual(["blog:read"]);
    expect(defaultScopeSelection(["posts:write"])).toEqual(["posts:write"]);
  });

  it("toggle: required read cannot be removed, unrequested/unknown scopes cannot be added", () => {
    const base = defaultScopeSelection(ALL);
    expect(toggleScope(base, "blog:read", ALL)).toEqual(base);
    expect(toggleScope(base, "posts:delete", ALL)).toContain("posts:delete");
    expect(toggleScope(base, "posts:write", ALL)).not.toContain("posts:write");
    expect(toggleScope(["blog:read"], "posts:delete", ["blog:read"])).toEqual(["blog:read"]);
    expect(toggleScope(base, "weird:scope", [...ALL, "weird:scope"])).toEqual(base);
  });

  it("serializes in MCP_SCOPES order, always with read, offline_access last when requested", () => {
    expect(serializeScopeSelection(["posts:publish", "posts:write"], ALL)).toBe("blog:read posts:write posts:publish offline_access");
    expect(serializeScopeSelection(["blog:read"], ["blog:read"])).toBe("blog:read");
    expect(serializeScopeSelection(["posts:delete"], ["blog:read", "posts:write"])).toBe("blog:read");
  });

  it("read-only notice logic follows the selection", () => {
    expect(isReadOnlySelection(["blog:read"])).toBe(true);
    expect(isReadOnlySelection(defaultScopeSelection(ALL))).toBe(false);
    expect(isReadOnlySelection(toggleScope(["blog:read"], "media:upload", ALL))).toBe(false);
  });

  it("detects dangerous selection and summarizes per group", () => {
    expect(hasDangerSelected(defaultScopeSelection(ALL))).toBe(false);
    const withDanger = toggleScope(defaultScopeSelection(ALL), "comments:moderate", ALL);
    expect(hasDangerSelected(withDanger)).toBe(true);
    expect(selectionSummary(withDanger, ALL)).toEqual({
      read: { selected: 1, total: 1 },
      write: { selected: 2, total: 2 },
      publish: { selected: 0, total: 2 },
      danger: { selected: 1, total: 2 },
    });
  });

  it("describes a connection's permissions by group", () => {
    expect(describeConnectionPermissions(["blog:read", "offline_access"])).toMatchObject({ readOnly: true, hasDanger: false, offline: true });
    const d = describeConnectionPermissions(["blog:read", "posts:write", "posts:delete"]);
    expect(d.readOnly).toBe(false);
    expect(d.hasDanger).toBe(true);
    expect(d.groups.map((g) => g.group)).toEqual(["read", "write", "danger"]);
  });
});

describe("inactive permissions when write tools are off", () => {
  const held = ["blog:read", "posts:write", "posts:publish", "comments:moderate", "offline_access"];
  it("lists write, publish and danger scopes only when the switch is explicitly off", () => {
    expect(inactiveConnectionScopes(held, false)).toEqual(["posts:write", "posts:publish", "comments:moderate"]);
    expect(inactiveConnectionScopes(held, true)).toEqual([]);
    expect(inactiveConnectionScopes(held, undefined)).toEqual([]);
    expect(inactiveConnectionScopes(["blog:read"], false)).toEqual([]);
  });
});

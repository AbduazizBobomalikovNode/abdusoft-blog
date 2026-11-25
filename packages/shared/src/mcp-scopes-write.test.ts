import { describe, expect, it } from "vitest";
import { MCP_SCOPE_IDS, clampToGrantable, grantableOAuthScopes, grantableScopeIds } from "./mcp.js";

describe("write scopes are grantable only behind the switch", () => {
  it("default (switch off) is read-only plus offline_access", () => {
    expect([...grantableScopeIds()]).toEqual(["blog:read"]);
    expect([...grantableOAuthScopes(false)]).toEqual(["blog:read", "offline_access"]);
    expect(clampToGrantable(["posts:write", "blog:read", "posts:delete"], false)).toEqual(["blog:read"]);
  });

  it("switch on grants every defined scope, still dropping unknown ones", () => {
    expect([...grantableScopeIds(true)]).toEqual([...MCP_SCOPE_IDS]);
    expect(clampToGrantable(["posts:write", "weird:scope", "posts:delete", "offline_access"], true)).toEqual(["posts:write", "posts:delete", "offline_access"]);
  });
});

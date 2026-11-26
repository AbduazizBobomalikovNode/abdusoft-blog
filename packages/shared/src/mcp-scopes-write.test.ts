import { describe, expect, it } from "vitest";
import { MCP_SCOPES, MCP_SCOPE_IDS, MCP_SOCIAL_SCOPE_ID, clampToGrantable, grantableOAuthScopes, grantableScopeIds } from "./mcp.js";

describe("write scopes are grantable only behind the switch", () => {
  it("default (switch off) is read-only plus offline_access", () => {
    expect([...grantableScopeIds()]).toEqual(["blog:read"]);
    expect([...grantableOAuthScopes(false)]).toEqual(["blog:read", "offline_access"]);
    expect(clampToGrantable(["posts:write", "blog:read", "posts:delete"], false)).toEqual(["blog:read"]);
  });

  it("switch on grants every pre-distribution scope (identical to before social posting existed), still dropping unknown ones", () => {
    // INTENTIONAL CHANGE of this test: `social:post` is defined but is NOT part of the write-only grant (needs the distribution flag too).
    expect([...grantableScopeIds(true)]).toEqual(MCP_SCOPE_IDS.filter((id) => id !== "social:post"));
    expect([...grantableScopeIds(true)]).toEqual(["blog:read", "posts:write", "media:upload", "channels:prepare", "posts:publish", "channels:send", "comments:moderate", "staff:manage", "settings:manage", "posts:delete"]);
    // INTENTIONAL CHANGE (connector coverage PR): the list now also holds its three new permissions; `social:post` is still excluded.
    expect(clampToGrantable(["posts:write", "weird:scope", "posts:delete", "offline_access"], true)).toEqual(["posts:write", "posts:delete", "offline_access"]);
  });
});

describe("social posting scope (social:post)", () => {
  const info = MCP_SCOPES.find((s) => s.id === MCP_SOCIAL_SCOPE_ID)!;

  it("is a separate publishing-group permission with its own Uzbek label naming the networks", () => {
    expect(MCP_SOCIAL_SCOPE_ID).toBe("social:post");
    expect(info.group).toBe("publish");
    expect(info.label).toBe("Ijtimoiy tarmoqlarga post chiqarish");
    for (const net of ["LinkedIn", "X", "Threads", "Instagram"]) expect(info.description).toContain(net);
    expect(info.id).not.toBe("channels:send");
  });

  it("is grantable only when BOTH the write switch and the distribution flag are on", () => {
    expect(grantableScopeIds(false, false)).not.toContain("social:post");
    expect(grantableScopeIds(false, true)).not.toContain("social:post");
    expect(grantableScopeIds(true, false)).not.toContain("social:post");
    expect(grantableScopeIds(true, true)).toContain("social:post");
    expect([...grantableScopeIds(true, true)]).toEqual([...MCP_SCOPE_IDS]);
    expect([...grantableOAuthScopes(false, true)]).toEqual(["blog:read", "offline_access"]);
  });

  it("is clamped away unless both switches are on", () => {
    const asked = ["blog:read", "social:post", "channels:send", "offline_access"];
    expect(clampToGrantable(asked, true, false)).toEqual(["blog:read", "channels:send", "offline_access"]);
    expect(clampToGrantable(asked, false, true)).toEqual(["blog:read", "offline_access"]);
    expect(clampToGrantable(asked, true, true)).toEqual(asked);
  });
});

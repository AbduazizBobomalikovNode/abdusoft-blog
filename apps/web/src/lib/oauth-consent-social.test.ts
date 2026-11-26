import { describe, expect, it } from "vitest";
import { MCP_SCOPES } from "@blog/shared";
import { defaultScopeSelection, describeConnectionPermissions, selectionSummary, serializeScopeSelection, toggleScope } from "./oauth-flow";

const WITH_SOCIAL = ["blog:read", "posts:write", "media:upload", "posts:publish", "channels:send", "social:post", "comments:moderate", "posts:delete", "offline_access"];

describe("consent page: social posting permission", () => {
  it("is never pre-ticked (like the other publishing permissions)", () => {
    expect(defaultScopeSelection(WITH_SOCIAL)).toEqual(["blog:read", "posts:write", "media:upload"]);
    expect(defaultScopeSelection(WITH_SOCIAL)).not.toContain("social:post");
    expect(defaultScopeSelection(["blog:read", "social:post"])).toEqual(["blog:read"]);
  });

  it("is toggled independently of the Telegram channel permission", () => {
    const base = defaultScopeSelection(WITH_SOCIAL);
    const withSocial = toggleScope(base, "social:post", WITH_SOCIAL);
    expect(withSocial).toContain("social:post");
    expect(withSocial).not.toContain("channels:send");
    const withTelegram = toggleScope(base, "channels:send", WITH_SOCIAL);
    expect(withTelegram).toContain("channels:send");
    expect(withTelegram).not.toContain("social:post");
  });

  it("is sent only when ticked, in MCP_SCOPES order", () => {
    expect(serializeScopeSelection(["channels:send"], WITH_SOCIAL)).toBe("blog:read channels:send offline_access");
    expect(serializeScopeSelection(["social:post", "channels:send"], WITH_SOCIAL)).toBe("blog:read channels:send social:post offline_access");
  });

  it("is listed in the publishing group with its own Uzbek label; absent when not requested (flag off)", () => {
    const requested = ["blog:read", "channels:send", "offline_access"];
    const labels = describeConnectionPermissions(requested).groups.flatMap((g) => g.labels);
    expect(labels).not.toContain("Ijtimoiy tarmoqlarga post chiqarish");
    const all = describeConnectionPermissions(WITH_SOCIAL).groups.find((g) => g.group === "publish")!;
    expect(all.labels).toContain("Ijtimoiy tarmoqlarga post chiqarish");
    expect(all.labels).toContain("Telegram kanalga yuborish");
    expect(selectionSummary(["blog:read"], requested).publish.total).toBe(1);
    expect(selectionSummary(["blog:read"], WITH_SOCIAL).publish.total).toBe(3);
  });

  it("MCP_SCOPES has it right after the Telegram permission", () => {
    const ids = MCP_SCOPES.map((s) => s.id);
    expect(ids.indexOf("social:post")).toBe(ids.indexOf("channels:send") + 1);
  });
});

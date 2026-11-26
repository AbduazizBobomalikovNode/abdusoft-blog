import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_WRITE_TOOLS_ENABLED = "true";
  process.env.DISTRIBUTION_ENABLED = "true";
});

describe("distribution flag on: the tools are loaded lazily by the index and registered", () => {
  it("lists the 4 read and 6 write distribution tools, the write ones needing social:post", async () => {
    const { getTools } = await import("./tools/index.js");
    const tools = getTools();
    const dist = tools.filter((t) => /distribution/.test(t.name));
    expect(dist.map((t) => t.name).sort()).toEqual(
      ["cancel_distribution", "get_distribution_status", "list_distribution_channels", "list_post_distributions", "preview_distribution", "remove_distribution_from_platform", "retry_distribution", "save_distribution_text", "schedule_distribution", "send_distribution"].sort(),
    );
    for (const t of dist.filter((x) => x.kind === "write")) expect(t.scope, t.name).toBe("social:post");
    for (const t of dist.filter((x) => x.kind === "read")) expect(t.scope, t.name).toBe("blog:read");
    expect(dist.filter((x) => x.kind === "write" && ["send_distribution", "schedule_distribution", "retry_distribution"].includes(x.name)).every((x) => x.limit === "social")).toBe(true);
    expect(tools.find((t) => t.name === "send_to_channel")!.scope).toBe("channels:send");
  });
});

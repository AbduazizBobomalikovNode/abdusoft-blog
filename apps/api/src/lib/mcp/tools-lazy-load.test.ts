import { describe, expect, it, vi } from "vitest";

// Bayroq o'chiq: konnektor vositalari indeksi tarqatish servisini, rasm modulini va vosita modulini UMUMAN yuklamaydi.
vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_WRITE_TOOLS_ENABLED = "true";
  delete process.env.DISTRIBUTION_ENABLED;
});

const loaded = vi.hoisted(() => [] as string[]);
vi.mock("../distribution/service/actions.js", () => {
  loaded.push("service/actions");
  return {};
});
vi.mock("../distribution/service/images.js", () => {
  loaded.push("service/images");
  return {};
});
vi.mock("../distribution/service/prepare.js", () => {
  loaded.push("service/prepare");
  return {};
});
vi.mock("./tools/distribution-tools.js", () => {
  loaded.push("tools/distribution-tools");
  return { DISTRIBUTION_READ_TOOLS: [], DISTRIBUTION_WRITE_TOOLS: [] };
});

describe("distribution flag off: nothing of the distribution code is loaded by the connector", () => {
  it("importing the tool index and listing tools loads no distribution module", async () => {
    const { getTools } = await import("./tools/index.js");
    const names = getTools().map((t) => t.name);
    expect(names.filter((n) => /distribution/.test(n))).toEqual([]);
    expect(names.length).toBeGreaterThan(10);
    expect(loaded).toEqual([]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDistributionModule } from "./load-guard.js";

afterEach(() => vi.restoreAllMocks());

describe("loadDistributionModule", () => {
  it("returns the module untouched and logs nothing on success", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const mod = { x: 1 };
    expect(await loadDistributionModule("m", async () => mod)).toBe(mod);
    expect(log).not.toHaveBeenCalled();
  });

  it("logs ONE clear line naming the module and the flag, then rethrows the original error (fail-fast stays)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const boom = new Error("Cannot find module './x.js'");
    await expect(loadDistributionModule("routes/admin-distribution", async () => Promise.reject(boom))).rejects.toBe(boom);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]![0]);
    expect(line).toContain("DISTRIBUTION_ENABLED=true");
    expect(line).toContain("routes/admin-distribution");
    expect(line).toContain("Cannot find module");
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_MIGRATE_LOCK_TIMEOUT_MS, lockTimeoutStartupOption, resolveMigrateLockTimeoutMs } from "./migrate-options.js";

describe("migration lock_timeout", () => {
  it("defaults to 15 s when unset, empty or invalid", () => {
    for (const raw of [undefined, "", "  ", "abc", "-5", "1.5"]) {
      expect(resolveMigrateLockTimeoutMs(raw)).toBe(DEFAULT_MIGRATE_LOCK_TIMEOUT_MS);
    }
    expect(DEFAULT_MIGRATE_LOCK_TIMEOUT_MS).toBe(15_000);
  });

  it("accepts a custom value and 0 to disable", () => {
    expect(resolveMigrateLockTimeoutMs("30000")).toBe(30_000);
    expect(resolveMigrateLockTimeoutMs("0")).toBe(0);
    expect(lockTimeoutStartupOption(30_000)).toBe("-c lock_timeout=30000");
    expect(lockTimeoutStartupOption(0)).toBeUndefined();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

async function loadConfig(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return (await import("../config.js")).config;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("password reset env", () => {
  it("defaults to a 20 minute link and 3 messages per account per hour (empty values count as unset)", async () => {
    expect(await loadConfig({})).toMatchObject({ PASSWORD_RESET_TTL_MINUTES: 20, PASSWORD_RESET_MAX_PER_HOUR: 3 });
    expect(await loadConfig({ PASSWORD_RESET_TTL_MINUTES: "", PASSWORD_RESET_MAX_PER_HOUR: " " })).toMatchObject({
      PASSWORD_RESET_TTL_MINUTES: 20,
      PASSWORD_RESET_MAX_PER_HOUR: 3,
    });
  });

  it("accepts overrides inside the allowed range and refuses a long-lived link at boot", async () => {
    expect(await loadConfig({ PASSWORD_RESET_TTL_MINUTES: "15", PASSWORD_RESET_MAX_PER_HOUR: "5" })).toMatchObject({
      PASSWORD_RESET_TTL_MINUTES: 15,
      PASSWORD_RESET_MAX_PER_HOUR: 5,
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(loadConfig({ PASSWORD_RESET_TTL_MINUTES: "120" })).rejects.toThrow("Invalid environment variables");
    await expect(loadConfig({ PASSWORD_RESET_TTL_MINUTES: "5" })).rejects.toThrow("Invalid environment variables");
  });
});

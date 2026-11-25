import { afterEach, describe, expect, it, vi } from "vitest";

async function loadConfig(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return (await import("../config.js")).config;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("rate limit env defaults", () => {
  it("uses conservative defaults when nothing is set", async () => {
    const config = await loadConfig({});
    expect(config).toMatchObject({
      AUTH_RATE_LIMIT_ENABLED: undefined,
      AUTH_RATE_LIMIT_MAX: 10,
      AUTH_RATE_LIMIT_WINDOW_SECONDS: 600,
      ADMIN_WRITE_RATE_LIMIT_MAX: 300,
      ADMIN_WRITE_RATE_LIMIT_WINDOW_SECONDS: 60,
    });
  });

  it("treats empty values (as in .env.example) like unset, not like 0", async () => {
    const config = await loadConfig({
      AUTH_RATE_LIMIT_ENABLED: "",
      AUTH_RATE_LIMIT_MAX: "",
      AUTH_RATE_LIMIT_WINDOW_SECONDS: " ",
      ADMIN_WRITE_RATE_LIMIT_MAX: "",
      ADMIN_WRITE_RATE_LIMIT_WINDOW_SECONDS: "",
    });
    expect(config.AUTH_RATE_LIMIT_ENABLED).toBeUndefined();
    expect(config.AUTH_RATE_LIMIT_MAX).toBe(10);
    expect(config.AUTH_RATE_LIMIT_WINDOW_SECONDS).toBe(600);
    expect(config.ADMIN_WRITE_RATE_LIMIT_MAX).toBe(300);
    expect(config.ADMIN_WRITE_RATE_LIMIT_WINDOW_SECONDS).toBe(60);
  });

  it("reads overrides, including the explicit on/off switch and 0 to disable admin limiting", async () => {
    const config = await loadConfig({
      AUTH_RATE_LIMIT_ENABLED: "false",
      AUTH_RATE_LIMIT_MAX: "25",
      ADMIN_WRITE_RATE_LIMIT_MAX: "0",
    });
    expect(config.AUTH_RATE_LIMIT_ENABLED).toBe(false);
    expect(config.AUTH_RATE_LIMIT_MAX).toBe(25);
    expect(config.ADMIN_WRITE_RATE_LIMIT_MAX).toBe(0);
  });
});

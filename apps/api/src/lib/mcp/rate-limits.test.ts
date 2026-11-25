import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { CLAUDE_REDIRECT, MCP_URL, register } from "../../test/mcp-harness.js";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.TRUST_PROXY = "true";
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "2";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "5";
  process.env.MCP_REGISTRATION_RATE_LIMIT_WINDOW_SECONDS = "3600";
  process.env.MCP_RATE_LIMIT_MAX = "4";
  process.env.MCP_RATE_LIMIT_WINDOW_SECONDS = "60";
});

let app: Hono;
beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
});

const body = { client_name: "Claude", redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: "none" };

describe("registration rate limit", () => {
  it("limits a single IP, answering 429 with Retry-After, without affecting other IPs", async () => {
    expect((await register(app, body, "198.51.100.1")).status).toBe(201);
    expect((await register(app, body, "198.51.100.1")).status).toBe(201);
    const blocked = await register(app, body, "198.51.100.1");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await blocked.json()) as { error: string }).error).toBe("temporarily_unavailable");
    expect((await register(app, body, "198.51.100.2")).status).toBe(201);
  });

  it("also counts rejected registrations, and caps the total across all IPs", async () => {
    // Hozirgacha: .1 -> 2 ta, .2 -> 1 ta (jami 3 ta o'tdi). Rad etilgan urinish ham global hisobga kiradi.
    const rejected = await register(app, { ...body, redirect_uris: ["https://evil.example/cb"] }, "198.51.100.3");
    expect(rejected.status).toBe(400);
    expect((await register(app, body, "198.51.100.3")).status).toBe(201); // global: 5-chi
    const overGlobal = await register(app, body, "198.51.100.4");
    expect(overGlobal.status).toBe(429);
  });
});

describe("/mcp rate limit", () => {
  it("answers 429 with Retry-After after the configured number of requests per IP", async () => {
    const hit = (ip: string) =>
      app.request(MCP_URL, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: "{}" });
    for (let i = 0; i < 4; i += 1) expect((await hit("203.0.113.9")).status).toBe(401);
    const blocked = await hit("203.0.113.9");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await hit("203.0.113.10")).status).toBe(401);
  });
});

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../test/migrate-test-db.js";

// Limitlar kichik qiymatlar bilan; `config.ts` (db import orqali) yuklanishidan OLDIN o'rnatilishi
// uchun `vi.hoisted` ichida — oddiy import'lar hoist qilinadi.
vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_ENABLED = "true";
  process.env.AUTH_RATE_LIMIT_MAX = "3";
  process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS = "600";
  process.env.ADMIN_WRITE_RATE_LIMIT_MAX = "4";
  process.env.ADMIN_WRITE_RATE_LIMIT_WINDOW_SECONDS = "60";
  process.env.TRUST_PROXY = "true";
});

let app: Hono;

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../app.js"));
});

function signIn(ip: string, extra: Record<string, string> = {}) {
  return app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      "x-forwarded-for": ip,
      ...extra,
    },
    body: JSON.stringify({ email: "nobody@example.test", password: "wrong-password-123" }),
  });
}

describe("Better Auth sign-in rate limit", () => {
  it("lets failed attempts through until the limit, then answers 429 with Retry-After", async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await signIn("10.0.0.1");
      expect(res.status).toBe(401);
    }

    const blocked = await signIn("10.0.0.1");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("content-type")).toContain("application/json");
    const retryAfter = Number(blocked.headers.get("retry-after"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(600);
    expect(await blocked.json()).toMatchObject({ message: expect.any(String) });
  });

  it("counts per client IP, so another client is not locked out", async () => {
    const res = await signIn("10.0.0.2");
    expect(res.status).toBe(401);
  });

  it("ignores a client-supplied internal IP header (cannot dodge the limit)", async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await signIn("10.0.0.3", { "x-blog-client-ip": `1.1.1.${i}` })).status).toBe(401);
    }
    const res = await signIn("10.0.0.3", { "x-blog-client-ip": "8.8.8.8" });
    expect(res.status).toBe(429);
  });

  it("uses the last X-Forwarded-For hop like the rest of the API (TRUST_PROXY)", async () => {
    for (let i = 0; i < 3; i += 1) {
      // Mijoz o'zi soxta oldingi hop qo'shishi mumkin — hisob oxirgi hop bo'yicha.
      expect((await signIn(`6.6.6.${i}, 10.0.0.4`)).status).toBe(401);
    }
    expect((await signIn("7.7.7.7, 10.0.0.4")).status).toBe(429);
  });

  it("keeps the public read endpoint working", async () => {
    const res = await app.request("/api/auth/get-session", { headers: { "x-forwarded-for": "10.0.0.1" } });
    expect(res.status).toBe(200);
  });
});

describe("admin write rate limit", () => {
  const write = (ip: string) =>
    app.request("/admin/posts", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: "{}",
    });

  it("limits write requests per IP (even unauthenticated) and sends Retry-After", async () => {
    for (let i = 0; i < 4; i += 1) {
      expect((await write("10.1.0.1")).status).toBe(401);
    }
    const blocked = await write("10.1.0.1");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await blocked.json()).toMatchObject({ retryAfter: expect.any(Number) });
  });

  it("does not limit reads, and does not affect another IP", async () => {
    for (let i = 0; i < 10; i += 1) {
      const res = await app.request("/admin/me", { headers: { "x-forwarded-for": "10.1.0.1" } });
      expect(res.status).toBe(401);
    }
    expect((await write("10.1.0.2")).status).toBe(401);
  });
});

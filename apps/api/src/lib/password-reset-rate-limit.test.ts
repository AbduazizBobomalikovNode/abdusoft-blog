import type { Hono } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { migrateTestDb } from "../test/migrate-test-db.js";
import { API, WEB, openLink, postReset, requestReset } from "../test/password-reset-helpers.js";

/**
 * Per-IP limiter har bir tiklash endpoint'ini qoplaydi: POST /request-password-reset, POST /reset-password
 * (Better Auth `customRules`) va GET /reset-password/:token (havolani ochish) — oxirgisi Better Auth kaliti
 * tokenni o'z ichiga olgani uchun `lib/auth-handler.ts`dagi alohida IP chegarasi bilan.
 */
vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_ENABLED = "true";
  process.env.AUTH_RATE_LIMIT_MAX = "3";
  process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS = "600";
  process.env.TRUST_PROXY = "true";
});

let app: Hono;

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../app.js"));
});

describe("per-IP limits on the password reset endpoints", () => {
  it("POST /request-password-reset: 429 with Retry-After on the 4th request, other IPs unaffected", async () => {
    const ip = "192.0.2.10";
    for (let i = 0; i < 3; i += 1) expect((await requestReset(app, "x@example.test", ip)).status).toBe(200);
    const blocked = await requestReset(app, "x@example.test", ip);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await requestReset(app, "x@example.test", "192.0.2.11")).status).toBe(200);
  });

  it("POST /reset-password: 429 with Retry-After on the 4th attempt", async () => {
    const ip = "192.0.2.20";
    for (let i = 0; i < 3; i += 1) {
      expect((await postReset(app, { token: `bogus-${i}`, newPassword: "yangi-juda-uzun-parol-2026" }, ip)).status).toBe(400);
    }
    const blocked = await postReset(app, { token: "bogus-4", newPassword: "yangi-juda-uzun-parol-2026" }, ip);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(blocked.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("retry-after");
  });

  it("GET /reset-password/:token: guessing different tokens from one IP is limited, with the wait passed to the web page", async () => {
    const ip = "192.0.2.30";
    const link = (n: number) => `${API}/api/auth/reset-password/guess-${n}?callbackURL=${encodeURIComponent(`${WEB}/parolni-tiklash`)}`;
    for (let i = 0; i < 3; i += 1) {
      const res = await openLink(app, link(i), ip);
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("INVALID_TOKEN");
    }
    const blocked = await openLink(app, link(99), ip);
    expect(blocked.status).toBe(302);
    const location = new URL(blocked.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(`${WEB}/parolni-tiklash`);
    expect(location.searchParams.get("error")).toBe("RATE_LIMITED");
    expect(Number(location.searchParams.get("wait"))).toBeGreaterThan(0);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);

    // Boshqa IP — to'siq yo'q.
    const other = await openLink(app, link(100), "192.0.2.31");
    expect(new URL(other.headers.get("location")!).searchParams.get("error")).toBe("INVALID_TOKEN");
  });
});

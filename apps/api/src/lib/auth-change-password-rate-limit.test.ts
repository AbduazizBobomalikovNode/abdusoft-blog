import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../test/migrate-test-db.js";
import { createTestUser } from "../test/auth-test-helpers.js";

/**
 * Better Auth rate limiter `/change-password`ni haqiqatan ham cheklaydi.
 * NODE_ENV=test'da u standart bo'yicha o'chiq, shu sabab bu yerda env orqali yoqiladi
 * (config import qilinishidan oldin; har bir test fayli alohida jarayon — boshqa testlarga ta'sir qilmaydi).
 */
vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_ENABLED = "true";
  process.env.AUTH_RATE_LIMIT_MAX = "3";
  process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS = "600";
});

const INITIAL_PASSWORD = "test-password-123456";

let app: Hono;
let webOrigin: string;

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../app.js"));
  webOrigin = (await import("../config.js")).config.WEB_ORIGIN;
});

function changePassword(cookie: string, body: Record<string, unknown>) {
  return app.request("/api/auth/change-password", {
    method: "POST",
    headers: { origin: webOrigin, "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

describe("change-password rate limit", () => {
  it("answers 429 with a readable Retry-After after the configured number of attempts", async () => {
    const admin = await createTestUser({ role: "admin" });
    const wrong = { currentPassword: "bu-parol-notogri-123", newPassword: "yangi-juda-uzun-parol-2026" };

    for (let i = 0; i < 3; i += 1) {
      expect((await changePassword(admin.cookie, wrong)).status).toBe(400);
    }

    const blocked = await changePassword(admin.cookie, wrong);
    expect(blocked.status).toBe(429);
    const retryAfter = Number(blocked.headers.get("retry-after"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(600);

    // Brauzer cross-origin javobda `Retry-After`ni JS'ga ko'rsatishi uchun expose qilingan bo'lishi shart.
    expect(blocked.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("retry-after");

    // Limit tugagach to'g'ri parol ham o'tmaydi (brute-force'ni to'xtatadi).
    const correct = await changePassword(admin.cookie, {
      currentPassword: INITIAL_PASSWORD,
      newPassword: "yangi-juda-uzun-parol-2026",
    });
    expect(correct.status).toBe(429);
  });
});

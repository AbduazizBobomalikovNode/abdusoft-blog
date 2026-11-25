import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { migrateTestDb } from "../test/migrate-test-db.js";
import { createTestUser, type TestUser } from "../test/auth-test-helpers.js";

/**
 * `POST /api/auth/change-password` — haqiqiy `lib/auth.ts` konfiguratsiyasi
 * (`app.ts` -> `handleAuthRequest` -> `auth.handler`) bilan, PGlite ustida.
 * Rate limit bu faylda o'chiq (NODE_ENV=test); u `auth-change-password-rate-limit.test.ts`da tekshiriladi.
 */

// `test/auth-test-helpers.ts` yaratgan foydalanuvchilarning parol qiymati (u yerda eksport qilinmaydi).
const INITIAL_PASSWORD = "test-password-123456";
const NEW_PASSWORD = "yangi-juda-uzun-parol-2026";

let app: Hono;
let db: typeof import("../db/index.js").db;
let schema: typeof import("../db/auth-schema.js");
let webOrigin: string;

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../app.js"));
  ({ db } = await import("../db/index.js"));
  schema = await import("../db/auth-schema.js");
  webOrigin = (await import("../config.js")).config.WEB_ORIGIN;
});

function cookiesFrom(res: Response): string {
  return (res.headers.getSetCookie?.() ?? []).map((raw) => raw.split(";")[0]).join("; ");
}

async function authPost(path: string, body: unknown, cookie?: string | null): Promise<Response> {
  return app.request(`/api/auth${path}`, {
    method: "POST",
    headers: {
      origin: webOrigin,
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

const changePassword = (cookie: string | null, body: Record<string, unknown>) => authPost("/change-password", body, cookie);

async function signIn(email: string, password: string): Promise<{ status: number; cookie: string }> {
  const res = await authPost("/sign-in/email", { email, password });
  return { status: res.status, cookie: cookiesFrom(res) };
}

/** Haqiqiy panel marshruti (`/admin/me`) sessiyani Better Auth orqali tekshiradi. */
async function panelStatus(cookie: string): Promise<number> {
  return (await app.request("/admin/me", { headers: { cookie } })).status;
}

async function sessionCount(userId: string): Promise<number> {
  return (await db.select().from(schema.session).where(eq(schema.session.userId, userId))).length;
}

async function expectPasswordWorks(u: TestUser, password: string) {
  expect((await signIn(u.email, password)).status).toBe(200);
}
async function expectPasswordRejected(u: TestUser, password: string) {
  expect((await signIn(u.email, password)).status).toBe(401);
}

describe("server password rules (read from the real Better Auth config)", () => {
  it("minimum 8 and maximum 128 characters", async () => {
    const { auth } = await import("./auth.js");
    const ctx = await auth.$context;
    expect(ctx.password.config.minPasswordLength).toBe(8);
    expect(ctx.password.config.maxPasswordLength).toBe(128);
  });
});

describe("change-password: success path", () => {
  it("changes the password: old one stops working, new one works", async () => {
    const admin = await createTestUser({ role: "admin" });
    const res = await changePassword(admin.cookie, {
      currentPassword: INITIAL_PASSWORD,
      newPassword: NEW_PASSWORD,
      revokeOtherSessions: true,
    });
    expect(res.status).toBe(200);

    await expectPasswordRejected(admin, INITIAL_PASSWORD);
    await expectPasswordWorks(admin, NEW_PASSWORD);
  });

  it("revokeOtherSessions ends other devices while the current browser stays signed in", async () => {
    const admin = await createTestUser({ role: "admin" });
    const current = await signIn(admin.email, INITIAL_PASSWORD);
    const otherDevice = await signIn(admin.email, INITIAL_PASSWORD);
    expect(current.status).toBe(200);
    expect(otherDevice.status).toBe(200);
    expect(await panelStatus(current.cookie)).toBe(200);
    expect(await panelStatus(otherDevice.cookie)).toBe(200);
    expect(await sessionCount(admin.id)).toBeGreaterThanOrEqual(3);

    const res = await changePassword(current.cookie, {
      currentPassword: INITIAL_PASSWORD,
      newPassword: NEW_PASSWORD,
      revokeOtherSessions: true,
    });
    expect(res.status).toBe(200);

    // Javob yangi sessiya cookie'sini qaytaradi — brauzer shuni saqlaydi va kirgan holatda qoladi.
    const refreshed = cookiesFrom(res);
    expect(refreshed).toContain("session_token");
    expect(await panelStatus(refreshed)).toBe(200);

    // Boshqa qurilmalar (jumladan helper'dagi birinchi sessiya) tugatilgan.
    expect(await panelStatus(otherDevice.cookie)).toBe(401);
    expect(await panelStatus(admin.cookie)).toBe(401);
    expect(await sessionCount(admin.id)).toBe(1);
  });

  it("without revokeOtherSessions other sessions and the current cookie are untouched", async () => {
    const admin = await createTestUser({ role: "admin" });
    const otherDevice = await signIn(admin.email, INITIAL_PASSWORD);

    const res = await changePassword(admin.cookie, { currentPassword: INITIAL_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);

    expect(await panelStatus(admin.cookie)).toBe(200);
    expect(await panelStatus(otherDevice.cookie)).toBe(200);
    await expectPasswordRejected(admin, INITIAL_PASSWORD);
    await expectPasswordWorks(admin, NEW_PASSWORD);
  });

  it("works for staff, and the server accepts 8 characters (the form enforces 12 on its own)", async () => {
    const staff = await createTestUser({ role: "staff" });
    const res = await changePassword(staff.cookie, { currentPassword: INITIAL_PASSWORD, newPassword: "12345678" });
    expect(res.status).toBe(200);
    await expectPasswordWorks(staff, "12345678");
  });
});

describe("change-password: rejections", () => {
  it("wrong current password: 400 INVALID_PASSWORD, nothing changes, no cookie is issued", async () => {
    const admin = await createTestUser({ role: "admin" });
    const otherDevice = await signIn(admin.email, INITIAL_PASSWORD);

    const res = await changePassword(admin.cookie, {
      currentPassword: "bu-parol-notogri-123",
      newPassword: NEW_PASSWORD,
      revokeOtherSessions: true,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("INVALID_PASSWORD");
    expect(res.headers.getSetCookie?.() ?? []).toHaveLength(0);

    await expectPasswordWorks(admin, INITIAL_PASSWORD);
    await expectPasswordRejected(admin, NEW_PASSWORD);
    expect(await panelStatus(admin.cookie)).toBe(200);
    expect(await panelStatus(otherDevice.cookie)).toBe(200);
  });

  it("too short and too long new passwords are rejected by the server", async () => {
    const admin = await createTestUser({ role: "admin" });

    const short = await changePassword(admin.cookie, { currentPassword: INITIAL_PASSWORD, newPassword: "1234567" });
    expect(short.status).toBe(400);
    expect(((await short.json()) as { code?: string }).code).toBe("PASSWORD_TOO_SHORT");

    const long = await changePassword(admin.cookie, { currentPassword: INITIAL_PASSWORD, newPassword: "x".repeat(129) });
    expect(long.status).toBe(400);
    expect(((await long.json()) as { code?: string }).code).toBe("PASSWORD_TOO_LONG");

    const max = await changePassword(admin.cookie, { currentPassword: INITIAL_PASSWORD, newPassword: "y".repeat(128) });
    expect(max.status).toBe(200);
    await expectPasswordWorks(admin, "y".repeat(128));
  });

  it("is impossible without the current password", async () => {
    const admin = await createTestUser({ role: "admin" });

    const missing = await changePassword(admin.cookie, { newPassword: NEW_PASSWORD });
    expect(missing.status).toBe(400);

    const empty = await changePassword(admin.cookie, { currentPassword: "", newPassword: NEW_PASSWORD });
    expect(empty.status).toBe(400);

    // `set-password` faqat server ichidan chaqiriladi — HTTP orqali mavjud emas.
    const setPassword = await authPost("/set-password", { newPassword: NEW_PASSWORD }, admin.cookie);
    expect(setPassword.status).toBe(404);

    await expectPasswordWorks(admin, INITIAL_PASSWORD);
    await expectPasswordRejected(admin, NEW_PASSWORD);
  });

  it("rejects unauthenticated requests", async () => {
    const admin = await createTestUser({ role: "admin" });
    const body = { currentPassword: INITIAL_PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: true };

    expect((await changePassword(null, body)).status).toBe(401);
    expect((await changePassword("better-auth.session_token=garbage.value", body)).status).toBe(401);

    await expectPasswordWorks(admin, INITIAL_PASSWORD);
    await expectPasswordRejected(admin, NEW_PASSWORD);
  });
});

describe("change-password: a user can only change their own", () => {
  it("staff cannot affect the admin: extra identity fields are ignored, the admin's password is unchanged", async () => {
    const admin = await createTestUser({ role: "admin" });
    const staff = await createTestUser({ role: "staff" });

    // Xodim admin hisobini nishonga olishga urinadi (userId/email maydonlari) — endpoint ularni qabul qilmaydi.
    const res = await changePassword(staff.cookie, {
      currentPassword: INITIAL_PASSWORD,
      newPassword: NEW_PASSWORD,
      userId: admin.id,
      email: admin.email,
    });
    expect(res.status).toBe(200);

    await expectPasswordWorks(staff, NEW_PASSWORD);
    await expectPasswordRejected(staff, INITIAL_PASSWORD);
    await expectPasswordWorks(admin, INITIAL_PASSWORD);
    await expectPasswordRejected(admin, NEW_PASSWORD);
  });

  it("the current password is checked against the caller's own account", async () => {
    const admin = await createTestUser({ role: "admin" });
    const staff = await createTestUser({ role: "staff" });
    await changePassword(admin.cookie, { currentPassword: INITIAL_PASSWORD, newPassword: NEW_PASSWORD });

    // Xodim admin'ning yangi parolini "joriy parol" sifatida ko'rsatsa ham o'tmaydi.
    const res = await changePassword(staff.cookie, { currentPassword: NEW_PASSWORD, newPassword: "boshqa-parol-98765" });
    expect(res.status).toBe(400);
    await expectPasswordWorks(staff, INITIAL_PASSWORD);
    await expectPasswordWorks(admin, NEW_PASSWORD);
  });
});

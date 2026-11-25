import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMockTelegram } from "../../scripts/mock-telegram.js";
import { db } from "../db/index.js";
import { auditLog } from "../db/schema.js";
import { verification } from "../db/auth-schema.js";
import { reconfigureBot } from "../telegram/client.js";
import { createTestUser, TEST_USER_PASSWORD, type TestUser } from "../test/auth-test-helpers.js";
import { migrateTestDb } from "../test/migrate-test-db.js";
import { API, WEB, openLink, postReset, signIn, tgCalls, tokenFromLink, type MockTelegram } from "../test/password-reset-helpers.js";

vi.hoisted(() => {
  process.env.TRUST_PROXY = "true";
  process.env.PASSWORD_RESET_TTL_MINUTES = "20";
});

const NEW_PASSWORD = "yangi-juda-uzun-parol-2026";

let mock: MockTelegram;
let app: Hono;

async function auditFor(userId: string, action: string) {
  const rows = await db.select().from(auditLog);
  return rows.filter((r) => r.entityId === userId && r.action === action);
}

beforeAll(async () => {
  mock = await startMockTelegram();
  await migrateTestDb();
  ({ app } = await import("../app.js"));
  const { saveSettings, invalidateSettingsCache } = await import("../lib/settings.js");
  delete process.env.TELEGRAM_API_ROOT;
  invalidateSettingsCache();
  await saveSettings({ telegram: { botToken: "test-bot-token", webhookSecret: "0123456789abcdef", adminChatId: "424242", apiRoot: mock.url } });
  reconfigureBot("test-bot-token", mock.url);
});

afterAll(async () => {
  reconfigureBot("", "");
  await mock.close();
});

describe("POST /admin/staff/:userId/password-reset-link", () => {
  const create = (cookie: string | null, userId: string) =>
    app.request(`${API}/admin/staff/${userId}/password-reset-link`, {
      method: "POST",
      headers: { origin: WEB, ...(cookie ? { cookie } : {}) },
    });

  let admin: TestUser;
  beforeAll(async () => {
    admin = await createTestUser({ role: "admin" });
  });

  it("is admin-only", async () => {
    const staff = await createTestUser({ role: "staff" });
    const other = await createTestUser({ role: "staff" });
    expect((await create(null, staff.id)).status).toBe(401);
    expect((await create(staff.cookie, other.id)).status).toBe(403);
    expect((await create(staff.cookie, staff.id)).status).toBe(403);
  });

  it("refuses admins (including the caller), plain users and unknown ids", async () => {
    const otherAdmin = await createTestUser({ role: "admin" });
    const user = await createTestUser({ role: "user" });
    expect((await create(admin.cookie, admin.id)).status).toBe(403);
    expect((await create(admin.cookie, otherAdmin.id)).status).toBe(403);
    expect((await create(admin.cookie, user.id)).status).toBe(404);
    expect((await create(admin.cookie, "no-such-user")).status).toBe(404);
    expect(await db.select().from(verification).where(eq(verification.value, otherAdmin.id))).toHaveLength(0);
  });

  it("returns a one-time link that sets the staff password, ends their sessions, works once and is audited without the token", async () => {
    const staff = await createTestUser({ role: "staff" });
    const res = await create(admin.cookie, staff.id);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { url, expiresAt } = (await res.json()) as { url: string; expiresAt: string };
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(19 * 60_000);
    expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(20 * 60_000 + 5_000);
    expect(await tgCalls(mock, "sendMessage")).toHaveLength(0);

    const opened = await openLink(app, url);
    expect(opened.status).toBe(302);
    const token = new URL(opened.headers.get("location")!).searchParams.get("token")!;
    expect(token).toBe(tokenFromLink(url));

    expect((await postReset(app, { token, newPassword: NEW_PASSWORD })).status).toBe(200);
    expect((await signIn(app, staff.email, TEST_USER_PASSWORD)).status).toBe(401);
    expect((await signIn(app, staff.email, NEW_PASSWORD)).status).toBe(200);
    const old = await app.request(`${API}/api/auth/get-session`, { headers: { cookie: staff.cookie } });
    expect(await old.json()).toBeNull();
    expect((await postReset(app, { token, newPassword: "boshqa-uzun-parol-2027" })).status).toBe(400);

    const [created] = await auditFor(staff.id, "staff.password_link_create");
    expect(created!.actorUserId).toBe(admin.id);
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain(token);
    expect((await auditFor(staff.id, "auth.password_reset_complete")).length).toBe(1);
  });

  it("a newer link retires the previous one", async () => {
    const staff = await createTestUser({ role: "staff" });
    const first = ((await (await create(admin.cookie, staff.id)).json()) as { url: string }).url;
    const second = ((await (await create(admin.cookie, staff.id)).json()) as { url: string }).url;
    expect((await postReset(app, { token: tokenFromLink(first), newPassword: NEW_PASSWORD })).status).toBe(400);
    expect((await postReset(app, { token: tokenFromLink(second), newPassword: NEW_PASSWORD })).status).toBe(200);
  });
});


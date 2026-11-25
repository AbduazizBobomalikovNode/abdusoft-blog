import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.js";
import { auditLog } from "../db/schema.js";
import { session } from "../db/auth-schema.js";
import { createTestUser, TEST_USER_PASSWORD } from "../test/auth-test-helpers.js";
import { migrateTestDb } from "../test/migrate-test-db.js";
import { signIn } from "../test/password-reset-helpers.js";

vi.hoisted(() => {
  process.env.TRUST_PROXY = "true";
});

let app: Hono;
let resetPasswordOnServer: typeof import("./server-password-reset.js").resetPasswordOnServer;

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../app.js"));
  ({ resetPasswordOnServer } = await import("./server-password-reset.js"));
});

describe("server-side password reset (scripts/reset-password.ts)", () => {
  it("sets the new password, ends every session and audits without the password", async () => {
    const admin = await createTestUser({ role: "admin" });
    const next = "server-side-new-password-2026";
    const result = await resetPasswordOnServer(admin.email, next);
    expect(result).toEqual({ ok: true, userId: admin.id });

    expect(await db.select().from(session).where(eq(session.userId, admin.id))).toHaveLength(0);
    expect((await signIn(app, admin.email, TEST_USER_PASSWORD)).status).toBe(401);
    expect((await signIn(app, admin.email, next)).status).toBe(200);
    const entries = await db.select().from(auditLog).where(eq(auditLog.entityId, admin.id));
    expect(entries.some((e) => e.action === "auth.password_reset_server")).toBe(true);
    expect(JSON.stringify(entries)).not.toContain(next);
  });

  it("refuses unknown e-mails and passwords outside 12..128 characters", async () => {
    const admin = await createTestUser({ role: "admin" });
    expect(await resetPasswordOnServer("nobody@example.test", "long-enough-password-1")).toEqual({ ok: false, reason: "not_found" });
    expect(await resetPasswordOnServer(admin.email, "short")).toEqual({ ok: false, reason: "too_short" });
    expect(await resetPasswordOnServer(admin.email, "x".repeat(129))).toEqual({ ok: false, reason: "too_long" });
    expect((await signIn(app, admin.email, TEST_USER_PASSWORD)).status).toBe(200);
  });
});

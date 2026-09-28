import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { staffInvites } from "../db/schema.js";
import { user } from "../db/auth-schema.js";
import { migrateTestDb } from "../test/migrate-test-db.js";
import { acceptStaffInvite, createStaffInvite, findInviteByToken, revokeStaffInvite } from "./staff-invites.js";

async function createUser(role: "admin" | "staff" | "user", email: string) {
  const [row] = await db.insert(user).values({ id: crypto.randomUUID(), name: email, email, role }).returning();
  return row!.id;
}

beforeAll(async () => {
  await migrateTestDb();
});

describe("staff invites — single use, expiry, revoke", () => {
  it("a freshly created invite validates as active", async () => {
    const ownerId = await createUser("admin", "owner1@example.test");
    const { token } = await createStaffInvite(ownerId, "Yangi xodim uchun");
    const lookup = await findInviteByToken(token);
    expect(lookup?.status).toBe("active");
    expect(lookup?.row.note).toBe("Yangi xodim uchun");
  });

  it("accepting marks the invite used and a second accept fails (single-use)", async () => {
    const ownerId = await createUser("admin", "owner2@example.test");
    const acceptorId = await createUser("user", "acceptor1@example.test");
    const { token } = await createStaffInvite(ownerId, null);

    const first = await acceptStaffInvite(token, acceptorId);
    expect(first).toEqual({ ok: true, role: "staff" });

    const [updated] = await db.select({ role: user.role }).from(user).where(eq(user.id, acceptorId)).limit(1);
    expect(updated?.role).toBe("staff");

    const second = await acceptStaffInvite(token, acceptorId);
    expect(second).toEqual({ ok: false, reason: "used" });

    const lookup = await findInviteByToken(token);
    expect(lookup?.status).toBe("used");
  });

  it("an expired invite cannot be accepted", async () => {
    const ownerId = await createUser("admin", "owner3@example.test");
    const acceptorId = await createUser("user", "acceptor2@example.test");
    const { invite, token } = await createStaffInvite(ownerId, null);

    // Muddatini sun'iy ravishda o'tkazib yuboramiz (yaratilgandan keyin, DB'da).
    await db.update(staffInvites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(staffInvites.id, invite.id));

    const lookup = await findInviteByToken(token);
    expect(lookup?.status).toBe("expired");

    const result = await acceptStaffInvite(token, acceptorId);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("a revoked invite cannot be accepted, and revoking twice fails", async () => {
    const ownerId = await createUser("admin", "owner4@example.test");
    const acceptorId = await createUser("user", "acceptor3@example.test");
    const { invite, token } = await createStaffInvite(ownerId, null);

    const revoked = await revokeStaffInvite(invite.id);
    expect(revoked).toBe(true);

    const revokedAgain = await revokeStaffInvite(invite.id);
    expect(revokedAgain).toBe(false);

    const result = await acceptStaffInvite(token, acceptorId);
    expect(result).toEqual({ ok: false, reason: "revoked" });
  });

  it("an unknown token reports not_found for both lookup and accept", async () => {
    const acceptorId = await createUser("user", "acceptor4@example.test");
    const lookup = await findInviteByToken("this-token-does-not-exist");
    expect(lookup).toBeNull();

    const result = await acceptStaffInvite("this-token-does-not-exist", acceptorId);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("staff invites — accepting never downgrades an admin", () => {
  it("keeps role 'admin' when an already-admin account accepts an invite", async () => {
    const ownerId = await createUser("admin", "owner5@example.test");
    const adminAcceptorId = await createUser("admin", "already-admin@example.test");
    const { token } = await createStaffInvite(ownerId, null);

    const result = await acceptStaffInvite(token, adminAcceptorId);
    expect(result).toEqual({ ok: true, role: "admin" });

    const [row] = await db.select({ role: user.role }).from(user).where(eq(user.id, adminAcceptorId)).limit(1);
    expect(row?.role).toBe("admin");
  });
});

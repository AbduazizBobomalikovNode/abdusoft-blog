import { randomBytes, createHash } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { StaffInvite, StaffInviteStatus, StaffMember } from "@blog/shared";
import { db } from "../db/index.js";
import { staffInvites, posts } from "../db/schema.js";
import { user, session } from "../db/auth-schema.js";

/** Taklif havolasi shuncha kundan keyin muddati tugaydi (spec: standart 7 kun). */
export const STAFF_INVITE_TTL_DAYS = 7;

/** Xom (URL'da ko'rinadigan) token — hech qayerda saqlanmaydi, faqat sha256 hash saqlanadi. */
export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function computeStatus(row: {
  usedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}): StaffInviteStatus {
  if (row.usedAt) return "used";
  if (row.revokedAt) return "revoked";
  if (row.expiresAt.getTime() < Date.now()) return "expired";
  return "active";
}

export function toStaffInviteDto(row: typeof staffInvites.$inferSelect): StaffInvite {
  return {
    id: row.id,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    usedAt: row.usedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    status: computeStatus(row),
  };
}

export async function createStaffInvite(createdBy: string, note: string | null) {
  const token = generateInviteToken();
  const tokenHash = hashInviteToken(token);
  const expiresAt = new Date(Date.now() + STAFF_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  const [created] = await db
    .insert(staffInvites)
    .values({ tokenHash, note, createdBy, expiresAt })
    .returning();

  if (!created) throw new Error("Taklif yaratib bo'lmadi");
  return { invite: created, token };
}

export async function listStaffInvites(): Promise<StaffInvite[]> {
  const rows = await db.select().from(staffInvites).orderBy(desc(staffInvites.createdAt));
  return rows.map(toStaffInviteDto);
}

export async function revokeStaffInvite(id: string): Promise<boolean> {
  const [row] = await db.select().from(staffInvites).where(eq(staffInvites.id, id)).limit(1);
  if (!row || row.usedAt || row.revokedAt) return false;
  await db.update(staffInvites).set({ revokedAt: new Date() }).where(eq(staffInvites.id, id));
  return true;
}

export async function listStaffMembers(): Promise<StaffMember[]> {
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      addedAt: user.createdAt,
      postsCount: sql<number>`count(${posts.id})::int`,
    })
    .from(user)
    .leftJoin(posts, eq(posts.createdBy, user.id))
    .where(eq(user.role, "staff"))
    .groupBy(user.id)
    .orderBy(desc(user.createdAt));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    image: row.image,
    addedAt: row.addedAt.toISOString(),
    postsCount: row.postsCount,
  }));
}

/** "Olib tashlash" — rolni "user"ga qaytaradi, barcha sessiyalarini o'chiradi. Postlari saqlanib qoladi (`created_by` o'zgarmaydi). */
export async function removeStaffMember(userId: string): Promise<boolean> {
  const [row] = await db.select({ role: user.role }).from(user).where(eq(user.id, userId)).limit(1);
  if (!row || row.role !== "staff") return false;

  await db.update(user).set({ role: "user" }).where(eq(user.id, userId));
  await db.delete(session).where(eq(session.userId, userId));
  return true;
}

interface InviteLookup {
  row: typeof staffInvites.$inferSelect;
  status: StaffInviteStatus;
}

export async function findInviteByToken(token: string): Promise<InviteLookup | null> {
  const tokenHash = hashInviteToken(token);
  const [row] = await db.select().from(staffInvites).where(eq(staffInvites.tokenHash, tokenHash)).limit(1);
  if (!row) return null;
  return { row, status: computeStatus(row) };
}

export type AcceptInviteResult =
  | { ok: true; role: "admin" | "staff" }
  | { ok: false; reason: "not_found" | "expired" | "used" | "revoked" };

/**
 * Taklifni qabul qiladi — bir martalik (atomik): faqat hali ishlatilmagan,
 * bekor qilinmagan va muddati o'tmagan tokenni ishlatadi. Admin hisobi
 * HECH QACHON pasaytirilmaydi ("user" — "admin"ni bosib o'tolmaydi).
 */
export async function acceptStaffInvite(token: string, acceptingUserId: string): Promise<AcceptInviteResult> {
  const lookup = await findInviteByToken(token);
  if (!lookup) return { ok: false, reason: "not_found" };
  if (lookup.status !== "active") return { ok: false, reason: lookup.status as "expired" | "used" | "revoked" };

  const now = new Date();
  const [claimed] = await db
    .update(staffInvites)
    .set({ usedAt: now, usedBy: acceptingUserId })
    .where(and(eq(staffInvites.id, lookup.row.id), isNull(staffInvites.usedAt), isNull(staffInvites.revokedAt)))
    .returning();

  // Boshqa so'rov bir zumda birinchi bo'lib ishlatib ulgurgan bo'lishi mumkin — race'ni shu yerda ushlaymiz.
  if (!claimed) return { ok: false, reason: "used" };

  const [existingUser] = await db.select({ role: user.role }).from(user).where(eq(user.id, acceptingUserId)).limit(1);
  const currentRole = existingUser?.role ?? "user";

  if (currentRole === "admin") {
    return { ok: true, role: "admin" };
  }

  if (currentRole !== "staff") {
    await db.update(user).set({ role: "staff" }).where(eq(user.id, acceptingUserId));
  }

  return { ok: true, role: "staff" };
}

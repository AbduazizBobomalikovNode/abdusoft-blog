import { eq } from "drizzle-orm";
import { db } from "../../../db/index.js";
import { distributionAccounts, posts } from "../../../db/schema.js";
import { encryptSecret } from "../../crypto.js";
import type { Actor } from "../../posts/types.js";
import type { ProviderId } from "../types.js";
import { TOKENS } from "./test-support.js";

/** Test yordamchilari: akkaunt va post yaratish (shifrlangan tokenlar bilan, haqiqiy ulanish oqimisiz). */

export const ADMIN_ACTOR: Actor = { userId: null, role: "admin", via: "web" };

const DEFAULTS: Record<ProviderId, { externalId: string; username: string; access: string; refresh: string | null; ttlMs: number; meta: Record<string, string> }> = {
  linkedin: { externalId: "li-owner-1", username: "", access: TOKENS.li, refresh: null, ttlMs: 58 * 86_400_000, meta: {} },
  x: { externalId: "x-owner-1", username: "owner", access: TOKENS.xAccess, refresh: TOKENS.xRefresh, ttlMs: 2 * 3_600_000, meta: {} },
  threads: { externalId: "T1", username: "owner", access: TOKENS.threads, refresh: null, ttlMs: 58 * 86_400_000, meta: {} },
  instagram: { externalId: "IG1", username: "owner_ig", access: TOKENS.ig, refresh: null, ttlMs: 58 * 86_400_000, meta: {} },
  github: { externalId: "owner", username: "owner", access: TOKENS.gh, refresh: null, ttlMs: 100 * 86_400_000, meta: { owner: "owner", repo: "owner" } },
};

export async function insertAccount(provider: ProviderId, now: Date, over: Partial<typeof distributionAccounts.$inferInsert> = {}) {
  const d = DEFAULTS[provider];
  const [row] = await db
    .insert(distributionAccounts)
    .values({
      provider,
      externalId: d.externalId,
      displayName: "Test Owner",
      username: d.username || null,
      accessTokenEnc: encryptSecret(d.access),
      refreshTokenEnc: d.refresh ? encryptSecret(d.refresh) : null,
      accessTokenExpiresAt: new Date(now.getTime() + d.ttlMs),
      refreshTokenExpiresAt: null,
      scopes: [],
      meta: d.meta,
      status: "active",
      issuedAt: now,
      connectedAt: now,
      ...over,
    })
    .onConflictDoUpdate({ target: [distributionAccounts.provider, distributionAccounts.externalId], set: { status: "active", accessTokenEnc: encryptSecret(d.access), refreshTokenEnc: d.refresh ? encryptSecret(d.refresh) : null, accessTokenExpiresAt: new Date(now.getTime() + d.ttlMs), issuedAt: now, connectedAt: now, lastReminderAt: null, refreshAmbiguousAt: null, ...over } })
    .returning();
  return row!;
}

let n = 0;

export async function insertPost(over: Partial<typeof posts.$inferInsert> & { title?: string } = {}) {
  n += 1;
  const [row] = await db
    .insert(posts)
    .values({
      slug: `maqola-${n}-${Math.random().toString(36).slice(2, 7)}`,
      title: `Node.js'da oʻzbekcha matn ${n}`,
      excerpt: "Qisqa tavsif: g'oya va ma'no.",
      contentJson: { type: "doc", content: [] },
      contentHtml: "<p>x</p>",
      toc: [],
      status: "published",
      publishedAt: new Date(Date.now() - (100 - n) * 60_000),
      coverUrl: "https://blog.example.test/uploads/cover.jpg",
      ...over,
    })
    .returning();
  return row!;
}

export async function clearAll(): Promise<void> {
  const s = await import("../../../db/schema.js");
  await db.delete(s.distributions);
  await db.delete(s.distributionImages);
  await db.delete(s.distributionOauthStates);
  await db.delete(s.distributionAccounts);
  await db.delete(s.auditLog);
  await db.delete(posts);
}

export const accountById = async (id: string) => (await db.select().from(distributionAccounts).where(eq(distributionAccounts.id, id)))[0]!;

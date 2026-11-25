import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, type TestUser } from "../../test/auth-test-helpers.js";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
});

let db: typeof import("../../db/index.js").db;
let s: typeof import("../../db/auth-schema.js");
let cleanupMcpData: typeof import("./connections.js").cleanupMcpData;
let owner: TestUser;

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000);

async function client(id: string, o: { createdAt: Date; metadata?: Record<string, unknown> }) {
  await db.insert(s.oauthClient).values({ id, clientId: id, redirectUris: ["https://claude.ai/api/mcp/auth_callback"], createdAt: o.createdAt, updatedAt: o.createdAt, name: id, metadata: o.metadata ?? null });
}

beforeAll(async () => {
  await migrateTestDb();
  ({ db } = await import("../../db/index.js"));
  s = await import("../../db/auth-schema.js");
  ({ cleanupMcpData } = await import("./connections.js"));
  owner = await createTestUser({ role: "admin" });
});

describe("cleanupMcpData", () => {
  it("removes stale never-consented clients only, keeps recent, consented and recently revoked ones", async () => {
    await client("stale-unused", { createdAt: hoursAgo(30) });
    await client("fresh-unused", { createdAt: hoursAgo(2) });
    await client("consented-old", { createdAt: hoursAgo(500) });
    await db.insert(s.oauthConsent).values({ id: "c1", clientId: "consented-old", userId: owner.id, scopes: ["blog:read"], createdAt: new Date(), updatedAt: new Date() });
    await client("revoked-recent", { createdAt: hoursAgo(100), metadata: { revokedAt: hoursAgo(24 * 3).toISOString() } });
    await client("revoked-ancient", { createdAt: hoursAgo(24 * 90), metadata: { revokedAt: hoursAgo(24 * 40).toISOString() } });

    const result = await cleanupMcpData(24);
    expect(result.clients).toBe(2);
    const left = (await db.select({ id: s.oauthClient.clientId }).from(s.oauthClient)).map((r) => r.id).sort();
    expect(left).toEqual(["consented-old", "fresh-unused", "revoked-recent"]);
  });

  it("removes refresh tokens that expired more than a week ago (their access tokens cascade)", async () => {
    const mk = (id: string, expiresAt: Date) =>
      db.insert(s.oauthRefreshToken).values({ id, token: `tok-${id}`, clientId: "consented-old", userId: owner.id, scopes: ["blog:read"], expiresAt, createdAt: new Date() });
    await mk("rt-old", new Date(Date.now() - 8 * 24 * 3600 * 1000));
    await mk("rt-new", new Date(Date.now() + 24 * 3600 * 1000));
    await db.insert(s.oauthAccessToken).values({ id: "at-old", token: "at-old", clientId: "consented-old", userId: owner.id, refreshId: "rt-old", scopes: ["blog:read"], expiresAt: new Date(), createdAt: new Date() });

    expect((await cleanupMcpData(24)).refreshTokens).toBe(1);
    expect((await db.select().from(s.oauthRefreshToken).where(eq(s.oauthRefreshToken.id, "rt-new"))).length).toBe(1);
    expect((await db.select().from(s.oauthAccessToken).where(eq(s.oauthAccessToken.id, "at-old"))).length).toBe(0);
  });
});

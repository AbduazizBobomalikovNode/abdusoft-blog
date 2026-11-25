import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { McpConnectionsResponseSchema } from "@blog/shared";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD, type TestUser } from "../../test/auth-test-helpers.js";
import { API, MCP_URL, WEB, callTool, connect, mcpCall, tokenRequest, type Json } from "../../test/mcp-harness.js";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
});

let app: Hono;
let admin: TestUser;
let staff: TestUser;
let creds: { email: string; password: string };
let db: typeof import("../../db/index.js").db;
let authSchema: typeof import("../../db/auth-schema.js");

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  ({ db } = await import("../../db/index.js"));
  authSchema = await import("../../db/auth-schema.js");
  admin = await createTestUser({ role: "admin" });
  staff = await createTestUser({ role: "staff" });
  creds = { email: admin.email, password: TEST_USER_PASSWORD };
});

const adminReq = (path: string, init: RequestInit = {}, cookie = admin.cookie) =>
  app.request(`${API}${path}`, { ...init, headers: { cookie, origin: WEB, ...(init.headers ?? {}) } });

describe("GET /admin/connections", () => {
  it("is admin-only", async () => {
    expect((await app.request(`${API}/admin/connections`)).status).toBe(401);
    expect((await adminReq("/admin/connections", {}, staff.cookie)).status).toBe(403);
  });

  it("lists connected applications with name, permissions, connected and last-used time", async () => {
    const { clientId, tokens } = await connect(app, creds, { name: "Claude (test)", scope: "blog:read posts:write offline_access" });
    await callTool(app, tokens.access_token, "list_tags");

    const res = await adminReq("/admin/connections");
    expect(res.status).toBe(200);
    const body = McpConnectionsResponseSchema.parse(await res.json());
    const item = body.items.find((i) => i.clientId === clientId)!;
    expect(item).toBeTruthy();
    expect(item.name).toBe("Claude (test)");
    expect(item.redirectHost).toBe("claude.ai");
    expect(item.scopes.sort()).toEqual(["blog:read", "offline_access", "posts:write"]);
    expect(Date.now() - Date.parse(item.connectedAt)).toBeLessThan(60_000);
    expect(item.lastUsedAt).not.toBeNull();
    expect(JSON.stringify(body)).not.toContain(tokens.access_token);
    expect(JSON.stringify(body)).not.toContain(tokens.refresh_token!);
  });
});

describe("DELETE /admin/connections/:clientId (full revocation)", () => {
  it("kills the access token immediately and the refresh token for good, removes the consent, and is audited", async () => {
    const { clientId, tokens } = await connect(app, creds, { name: "To be revoked" });
    expect((await mcpCall(app, tokens.access_token, "tools/list")).status).toBe(200);

    const del = await adminReq(`/admin/connections/${clientId}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ revoked: true });

    // Access token (stateless JWT) — darhol 401, "revoked" sababi bilan
    const after = await mcpCall(app, tokens.access_token, "tools/list");
    expect(after.status).toBe(401);
    expect(after.www).toContain("resource_metadata=");
    expect(JSON.stringify(after.body)).toContain("revoked");

    // Refresh token — invalid_grant
    const refresh = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: clientId, resource: MCP_URL });
    expect(refresh.status).toBe(400);
    expect(refresh.body.error).toBe("invalid_grant");

    // DB: rozilik va token qatorlari yo'q; klient qatori `revokedAt` bilan saqlangan
    expect(await db.select().from(authSchema.oauthConsent).where(and(eq(authSchema.oauthConsent.userId, admin.id), eq(authSchema.oauthConsent.clientId, clientId)))).toHaveLength(0);
    expect(await db.select().from(authSchema.oauthRefreshToken).where(eq(authSchema.oauthRefreshToken.clientId, clientId))).toHaveLength(0);
    const [client] = await db.select().from(authSchema.oauthClient).where(eq(authSchema.oauthClient.clientId, clientId));
    expect((client!.metadata as { revokedAt?: string }).revokedAt).toBeTruthy();

    // Ro'yxatdan yo'qoladi, ikkinchi bekor qilish — 404
    const list = McpConnectionsResponseSchema.parse(await (await adminReq("/admin/connections")).json());
    expect(list.items.some((i) => i.clientId === clientId)).toBe(false);
    expect((await adminReq(`/admin/connections/${clientId}`, { method: "DELETE" })).status).toBe(404);

    const audit = await adminReq(`/admin/audit?action=mcp.revoke&limit=100`);
    const entries = ((await audit.json()) as { items: Array<{ entityId: string; via: string; actor: { id: string } | null; summary: string }> }).items;
    const entry = entries.find((e) => e.entityId === clientId)!;
    expect(entry).toMatchObject({ via: "web", actor: { id: admin.id } });
    expect(entry.summary).toContain("To be revoked");
  });

  it("removes the refresh-token rows too (stock delete-consent would leave them alive)", async () => {
    const { clientId, tokens } = await connect(app, creds);
    await adminReq(`/admin/connections/${clientId}`, { method: "DELETE" });
    const [row] = await db.select().from(authSchema.oauthRefreshToken).where(eq(authSchema.oauthRefreshToken.clientId, clientId));
    expect(row).toBeUndefined();
    expect((await tokenRequest(app, { grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: clientId, resource: MCP_URL })).body.error).toBe("invalid_grant");
  });

  it("is admin-only and only touches the caller's own connections", async () => {
    const { clientId, tokens } = await connect(app, creds);
    expect((await app.request(`${API}/admin/connections/${clientId}`, { method: "DELETE" })).status).toBe(401);
    expect((await adminReq(`/admin/connections/${clientId}`, { method: "DELETE" }, staff.cookie)).status).toBe(403);
    expect((await mcpCall(app, tokens.access_token, "tools/list")).status).toBe(200);

    const otherAdmin = await createTestUser({ role: "admin" });
    expect((await adminReq(`/admin/connections/${clientId}`, { method: "DELETE" }, otherAdmin.cookie)).status).toBe(404);
    expect((await mcpCall(app, tokens.access_token, "tools/list")).status).toBe(200);
  });
});

describe("audit trail", () => {
  it("records consent and coalesced reads with via=mcp, the client id and the tool names — never content or tokens", async () => {
    const { clientId, tokens } = await connect(app, creds, { name: "Audit client" });
    for (const tool of ["list_posts", "list_tags", "list_posts"]) await callTool(app, tokens.access_token, tool);

    const res = await adminReq(`/admin/audit?via=mcp&entityId=${clientId}&limit=100`);
    const items = ((await res.json()) as { items: Array<Record<string, Json>> }).items;
    const actions = items.map((i) => i.action).sort();
    expect(actions).toEqual(["mcp.authorize", "mcp.read"]);

    const read = items.find((i) => i.action === "mcp.read")!;
    expect(read).toMatchObject({ via: "mcp", actorRole: "admin", entityType: "mcp", entityId: clientId, actor: { id: admin.id } });
    expect(read.meta.count).toBe(3);
    expect([...read.meta.fields].sort()).toEqual(["list_posts", "list_tags"]);
    expect(read.summary).toContain("Audit client");

    const authorize = items.find((i) => i.action === "mcp.authorize")!;
    expect(authorize.meta.scopes).toContain("blog:read");

    const dump = JSON.stringify(items);
    for (const secret of [tokens.access_token, tokens.refresh_token!, "code_challenge"]) expect(dump).not.toContain(secret);
  });
});

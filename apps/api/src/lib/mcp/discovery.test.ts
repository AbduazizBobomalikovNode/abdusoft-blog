import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { MCP_SCOPE_IDS } from "@blog/shared";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { API, CLAUDE_REDIRECT, ISSUER, MCP_URL, mcpCall, register, type Json } from "../../test/mcp-harness.js";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
});

let app: Hono;
beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
});

const get = (path: string) => app.request(API + path);
const claudeBody = (uri: string, extra: Record<string, unknown> = {}) => ({
  client_name: "Claude",
  redirect_uris: [uri],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  ...extra,
});

describe("unauthenticated /mcp", () => {
  it("answers 401 with a WWW-Authenticate header naming the resource metadata and ALL scopes plus offline_access", async () => {
    const res = await mcpCall(app, undefined, "initialize");
    expect(res.status).toBe(401);
    expect(res.www).toContain(`Bearer resource_metadata="${API}/.well-known/oauth-protected-resource/mcp"`);
    const scope = /scope="([^"]+)"/.exec(res.www ?? "")?.[1]?.split(" ") ?? [];
    expect(scope.sort()).toEqual([...MCP_SCOPE_IDS, "offline_access"].sort());
  });

  it("rejects garbage bearer tokens with the same challenge", async () => {
    for (const token of ["garbage", "a.b.c", "x".repeat(40)]) {
      const res = await mcpCall(app, token, "tools/list");
      expect(res.status).toBe(401);
      expect(res.www).toContain("resource_metadata=");
    }
  });

  it("answers 405 (Allow: POST) to GET and DELETE — the server is stateless", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await app.request(MCP_URL, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  it("refuses an oversized body", async () => {
    const res = await app.request(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(1024 * 1024 + 10) }),
    });
    expect(res.status).toBe(413);
  });
});

describe("protected resource metadata (RFC 9728)", () => {
  it.each(["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"])("%s", async (path) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Json;
    expect(doc.resource).toBe(MCP_URL);
    expect(doc.authorization_servers).toEqual([ISSUER]);
    expect(doc.bearer_methods_supported).toEqual(["header"]);
    expect([...doc.scopes_supported].sort()).toEqual([...MCP_SCOPE_IDS].sort());
  });
});

describe("authorization server metadata (RFC 8414)", () => {
  it.each([
    "/.well-known/oauth-authorization-server/api/auth",
    "/api/auth/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server",
  ])("%s", async (path) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Json;
    expect(doc.issuer).toBe(ISSUER);
    expect(doc.authorization_endpoint).toBe(`${ISSUER}/oauth2/authorize`);
    expect(doc.token_endpoint).toBe(`${ISSUER}/oauth2/token`);
    expect(doc.registration_endpoint).toBe(`${ISSUER}/oauth2/register`);
    expect(doc.jwks_uri).toBe(`${ISSUER}/jwks`);
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    expect(doc.token_endpoint_auth_methods_supported).toContain("none");
    expect(doc.grant_types_supported).toEqual(expect.arrayContaining(["authorization_code", "refresh_token"]));
    expect(doc.response_types_supported).toEqual(["code"]);
    expect(doc.client_id_metadata_document_supported).toBe(true);
    expect(doc.scopes_supported).toEqual(expect.arrayContaining([...MCP_SCOPE_IDS, "offline_access"]));
    expect(Object.keys(doc.scope_descriptions).sort()).toEqual([...MCP_SCOPE_IDS, "offline_access"].sort());
    expect(doc.scope_descriptions["blog:read"]).toMatch(/Read posts/);
  });

  it("serves OpenID configuration aliases too", async () => {
    for (const path of ["/.well-known/openid-configuration", "/.well-known/openid-configuration/api/auth", "/api/auth/.well-known/openid-configuration"]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(((await res.json()) as { issuer: string }).issuer).toBe(ISSUER);
    }
  });

  it("publishes its signing keys", async () => {
    const res = await get("/api/auth/jwks");
    expect(res.status).toBe(200);
    const jwks = (await res.json()) as { keys: Array<Record<string, unknown>> };
    expect(jwks.keys.length).toBeGreaterThan(0);
    expect(jwks.keys[0]).not.toHaveProperty("d");
  });

  it("answers within 10 s (documented connector requirement)", async () => {
    const started = performance.now();
    await get("/.well-known/oauth-protected-resource/mcp");
    await get("/.well-known/oauth-authorization-server/api/auth");
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});

describe("dynamic client registration", () => {
  it("accepts Claude's documented callback as a public client", async () => {
    const res = await register(app, claudeBody(CLAUDE_REDIRECT));
    expect(res.status).toBe(201);
    const body = (await res.json()) as Json;
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.client_secret).toBeUndefined();
    expect(body.redirect_uris).toEqual([CLAUDE_REDIRECT]);
  });

  it.each(["http://localhost:54321/callback", "http://127.0.0.1:41234/callback"])("accepts the loopback callback %s", async (uri) => {
    const res = await register(app, claudeBody(uri, { client_name: "Claude Code" }));
    expect(res.status).toBe(201);
  });

  it.each([
    "https://evil.example/cb",
    "https://claude.ai.evil.example/api/mcp/auth_callback",
    "https://claude.ai/api/mcp/other",
    "https://claude.ai/api/mcp/auth_callback?x=1",
    "http://claude.ai/api/mcp/auth_callback",
    "http://evil.example/callback",
    "http://localhost:1234/other",
    "http://localhost.evil.example:1234/callback",
    "http://user:pw@localhost:1234/callback",
    "myapp://callback",
    "javascript:alert(1)",
    "not a url",
  ])("rejects the redirect URI %s with invalid_redirect_uri", async (uri) => {
    const res = await register(app, claudeBody(uri));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_redirect_uri");
  });

  it("rejects a registration mixing an allowed and a forbidden URI, and too many URIs", async () => {
    const mixed = await register(app, { ...claudeBody(CLAUDE_REDIRECT), redirect_uris: [CLAUDE_REDIRECT, "https://evil.example/cb"] });
    expect(mixed.status).toBe(400);
    const many = await register(app, { ...claudeBody(CLAUDE_REDIRECT), redirect_uris: Array.from({ length: 6 }, () => CLAUDE_REDIRECT) });
    expect(many.status).toBe(400);
  });

  it("passes malformed JSON through to Better Auth, which answers 4xx", async () => {
    const res = await app.request(`${API}/api/auth/oauth2/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("rejects an oversized registration body", async () => {
    const res = await register(app, { ...claudeBody(CLAUDE_REDIRECT), software_statement: "x".repeat(20 * 1024) });
    expect(res.status).toBe(413);
  });
});

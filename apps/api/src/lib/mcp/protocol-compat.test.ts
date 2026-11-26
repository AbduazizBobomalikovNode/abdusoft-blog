import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD } from "../../test/auth-test-helpers.js";
import { MCP_URL, connect, mcpCall, type Json } from "../../test/mcp-harness.js";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_LOG_REJECTS_IN_TEST = "1";
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
});

let app: Hono;
let token: string;
const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
afterEach(() => warn.mockClear());

const rejected = () => warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("mcp.rejected")).map((l) => JSON.parse(l) as Json);
const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.request(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  const admin = await createTestUser({ role: "admin" });
  token = (await connect(app, { email: admin.email, password: TEST_USER_PASSWORD })).tokens.access_token;
});

describe("a client speaking a NEWER protocol revision (the cause of the 400 responses)", () => {
  const modern = { "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" };
  const discover = { jsonrpc: "2.0", id: "d1", method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } };

  it("gets 400 with a recognizable UnsupportedProtocolVersionError (-32022) listing what the server supports, echoing the request id", async () => {
    const res = await post(discover, modern);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Json;
    expect(body.id).toBe("d1");
    expect(body.error.code).toBe(-32022);
    expect(body.error.data.requested).toBe("2026-07-28");
    expect(body.error.data.supported).toEqual(expect.arrayContaining(["2025-11-25", "2025-06-18"]));
  });

  it("the rejection is logged once, structured, without body, token or arguments", async () => {
    const secretArgs = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "list_posts", arguments: { query: "TOP-SECRET-ARGUMENT" } } };
    await post(secretArgs, { "mcp-protocol-version": "2026-07-28" });
    const logs = rejected();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: "mcp.rejected", status: 400, httpMethod: "POST", rpcMethod: "tools/call", idType: "number", protocolVersion: "2026-07-28", errorCode: -32022 });
    expect(logs[0].accept).toContain("application/json");
    const raw = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(raw).not.toContain("TOP-SECRET-ARGUMENT");
    expect(raw).not.toContain(token);
  });

  it("falls back cleanly: initialize with the newer version is negotiated down, then calls with the negotiated header work", async () => {
    const init = await post({ ...INIT, params: { ...INIT.params, protocolVersion: "2026-07-28" } });
    expect(init.status).toBe(200);
    const negotiated = ((await init.json()) as Json).result.protocolVersion as string;
    expect(negotiated).toBe("2025-11-25");
    const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-protocol-version": negotiated });
    expect(list.status).toBe(200);
  });

  it("the MCP SDK client (legacy era) connects and lists tools; the only non-2xx it provokes is its standard GET (SSE) probe answered 405, never a 400", async () => {
    const fetchWithAuth: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      return app.request(input instanceof Request ? input.url : String(input), { ...init, headers }) as Promise<Response>;
    };
    const client = new Client({ name: "sdk", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: fetchWithAuth }));
    expect((await client.listTools()).tools.length).toBeGreaterThan(5);
    await client.close();
    expect(rejected().filter((l) => l.status === 400)).toEqual([]);
    for (const l of rejected()) expect(l).toMatchObject({ status: 405, httpMethod: "GET" });
  });
});

describe("everything else a stateless Streamable HTTP server must answer", () => {
  it("ping, resources/list, prompts/list, logging/setLevel: HTTP 200 with a JSON-RPC result or -32601 (legacy era keeps errors in the body)", async () => {
    expect((await mcpCall(app, token, "ping")).status).toBe(200);
    for (const method of ["resources/list", "prompts/list", "logging/setLevel"]) {
      const r = await mcpCall(app, token, method, method === "logging/setLevel" ? { level: "info" } : {});
      expect(r.status, method).toBe(200);
      expect(r.body.error?.code, method).toBe(-32601);
    }
    expect(rejected()).toEqual([]);
  });

  it("a notification is accepted with 202 and no body", async () => {
    const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("a JSON-RPC batch is answered with a batch (allowed by the 2025 revisions the server speaks)", async () => {
    const res = await post([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }], { "mcp-protocol-version": "2025-06-18" });
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("GET (SSE stream) and DELETE are 405 with Allow: POST, as the spec prescribes for a server without streams or sessions; logged", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await app.request(MCP_URL, { method, headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" } });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
    expect(rejected().map((l) => l.status)).toEqual([405, 405]);
  });

  it("an unknown Mcp-Session-Id is ignored (no session is minted or echoed)", async () => {
    const res = await post({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { "mcp-session-id": "does-not-exist", "mcp-protocol-version": "2025-06-18" });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
  });

  it("a garbage MCP-Protocol-Version on a request with an unparseable body is still a parse error, not a crash", async () => {
    const res = await post("{not json", { "mcp-protocol-version": "bogus" });
    expect(res.status).toBe(400);
  });

  it("an unknown version string gets the typed error; Accept: application/json alone is tolerated", async () => {
    const bad = await post({ jsonrpc: "2.0", id: 9, method: "tools/list" }, { "mcp-protocol-version": "1900-01-01" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as Json).error.code).toBe(-32022);
    const jsonOnly = await post({ jsonrpc: "2.0", id: 10, method: "ping" }, { accept: "application/json", "mcp-protocol-version": "2025-06-18" });
    expect(jsonOnly.status).toBe(200);
  });
});

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD } from "../../test/auth-test-helpers.js";
import { MCP_URL, connect, type Json } from "../../test/mcp-harness.js";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_LOG_REJECTS_IN_TEST = "1";
});

let app: Hono;
const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
afterEach(() => warn.mockClear());
const rejected = () => warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("mcp.rejected")).map((l) => JSON.parse(l) as Json);

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
});

describe("the /mcp rejection logger never buffers an unauthenticated body", () => {
  it("a 64 MB chunked POST without Content-Length and token is cut off at the body limit; the log line keeps status, code and headers", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(97);
    let pulled = 0;
    const total = 64;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= total) return controller.close();
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    const res = await app.request(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
      body,
      // @ts-expect-error Node fetch needs duplex for streamed bodies
      duplex: "half",
    });
    expect(res.status).toBe(413);
    // body limit (1 MB) + stream queue slack, nowhere near all 64 MB
    expect(pulled).toBeLessThanOrEqual(Math.ceil((await import("./http.js")).maxBodyBytes() / chunk.byteLength) + 4);
    const logs = rejected();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: "mcp.rejected", status: 413, httpMethod: "POST", errorCode: -32600, protocolVersion: "2025-11-25" });
    expect(logs[0].accept).toContain("application/json");
    expect(logs[0].rpcMethod).toBeUndefined();
  });

  it("a small request still has its JSON-RPC method logged; a parse error does not echo body fragments", async () => {
    const secret = "SECRET-FRAGMENT-XYZ";
    const res = await app.request(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer nope" },
      body: `{"method":"tools/call", ${secret}`,
    });
    expect(res.status).toBe(401);
    const raw = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(raw).not.toContain(secret);
    expect(rejected()[0]).toMatchObject({ status: 401, rpcMethod: "(unparseable)" });
  });

  it("an authenticated parse error is logged as a bare 'Parse error' without any fragment of the body", async () => {
    const admin = await createTestUser({ role: "admin" });
    const token = (await connect(app, { email: admin.email, password: TEST_USER_PASSWORD })).tokens.access_token;
    warn.mockClear();
    const secret = "FRAGMENT-ABC-123";
    const res = await app.request(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: `{"jsonrpc":"2.0", ${secret}`,
    });
    expect(res.status).toBe(400);
    const raw = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(raw).not.toContain(secret);
    expect(rejected()[0]).toMatchObject({ status: 400, errorCode: -32700, errorMessage: "Parse error" });
  });
});

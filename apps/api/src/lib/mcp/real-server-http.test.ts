import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD } from "../../test/auth-test-helpers.js";
import { connect } from "../../test/mcp-harness.js";
import { pingBody, rawPost, rawSocket, startRealServer } from "../../test/real-server.js";

// `app.request(...)` Node adapterini chetlab o'tadi — bu fayl esa `/mcp`ni productionda ishlatiladigan `@hono/node-server` bilan,
// haqiqiy TCP orqali tekshiradi (16 KB dan katta tana tee-ning tugatilmagan shoxi tufayli javobsiz qolgan edi).
vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_RATE_LIMIT_MAX = "100000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
});

let app: Hono;
let server: Awaited<ReturnType<typeof startRealServer>>;
let token: string;
const LIMIT = 1024 * 1024;
const SIZES = [46, 16_383, 16_384, 16_385, 20_000, 70_000, LIMIT - 1, LIMIT, LIMIT + 1];
const MODES = [
  { name: "content-length", mode: "content-length" as const, chunkSize: undefined },
  { name: "chunked 1 KiB chunks", mode: "chunked" as const, chunkSize: 1024 },
  { name: "chunked 64 KiB chunks", mode: "chunked" as const, chunkSize: 64 * 1024 },
];

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  const admin = await createTestUser({ role: "admin" });
  token = (await connect(app, { email: admin.email, password: TEST_USER_PASSWORD })).tokens.access_token;
  server = await startRealServer(app);
});
afterAll(async () => {
  await server?.close();
});

describe("/mcp on the real Node HTTP server: status by body size and transfer mode", () => {
  for (const m of MODES) {
    for (const size of SIZES) {
      const expected = size > LIMIT ? 413 : 200;
      it(`${size} bytes, ${m.name} -> ${expected}`, async () => {
        const r = await rawPost({ port: server.port, token, body: pingBody(size), mode: m.mode, chunkSize: m.chunkSize, timeoutMs: 8000 });
        expect(r.status, `${size}B ${m.name}: ${r.body.slice(0, 200)} ${r.error ?? ""}`).toBe(expected);
        if (expected === 200) expect(JSON.parse(r.body.replace(/^[^{]*data: /, "")).jsonrpc).toBe("2.0");
      });
    }
  }

  it("an empty authenticated POST, GET and DELETE are answered promptly", async () => {
    const empty = await rawPost({ port: server.port, token, body: Buffer.alloc(0), mode: "content-length", timeoutMs: 5000 });
    expect(empty.status).toBe(400);
    const emptyChunked = await rawPost({ port: server.port, token, body: Buffer.alloc(0), mode: "chunked", timeoutMs: 5000 });
    expect(emptyChunked.status).toBe(400);
    for (const method of ["GET", "DELETE"]) {
      const r = await rawPost({ port: server.port, token, body: Buffer.alloc(0), mode: "content-length", method, timeoutMs: 5000 });
      expect(r.status, method).toBe(405);
    }
  });

  it("an unauthenticated request whose body never arrives is answered 401 promptly (not after Node's request timeout)", async () => {
    const head = `POST /mcp HTTP/1.1\r\nHost: x\r\ncontent-type: application/json\r\naccept: application/json, text/event-stream\r\ncontent-length: 100\r\n\r\n`;
    const r = await rawSocket({ port: server.port, head, timeoutMs: 4000 });
    expect(r.status).toBe(401);
    expect(r.ms).toBeLessThan(3000);
  });

  it("an authenticated request whose body never arrives is not held past the peek deadline by the logger; a slow-trickle authenticated body still succeeds", async () => {
    const body = pingBody(120);
    const head = `POST /mcp HTTP/1.1\r\nHost: x\r\ncontent-type: application/json\r\naccept: application/json, text/event-stream\r\nmcp-protocol-version: 2025-06-18\r\nauthorization: Bearer ${token}\r\ncontent-length: ${body.length}\r\n\r\n`;
    // 30 bayt darhol, qolgani 1.6 s dan keyin (peek muddatidan keyin)
    const r = await rawSocket({
      port: server.port,
      head,
      steps: [
        { afterMs: 50, data: body.subarray(0, 30) },
        { afterMs: 1600, data: body.subarray(30) },
      ],
      timeoutMs: 8000,
    });
    expect(r.status).toBe(200);
    expect(r.ms).toBeGreaterThanOrEqual(1500);
    expect(r.raw).toContain('"jsonrpc":"2.0"');
  });

  it("a 64 MB chunked unauthenticated POST is cut off at the body limit", async () => {
    const sent = { bytes: 0 };
    const r = await rawPost({ port: server.port, body: Buffer.alloc(64 * 1024 * 1024, 97), mode: "chunked", chunkSize: 1024 * 1024, pauseMs: 15, sent, timeoutMs: 15_000 });
    // Like `main`, the real server may drop the connection at the limit instead of delivering the 413 (RST); either way it is cut off, never held.
    expect([413, "error"], `${r.error} after ${sent.bytes} bytes, ${r.ms} ms`).toContain(r.status);
    // the client was told to stop long before the 64 MB were sent
    expect(sent.bytes).toBeLessThan(16 * 1024 * 1024);
    if (r.status === 413) expect(r.body).toContain("Request too large");
  });
});

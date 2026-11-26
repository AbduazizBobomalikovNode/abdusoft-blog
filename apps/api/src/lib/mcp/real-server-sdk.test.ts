import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD } from "../../test/auth-test-helpers.js";
import { connect } from "../../test/mcp-harness.js";
import { startRealServer } from "../../test/real-server.js";

// Haqiqiy MCP SDK klienti haqiqiy HTTP orqali (Node adapteri), yozuv vositalari yoqilgan holda: argumentlari 70 KB dan katta chaqiruv.
vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_WRITE_TOOLS_ENABLED = "true";
  process.env.MCP_RATE_LIMIT_MAX = "100000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
});

let app: Hono;
let server: Awaited<ReturnType<typeof startRealServer>>;
let token: string;

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

describe("MCP SDK client over real HTTP with a large tool call", () => {
  it("creates a draft whose content_markdown argument is over 70 KB", async () => {
    const client = new Client({ name: "real-http", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const paragraph = "Bu uzun qoralama uchun sinov matni, jumlalar ketma-ket keladi va hajmi katta bo'ladi. ";
    const markdown = Array.from({ length: 720 }, (_, i) => `Paragraf ${i + 1}. ${paragraph}`).join("\n\n");
    expect(Buffer.byteLength(markdown)).toBeGreaterThan(70_000);
    expect(markdown.length).toBeLessThan(80_000);
    const res = await client.callTool({ name: "create_post_draft", arguments: { title: "Katta qoralama", content_markdown: markdown } });
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(res.isError, text.slice(0, 300)).toBeFalsy();
    expect(JSON.parse(text).post.id).toBeTruthy();
    await client.close();
  });
});

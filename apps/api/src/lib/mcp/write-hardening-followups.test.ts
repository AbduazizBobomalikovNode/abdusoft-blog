import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD, type TestUser } from "../../test/auth-test-helpers.js";
import { callTool, connect, type Json } from "../../test/mcp-harness.js";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_WRITE_TOOLS_ENABLED = "true";
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
  for (const key of ["CREATES_PER_HOUR", "EDITS_PER_HOUR"]) process.env[`MCP_WRITE_LIMIT_${key}`] = "0";
});

let app: Hono;
let admin: TestUser;
let token: string;

const cell = (attrs: Record<string, unknown> = {}) => ({ type: "tableCell", attrs, content: [{ type: "paragraph" }] });
const row = (n: number, attrs: Record<string, unknown> = {}) => ({ type: "tableRow", content: Array.from({ length: n }, () => cell(attrs)) });
const table = (rows: unknown[]) => ({ type: "doc", content: [{ type: "table", content: rows }] });
const draft = (args: Record<string, unknown>) => callTool(app, token, "create_post_draft", { title: "Sinov", ...args });

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  admin = await createTestUser({ role: "admin" });
  token = (await connect(app, { email: admin.email, password: TEST_USER_PASSWORD })).tokens.access_token;
});

describe("connector tables are capped (spans 10, 500 cells)", () => {
  it("the 73 x 64 table with spans of 64 is refused quickly", async () => {
    const started = Date.now();
    const r = await draft({ content_document: table(Array.from({ length: 73 }, () => row(64, { colspan: 64, rowspan: 64 }))) });
    expect(r.isError).toBe(true);
    expect((r.json as Json).error.code).toBe("invalid_input");
    expect(Date.now() - started).toBeLessThan(5000);
  });
  it("spans of 11 and 510 cells are refused; 500 cells with spans of 10 are accepted", async () => {
    expect((await draft({ content_document: table([row(2, { colspan: 11 })]) })).isError).toBe(true);
    expect((await draft({ content_document: table(Array.from({ length: 51 }, () => row(10))) })).isError).toBe(true);
    const ok = await draft({ content_document: table(Array.from({ length: 50 }, () => row(10, { colspan: 10, rowspan: 10 }))) });
    expect(ok.isError, ok.text).toBe(false);
  });
});

describe("Markdown images follow the same own-media rule as structured documents", () => {
  it("an external image in content_markdown is refused with a clear message to upload it first", async () => {
    const r = await draft({ content_markdown: "## A\n\ntext\n\n![x](http://external.example/y.png?token=secret)" });
    expect(r.isError).toBe(true);
    const err = (r.json as Json).error;
    expect(err.code).toBe("invalid_input");
    expect(err.message).toMatch(/own media/);
    expect(err.hint).toMatch(/upload_image/);
    expect(r.text).not.toContain("token=secret");
  });
  it("update_post refuses it too, and a Markdown post without images still works", async () => {
    const ok = await draft({ content_markdown: "## A\n\nmatn matn" });
    expect(ok.isError).toBe(false);
    const post = (ok.json as Json).post;
    const bad = await callTool(app, token, "update_post", { id: post.id, expected_updated_at: post.updatedAt, content_markdown: "## A\n\n![x](https://cdn.example/y.png)" });
    expect(bad.isError).toBe(true);
    expect((bad.json as Json).error.code).toBe("invalid_input");
  });
  it("the blog's own uploaded image is accepted in Markdown", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64").toString("base64");
    const up = await callTool(app, token, "upload_image", { data_base64: png, alt: "kichik" });
    expect(up.isError, up.text).toBe(false);
    const r = await draft({ content_markdown: `## A\n\n${(up.json as Json).markdown}` });
    expect(r.isError, r.text).toBe(false);
  });
});

describe("link hrefs", () => {
  it("a link beginning with /\\ is refused in a connector document", async () => {
    const d = (href: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "l", marks: [{ type: "link", attrs: { href } }] }] }] });
    expect((await draft({ content_document: d("/\\evil.example") })).isError).toBe(true);
    expect((await draft({ content_document: d("/ok-path") })).isError).toBe(false);
  });
});

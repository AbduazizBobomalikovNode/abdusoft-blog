import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD } from "../../test/auth-test-helpers.js";
import { ALL_BLOG_SCOPES, callTool, connect } from "../../test/mcp-harness.js";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  process.env.MCP_WRITE_TOOLS_ENABLED = "true";
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
  for (const key of ["CREATES_PER_HOUR", "EDITS_PER_HOUR", "PUBLISHES_PER_DAY", "CHANNEL_SENDS_PER_DAY", "MODERATION_PER_HOUR", "DESTRUCTIVE_PER_DAY"]) process.env[`MCP_WRITE_LIMIT_${key}`] = "0";
});

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
let app: Hono;
let token: string;
let db: typeof import("../../db/index.js").db;
let schema: typeof import("../../db/schema.js");
const call = (name: string, args: Record<string, unknown>) => callTool(app, token, name, args);

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
  ({ db } = await import("../../db/index.js"));
  schema = await import("../../db/schema.js");
  const admin = await createTestUser({ role: "admin" });
  token = (await connect(app, { email: admin.email, password: TEST_USER_PASSWORD }, { scope: ALL_BLOG_SCOPES })).tokens.access_token;
});

describe("Markdown-derived links use the same URL rule as structured documents", () => {
  it.each([
    ["protocol-relative", "[x](//evil.example/p)"],
    ["backslash", "[x](/\\evil.example)"],
  ])("refuses a %s link and writes nothing", async (_name, md) => {
    const before = (await db.select().from(schema.posts)).length;
    const r = await call("create_post_draft", { title: "Havola", content_markdown: `## Salom\n\n${md}\n` });
    expect(r.isError, r.text).toBe(true);
    expect(r.json.error.code).toBe("invalid_input");
    expect((await db.select().from(schema.posts)).length).toBe(before);
  });
  it("a TAB-split target never becomes a link; ordinary links still work", async () => {
    const r = await call("create_post_draft", { title: "Tab", content_markdown: "## Salom\n\n[x](/\t/evil.example) va [y](/maqola) va [z](https://example.com)\n" });
    expect(r.isError, r.text).toBe(false);
    const [row] = await db.select().from(schema.posts).where((await import("drizzle-orm")).eq(schema.posts.id, r.json.post.id));
    const json = JSON.stringify(row!.contentJson);
    expect(json).not.toMatch(/"href":"\/[\t\\]/);
    expect(json).toContain('"href":"/maqola"');
  });
  it("the structured path rejects the same forms", async () => {
    for (const href of ["//evil.example", "/\\evil.example", "/\t/evil.example"]) {
      const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "l", marks: [{ type: "link", attrs: { href } }] }] }] };
      const r = await call("create_post_draft", { title: "Tuzilma", content_document: doc });
      expect(r.isError, href).toBe(true);
    }
  });
});

describe("upload_image strict sniffing", () => {
  const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64");
  const png = Buffer.from(TINY_PNG, "base64");
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>1</script></svg>';
  const payloads: [string, Buffer][] = [
    ["markup after two bytes (declared as PNG)", Buffer.from(`xx${svg}`)],
    ["svg with leading whitespace", Buffer.from(`  \n${svg}`)],
    ["svg with a BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(svg)])],
    ["PNG signature then svg", Buffer.concat([png.subarray(0, 8), Buffer.from(svg)])],
    ["GIF89a then svg", Buffer.from(`GIF89a${svg}`)],
    ["RIFF/WEBP shell then svg", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.from(svg)])],
    ["JPEG signature then svg", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(svg)])],
    ["svg then PNG (markup first)", Buffer.concat([Buffer.from(svg), png])],
  ];
  it.each(payloads)("refuses %s and stores nothing", async (_name, bytes) => {
    const before = (await db.select().from(schema.media)).length;
    const r = await call("upload_image", { data_base64: b64(bytes), alt: "x" });
    expect(r.isError, r.text).toBe(true);
    expect(r.json.error.code).toBe("invalid_input");
    expect((await db.select().from(schema.media)).length).toBe(before);
  });
  it("still accepts a real PNG", async () => {
    const r = await call("upload_image", { data_base64: TINY_PNG, alt: "Piksel" });
    expect(r.isError, r.text).toBe(false);
  });
  it("the decoder format must equal the sniffed one", async () => {
    const { decoderFormatMatches, sniffImageMime } = await import("./tools/misc-write-tools.js");
    expect(decoderFormatMatches("png", "image/png")).toBe(true);
    for (const f of ["svg", "pdf", "heif", undefined, "jpeg"]) expect(decoderFormatMatches(f, "image/png")).toBe(false);
    expect(sniffImageMime(Buffer.from(`xx${svg}`))).toBeNull();
    expect(sniffImageMime(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPxxxx")]))).toBeNull();
  });
});

import { describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { createTestUser, TEST_USER_PASSWORD } from "../../test/auth-test-helpers.js";
import { callTool, connect } from "../../test/mcp-harness.js";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
  delete process.env.MCP_WRITE_TOOLS_ENABLED;
  process.env.MCP_REGISTRATION_RATE_LIMIT_MAX = "1000";
  process.env.MCP_REGISTRATION_RATE_LIMIT_GLOBAL_MAX = "1000";
});

/** The text a read-only connector client saw before write tools existed (commit 479a15d), byte for byte. */
const ORIGINAL_NOTE =
  "'content' is readable plain text (headings prefixed with #, lists with -). It is NOT Markdown and drops inline formatting; " +
  "'document' is the authoritative Tiptap JSON that the editor stores. No Markdown serializer exists on the server yet.";

describe("with the write switch off get_post's default result is exactly what it was before write tools existed", () => {
  it("contentNote and contentFormat are unchanged", async () => {
    const { app } = (await (async () => {
      await migrateTestDb();
      return import("../../app.js");
    })()) as { app: Hono };
    const admin = await createTestUser({ role: "admin" });
    const { tokens } = await connect(app, { email: admin.email, password: TEST_USER_PASSWORD });
    const { db } = await import("../../db/index.js");
    const { createDraft } = await import("../posts/index.js");
    const created = await createDraft({ userId: admin.id, role: "admin", via: "web" }, { title: "Parity", contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "salom" }] }] } });
    expect(created.ok).toBe(true);
    void db;
    const id = created.ok ? created.data.id : "";
    const r = await callTool(app, tokens.access_token, "get_post", { id });
    expect(r.isError, r.text).toBe(false);
    expect(r.json.post.contentNote ?? r.json.contentNote).toBe(ORIGINAL_NOTE);
    expect(JSON.stringify(r.json)).toContain("plain_text+tiptap_json");
    expect(JSON.stringify(r.json)).not.toContain("include='markdown'");
  });
});

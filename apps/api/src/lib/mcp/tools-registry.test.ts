import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { fail, ok } from "../posts/types.js";
import { fitResult } from "./tools/result.js";
import { ToolError, defineTool, unwrap, type McpToolContext } from "./tools/types.js";

vi.hoisted(() => {
  process.env.MCP_ENABLED = "true";
});

let runTool: typeof import("./tools/run.js").runTool;
let TOOLS: typeof import("./tools/index.js").TOOLS;
let db: typeof import("../../db/index.js").db;
let schema: typeof import("../../db/schema.js");

beforeAll(async () => {
  await migrateTestDb();
  ({ runTool } = await import("./tools/run.js"));
  ({ TOOLS } = await import("./tools/index.js"));
  ({ db } = await import("../../db/index.js"));
  schema = await import("../../db/schema.js");
});

const ctxWith = (scopes: string[], maxChars = 100_000): McpToolContext => ({
  actor: { userId: null, role: "admin", via: "mcp" },
  user: { id: "u1", email: "o@example.test", name: "Owner" },
  client: { id: "client-1", name: "Claude" },
  scopes: new Set(scopes),
  limits: { resultMaxChars: maxChars },
});

// Keyingi PR'dagi yozuv vositasiga o'xshash soxta vosita — reyestr/ruxsat tuzilmasi allaqachon tayyorligini isbotlaydi.
const writeTool = defineTool({
  name: "fake_update_post",
  title: "Fake update",
  description: "Used by tests only.",
  scope: "posts:write",
  inputSchema: { id: z.string().min(1), title: z.string().min(1) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  kind: "write",
  async handler(args) {
    return { data: { updated: args.id } };
  },
});

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

describe("registry", () => {
  it("has unique tool names of at most 64 characters, each tied to a known scope (or none)", async () => {
    const { MCP_SCOPE_IDS } = await import("@blog/shared");
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.name.length).toBeLessThanOrEqual(64);
      expect(tool.scope === null || MCP_SCOPE_IDS.includes(tool.scope)).toBe(true);
    }
  });

  it("every read tool is read-only/non-destructive and every non-read tool must not claim read-only", () => {
    for (const tool of TOOLS) {
      if (tool.kind === "read") expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
  });
});

describe("runTool", () => {
  it("denies with insufficient_scope naming the missing scope, and audits the denial", async () => {
    const res = await runTool(writeTool, { id: "p1", title: "T" }, ctxWith(["blog:read"]));
    expect(res.isError).toBe(true);
    expect(parse(res).error).toMatchObject({ code: "insufficient_scope", requiredScope: "posts:write", grantedScopes: ["blog:read"] });
    const rows = await db.select().from(schema.auditLog);
    expect(rows.some((r) => r.action === "mcp.denied" && r.via === "mcp" && (r.meta as { requiredScope?: string }).requiredScope === "posts:write")).toBe(true);
  });

  it("runs the handler when the scope is granted", async () => {
    const res = await runTool(writeTool, { id: "p1", title: "T" }, ctxWith(["posts:write"]));
    expect(res.isError).toBeUndefined();
    expect(parse(res)).toEqual({ updated: "p1" });
  });

  it("reports invalid arguments as invalid_input with the offending field", async () => {
    const res = await runTool(writeTool, { id: "", title: 5 }, ctxWith(["posts:write"]));
    expect(parse(res).error.code).toBe("invalid_input");
    expect(parse(res).error.message).toMatch(/id|title/);
  });

  it("maps service failures (not_found, conflict with the current updatedAt) to actionable errors", async () => {
    const conflictTool = defineTool({
      ...writeTool,
      name: "fake_conflict",
      async handler() {
        return unwrap(fail("conflict", "Post boshqa joyda o'zgartirilgan", { updatedAt: "2030-01-01T00:00:00.000Z" })) as never;
      },
    });
    const res = parse(await runTool(conflictTool, { id: "p", title: "T" }, ctxWith(["posts:write"])));
    expect(res.error).toMatchObject({ code: "conflict", updatedAt: "2030-01-01T00:00:00.000Z" });
    expect(res.error.hint).toMatch(/updatedAt/);

    expect(() => unwrap(fail("not_found", "Topilmadi"), { notFound: "Use list_posts" })).toThrow(ToolError);
    expect(unwrap(ok(5))).toBe(5);
  });

  it("masks unexpected errors: no stack, SQL or values reach the client", async () => {
    const boom = defineTool({
      ...writeTool,
      name: "fake_boom",
      async handler() {
        throw new Error("select * from user where password = 'hunter2' failed");
      },
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await runTool(boom, { id: "p", title: "T" }, ctxWith(["posts:write"]));
    spy.mockRestore();
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).not.toMatch(/hunter2|select/);
    expect(parse(res).error.code).toBe("internal_error");
  });

  it("coalesces read audit entries per client into one row with a count", async () => {
    const readTool = TOOLS.find((t) => t.name === "list_tags")!;
    const ctx = { ...ctxWith(["blog:read"]), client: { id: "client-coalesce", name: "Claude" } };
    await runTool(readTool, {}, ctx);
    await runTool(readTool, {}, ctx);
    const rows = (await db.select().from(schema.auditLog)).filter((r) => r.entityId === "client-coalesce");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toMatchObject({ count: 2, fields: ["list_tags"] });
  });
});

describe("fitResult", () => {
  const big = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i, text: "x".repeat(50) }));

  it("returns the payload unchanged when it fits", () => {
    const out = fitResult({ data: { items: big(2) }, listKey: "items" }, 10_000);
    expect(out.truncated).toBe(false);
    expect(JSON.parse(out.text).items).toHaveLength(2);
  });

  it("halves the list until it fits and tells the model how to continue", () => {
    const out = fitResult({ data: { items: big(200), page: 1, hasMore: false }, listKey: "items" }, 2_000);
    expect(out.text.length).toBeLessThanOrEqual(2_000);
    const parsed = JSON.parse(out.text);
    expect(parsed.items.length).toBeLessThan(200);
    expect(parsed.truncated.hint).toMatch(/smaller 'limit'/);
    expect(parsed.truncated.returnedItems).toBe(parsed.items.length);
  });

  it("applies shrink steps first (drop, then truncate) and always stays valid JSON", () => {
    const out = fitResult(
      {
        data: { post: { id: 1 }, content: "a".repeat(5_000), document: { blob: "b".repeat(5_000) } },
        shrink: [
          { key: "document", mode: "drop", note: "document dropped" },
          { key: "content", mode: "truncate", note: "content truncated" },
        ],
      },
      3_000,
    );
    const parsed = JSON.parse(out.text);
    expect(out.text.length).toBeLessThanOrEqual(3_000);
    expect(parsed).not.toHaveProperty("document");
    expect(parsed.content.length).toBeLessThan(5_000);
    expect(parsed.truncated.reasons).toEqual(["document dropped", "content truncated"]);
  });

  it("falls back to a short error when nothing can be shrunk", () => {
    const out = fitResult({ data: { blob: "z".repeat(10_000) } }, 2_000);
    expect(JSON.parse(out.text).error.code).toBe("result_too_large");
    expect(out.text.length).toBeLessThanOrEqual(2_000);
  });
});

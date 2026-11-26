import { beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { DOC_LIMITS } from "@blog/shared";
import { migrateTestDb } from "../test/migrate-test-db.js";
import { createTestUser, type TestUser } from "../test/auth-test-helpers.js";
import { ADMIN_DOC_BODY_MAX_BYTES } from "../lib/body-limit.js";

let app: Hono;
let admin: TestUser;
const send = (method: string, path: string, body: unknown) =>
  app.request(path, { method, headers: { cookie: admin.cookie, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const huge = JSON.stringify({ contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a".repeat(ADMIN_DOC_BODY_MAX_BYTES + 10) }] }] } });

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../app.js"));
  admin = await createTestUser({ role: "admin" });
});

describe("admin routes that accept documents have a request body limit", () => {
  it("the limit is above any document the validator accepts", () => {
    expect(ADMIN_DOC_BODY_MAX_BYTES).toBeGreaterThan(DOC_LIMITS.maxDocSize);
  });

  it("PATCH /admin/posts/:id, PUT /admin/site and channel version writes answer 413 for an oversized body", async () => {
    const created = (await (await send("POST", "/admin/posts", { title: "Limit" })).json()) as { id: string };
    expect((await send("PATCH", `/admin/posts/${created.id}`, huge)).status).toBe(413);
    expect((await send("PUT", "/admin/site", JSON.stringify({ about: JSON.parse(huge).contentJson ? { json: JSON.parse(huge).contentJson } : {} }))).status).toBe(413);
    expect((await send("POST", `/admin/posts/${created.id}/channel/versions`, huge)).status).toBe(413);
    expect((await send("PATCH", `/admin/posts/${created.id}/channel/versions/00000000-0000-4000-8000-000000000000`, huge)).status).toBe(413);
  });

  it("a normal edit and a document over the validator's limits (but under the body limit) behave as before", async () => {
    const created = (await (await send("POST", "/admin/posts", { title: "Normal" })).json()) as { id: string };
    expect((await send("PATCH", `/admin/posts/${created.id}`, { title: "Yangi", contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "salom" }] }] } })).status).toBe(200);
    const heavy = { type: "doc", content: Array.from({ length: DOC_LIMITS.maxRenderElements + 5 }, () => ({ type: "paragraph" })) };
    const res = await send("PATCH", `/admin/posts/${created.id}`, { contentJson: heavy });
    expect(res.status).toBe(400);
  });

  it("other writes are not subject to the document limit", async () => {
    expect((await send("POST", "/admin/posts", { title: "x".repeat(50) })).status).toBe(201);
  });
});

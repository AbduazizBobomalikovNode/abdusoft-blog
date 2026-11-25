import { beforeAll, describe, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../../test/migrate-test-db.js";
import { registerAuthCompatSuite } from "../../test/auth-compat-suite.js";

// Bayroq YOQILGAN: jwt()+mcp()+cimd() plagin'lari bilan ham mavjud email+parol/sessiya/cookie/rate-limit xatti-harakati
// bayroq o'chiq holat bilan (`lib/auth-compat.test.ts`) aynan bir xil bo'lishi kerak.
vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_ENABLED = "true";
  process.env.AUTH_RATE_LIMIT_MAX = "3";
  process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS = "600";
  process.env.TRUST_PROXY = "true";
  process.env.MCP_ENABLED = "true";
});

let app: Hono;

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../../app.js"));
});

describe("auth compatibility (MCP_ENABLED=true)", () => {
  registerAuthCompatSuite(() => app);
});

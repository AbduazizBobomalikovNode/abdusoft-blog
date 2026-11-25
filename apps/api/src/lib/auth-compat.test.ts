import { beforeAll, describe, vi } from "vitest";
import type { Hono } from "hono";
import { migrateTestDb } from "../test/migrate-test-db.js";
import { registerAuthCompatSuite } from "../test/auth-compat-suite.js";

// Bayroq o'chiq (default): Better Auth yangilanishidan keyin mavjud auth xatti-harakati o'zgarmaganini isbotlaydi.
vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_ENABLED = "true";
  process.env.AUTH_RATE_LIMIT_MAX = "3";
  process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS = "600";
  process.env.TRUST_PROXY = "true";
  delete process.env.MCP_ENABLED;
});

let app: Hono;

beforeAll(async () => {
  await migrateTestDb();
  ({ app } = await import("../app.js"));
});

describe("auth compatibility (MCP_ENABLED unset)", () => {
  registerAuthCompatSuite(() => app);
});

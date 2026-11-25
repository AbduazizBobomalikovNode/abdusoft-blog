import { describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createTestUser, TEST_USER_PASSWORD, type TestUser } from "./auth-test-helpers.js";

/**
 * Better Auth yangilanishi (1.7.7 -> 1.7.28) va (MCP yoqilganda) yangi plagin'lar mavjud email+parol,
 * sessiya va cookie xatti-harakatini O'ZGARTIRMAGANINI tekshiradigan umumiy to'plam. U ikki joyda ishlatiladi:
 * bayroq o'chiq (`auth-compat.test.ts`) va yoqilgan (`mcp/auth-compat-mcp-on.test.ts`) holatda — natija bir xil bo'lishi kerak.
 *
 * Chaqiruvchi fayl `vi.hoisted` ichida `AUTH_RATE_LIMIT_ENABLED=true`, `AUTH_RATE_LIMIT_MAX=3`,
 * `TRUST_PROXY=true` o'rnatgan bo'lishi shart.
 */
export function registerAuthCompatSuite(getApp: () => Hono) {
  const WEB = "http://localhost:3000";
  let ipCounter = 0;
  const nextIp = () => `10.20.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

  function call(path: string, init: { method?: string; body?: unknown; cookie?: string; ip?: string } = {}) {
    return getApp().request(path, {
      method: init.method ?? "GET",
      headers: {
        origin: WEB,
        "x-forwarded-for": init.ip ?? nextIp(),
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.cookie ? { cookie: init.cookie } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  }

  const keys = (value: unknown) => Object.keys(value as object).sort();

  describe("email+password sign-in", () => {
    let admin: TestUser;
    it("seeds an admin", async () => {
      admin = await createTestUser({ role: "admin" });
    });

    it("rejects a wrong password with 401 INVALID_EMAIL_OR_PASSWORD and sets no cookie", async () => {
      const res = await call("/api/auth/sign-in/email", {
        method: "POST",
        body: { email: admin.email, password: "definitely-wrong-password" },
      });
      expect(res.status).toBe(401);
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(await res.json()).toEqual({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" });
    });

    it("signs in: body shape, session cookie name and attributes (non-production)", async () => {
      const res = await call("/api/auth/sign-in/email", {
        method: "POST",
        body: { email: admin.email, password: TEST_USER_PASSWORD },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: unknown; redirect: boolean; token: string };
      expect(keys(body)).toEqual(["redirect", "token", "user"]);
      expect(body.redirect).toBe(false);
      expect(keys(body.user)).toEqual(["createdAt", "email", "emailVerified", "id", "image", "name", "role", "updatedAt"]);

      const cookies = res.headers.getSetCookie();
      expect(cookies).toHaveLength(1);
      const [pair, ...attrs] = cookies[0]!.split("; ");
      expect(pair!.startsWith("better-auth.session_token=")).toBe(true);
      expect(attrs).toEqual(["Max-Age=604800", "Path=/", "HttpOnly", "SameSite=Lax"]);
    });

    it("get-session returns the session with the user's role; sign-out clears it", async () => {
      const signIn = await call("/api/auth/sign-in/email", {
        method: "POST",
        body: { email: admin.email, password: TEST_USER_PASSWORD },
      });
      const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

      const session = await call("/api/auth/get-session", { cookie });
      expect(session.status).toBe(200);
      const sessionBody = (await session.json()) as { session: unknown; user: { role: string; email: string } };
      expect(keys(sessionBody)).toEqual(["session", "user"]);
      expect(sessionBody.user.role).toBe("admin");
      expect(sessionBody.user.email).toBe(admin.email);

      expect((await call("/admin/me", { cookie })).status).toBe(200);

      const out = await call("/api/auth/sign-out", { method: "POST", body: {}, cookie });
      expect(out.status).toBe(200);
      expect(await out.json()).toEqual({ success: true });
      const cleared = out.headers.getSetCookie().find((c) => c.startsWith("better-auth.session_token="));
      expect(cleared).toContain("Max-Age=0");

      const after = await call("/api/auth/get-session", { cookie });
      expect(await after.json()).toBeNull();
      expect((await call("/admin/me", { cookie })).status).toBe(401);
    });

    it("sign-up stays disabled", async () => {
      const res = await call("/api/auth/sign-up/email", {
        method: "POST",
        body: { email: "newcomer@example.test", password: "some-long-password-123", name: "New Comer" },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ code: "EMAIL_PASSWORD_SIGN_UP_DISABLED", message: "Email and password sign up is not enabled" });
    });

    it("keeps the public endpoints", async () => {
      expect(await (await call("/api/auth/ok")).json()).toEqual({ ok: true });
      expect(await (await call("/api/auth/get-session")).json()).toBeNull();
    });
  });

  describe("rate limit", () => {
    it("answers 429 with Retry-After after the configured number of attempts, per client IP", async () => {
      const ip = nextIp();
      const attempt = () =>
        call("/api/auth/sign-in/email", { method: "POST", ip, body: { email: "nobody@example.test", password: "wrong-password-123" } });
      for (let i = 0; i < 3; i += 1) expect((await attempt()).status).toBe(401);
      const blocked = await attempt();
      expect(blocked.status).toBe(429);
      const retryAfter = Number(blocked.headers.get("retry-after"));
      expect(Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 600).toBe(true);
      expect(blocked.headers.get("x-retry-after")).toBe(String(retryAfter));
      expect((await call("/api/auth/sign-in/email", { method: "POST", body: { email: "nobody@example.test", password: "wrong-password-123" } })).status).toBe(401);
    });
  });

  describe("production cookie attributes (cross-subdomain)", () => {
    it("issues __Secure- session cookie scoped to the parent domain", async () => {
      const { db, fullSchema } = await import("../db/index.js");
      const { config } = await import("../config.js");
      const { buildAuthAdvanced, buildAuthRateLimit } = await import("../lib/auth-options.js");
      const user = await createTestUser({ role: "admin" });
      const prodAuth = betterAuth({
        baseURL: "https://api.abdusoft.uz",
        secret: config.BETTER_AUTH_SECRET,
        trustedOrigins: ["https://abdusoft.uz"],
        database: drizzleAdapter(db, { provider: "pg", schema: fullSchema }),
        emailAndPassword: { enabled: true, disableSignUp: true },
        user: { additionalFields: { role: { type: "string", defaultValue: "user", input: false } } },
        rateLimit: { ...buildAuthRateLimit(), enabled: false },
        advanced: buildAuthAdvanced(true),
      });
      const res = await prodAuth.handler(
        new Request("https://api.abdusoft.uz/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://abdusoft.uz" },
          body: JSON.stringify({ email: user.email, password: TEST_USER_PASSWORD }),
        }),
      );
      expect(res.status).toBe(200);
      const [cookie] = res.headers.getSetCookie();
      const [pair, ...attrs] = cookie!.split("; ");
      expect(pair!.startsWith("__Secure-better-auth.session_token=")).toBe(true);
      expect(attrs.sort()).toEqual(
        [`Domain=${config.COOKIE_DOMAIN || ".abdusoft.uz"}`, "HttpOnly", "Max-Age=604800", "Path=/", "SameSite=Lax", "Secure"].sort(),
      );
    });
  });
}

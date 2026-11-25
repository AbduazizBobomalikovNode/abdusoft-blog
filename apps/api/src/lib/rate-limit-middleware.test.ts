import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { rateLimitWrites } from "./rate-limit-middleware";
import { consumeRateLimit } from "./rate-limit";

function makeApp(limit: number) {
  const app = new Hono();
  app.use("*", rateLimitWrites({ name: `t-${Math.random()}`, limit, windowSeconds: 30 }));
  app.all("/x", (c) => c.text("ok"));
  return app;
}

describe("rateLimitWrites", () => {
  it("counts only write methods", async () => {
    const app = makeApp(2);
    for (let i = 0; i < 5; i += 1) expect((await app.request("/x")).status).toBe(200);
    expect((await app.request("/x", { method: "POST" })).status).toBe(200);
    expect((await app.request("/x", { method: "DELETE" })).status).toBe(200);
    const blocked = await app.request("/x", { method: "PATCH" });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("is a no-op when the limit is 0", async () => {
    const app = makeApp(0);
    for (let i = 0; i < 20; i += 1) expect((await app.request("/x", { method: "POST" })).status).toBe(200);
  });
});

describe("consumeRateLimit", () => {
  it("reports the remaining seconds of the window when blocked", () => {
    vi.useFakeTimers();
    try {
      const key = `retry-${Math.random()}`;
      expect(consumeRateLimit(key, 1, 10_000)).toEqual({ allowed: true, retryAfterSeconds: 0 });
      vi.advanceTimersByTime(4_100);
      expect(consumeRateLimit(key, 1, 10_000)).toEqual({ allowed: false, retryAfterSeconds: 6 });
    } finally {
      vi.useRealTimers();
    }
  });
});

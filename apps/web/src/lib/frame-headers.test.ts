import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

describe("clickjacking protection for the connector pages", () => {
  it("sends frame-ancestors 'none' (and the legacy header) for /login and /consent only", async () => {
    const rules = await nextConfig.headers!();
    expect(rules.map((r) => r.source).sort()).toEqual(["/consent", "/login"]);
    for (const rule of rules) {
      const map = Object.fromEntries(rule.headers.map((h) => [h.key, h.value]));
      expect(map["Content-Security-Policy"]).toBe("frame-ancestors 'none'");
      expect(map["X-Frame-Options"]).toBe("DENY");
    }
  });
});

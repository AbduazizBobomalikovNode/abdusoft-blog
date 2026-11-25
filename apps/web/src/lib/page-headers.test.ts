import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { config as proxyConfig } from "../proxy";
import { FRAME_DENY_HEADERS, PROXY_MATCHER, extraHeadersFor } from "./page-headers";

describe("clickjacking headers for the admin panel and the recovery pages", () => {
  it.each(["/admin", "/admin/", "/admin/akkaunt", "/admin/postlar/123/preview", "/parolni-unutdim", "/parolni-tiklash"])(
    "denies framing on %s",
    (path) => {
      const headers = extraHeadersFor(path);
      expect(headers["Content-Security-Policy"]).toBe("frame-ancestors 'none'");
      expect(headers["X-Frame-Options"]).toBe("DENY");
    },
  );

  it("adds no-referrer and no-store only to the page that carries the token", () => {
    expect(extraHeadersFor("/parolni-tiklash")).toMatchObject({ "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
    expect(extraHeadersFor("/parolni-unutdim")["Referrer-Policy"]).toBeUndefined();
    expect(extraHeadersFor("/admin/akkaunt")["Referrer-Policy"]).toBeUndefined();
  });

  it.each(["/", "/login", "/consent", "/taklif/abc", "/admin-panel", "/administrator", "/some-post-slug", "/rss.xml", "/api/revalidate", "/parolni-tiklash-x"])(
    "touches nothing on %s",
    (path) => {
      expect(extraHeadersFor(path)).toEqual({});
    },
  );

  it("proxy matcher is exactly the set the helper handles (and stays in sync with proxy.ts)", () => {
    expect(proxyConfig.matcher).toEqual(PROXY_MATCHER);
  });

  it("leaves next.config headers() as they were (/login and /consent only)", async () => {
    const sources = (await nextConfig.headers!()).map((r) => r.source).sort();
    expect(sources).toEqual(["/consent", "/login"]);
    for (const rule of await nextConfig.headers!()) {
      expect(Object.fromEntries(rule.headers.map((h) => [h.key, h.value]))).toMatchObject(FRAME_DENY_HEADERS);
    }
  });
});

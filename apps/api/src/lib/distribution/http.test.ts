import { describe, expect, it } from "vitest";
import { HostClient, parseRetryAfter } from "./http.js";
import { DistributionError, sanitizeMessage } from "./errors.js";
import { empty, json, makeDeps, mockFetch, SECRET } from "./test-utils.js";

const hosts = ["api.github.com"];

describe("HostClient allow-list", () => {
  it("rejects other hosts, http, credentials and ports BEFORE calling fetch", async () => {
    const m = mockFetch(() => json({}));
    const c = new HostClient(makeDeps(m.fetch), hosts);
    for (const url of ["https://evil.example/x", "http://api.github.com/x", "https://user:pw@api.github.com/x", "https://api.github.com:8443/x", "https://api.github.com.evil.example/x"]) {
      await expect(c.request({ method: "GET", url, mode: "read" })).rejects.toMatchObject({ kind: "validation_rejected" });
    }
    expect(m.calls).toHaveLength(0);
  });
  it("sends redirect: manual and treats 3xx as an error without following", async () => {
    const m = mockFetch(() => empty(302, { location: "https://evil.example/" }));
    const c = new HostClient(makeDeps(m.fetch), hosts);
    await expect(c.request({ method: "GET", url: "https://api.github.com/x", mode: "read" })).rejects.toMatchObject({ kind: "transient" });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]?.redirect).toBe("manual");
    const m2 = mockFetch(() => empty(307, { location: "https://evil.example/" }));
    await expect(new HostClient(makeDeps(m2.fetch), hosts).request({ method: "POST", url: "https://api.github.com/x", mode: "create" })).rejects.toMatchObject({ kind: "outcome_unknown" });
  });
});

describe("network failures", () => {
  it("create + dropped connection / timeout => outcome_unknown", async () => {
    const m = mockFetch(() => new TypeError("fetch failed"));
    const c = new HostClient(makeDeps(m.fetch), hosts);
    const e = await c.request({ method: "POST", url: "https://api.github.com/x", mode: "create" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DistributionError);
    expect((e as DistributionError).kind).toBe("outcome_unknown");
    expect((e as DistributionError).retryable).toBe(false);
  });
  it("create + abort via timeout => outcome_unknown; read => transient", async () => {
    const slow = (_i: string, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    const deps = { ...makeDeps(slow), timeoutMs: 20 };
    const c = new HostClient(deps, hosts);
    await expect(c.request({ method: "POST", url: "https://api.github.com/x", mode: "create" })).rejects.toMatchObject({ kind: "outcome_unknown" });
    await expect(c.request({ method: "GET", url: "https://api.github.com/x", mode: "read" })).rejects.toMatchObject({ kind: "transient" });
  });
});

describe("generic status mapping", () => {
  const c = new HostClient(makeDeps(mockFetch(() => json({})).fetch), hosts, [SECRET]);
  const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => ({ status, headers: new Headers(headers), text: JSON.stringify(body), json: body });
  it.each([
    [401, "read", "auth_expired"],
    [402, "read", "payment_required"],
    [403, "read", "permission_missing"],
    [429, "read", "rate_limited"],
    [400, "read", "validation_rejected"],
    [422, "create", "validation_rejected"],
    [503, "read", "transient"],
    [500, "safe_write", "transient"],
    [500, "create", "outcome_unknown"],
    [503, "create", "outcome_unknown"],
  ] as const)("%i in %s mode => %s", (status, mode, kind) => {
    expect(c.fail(res(status), mode).kind).toBe(kind);
  });
  it("parses Retry-After seconds and dates", () => {
    const now = new Date("2026-11-25T10:00:00Z");
    expect(parseRetryAfter("30", now)?.toISOString()).toBe("2026-11-25T10:00:30.000Z");
    expect(parseRetryAfter("Wed, 25 Nov 2026 11:00:00 GMT", now)?.toISOString()).toBe("2026-11-25T11:00:00.000Z");
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(c.fail(res(429, {}, { "retry-after": "120" }), "read").retryAt?.toISOString()).toBe("2026-11-25T10:02:00.000Z");
  });
  it("redacts secrets and bearer tokens from platform messages", () => {
    const e = c.fail(res(400, { message: `bad token ${SECRET} and Bearer abcdefghijklmnop1234 access_token=zzzzzzzzzzzzzzzz` }), "read");
    expect(e.platformMessage).not.toContain(SECRET);
    expect(e.platformMessage).not.toContain("abcdefghijklmnop1234");
    expect(e.platformMessage).not.toContain("zzzzzzzzzzzzzzzz");
    expect(sanitizeMessage("x".repeat(1000)).length).toBeLessThanOrEqual(301);
  });
});

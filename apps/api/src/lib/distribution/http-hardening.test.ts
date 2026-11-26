import { describe, expect, it } from "vitest";
import { HostClient } from "./http.js";
import { sanitizeMessage, truncateUrlAware } from "./errors.js";
import { createInstagramProvider } from "./providers/instagram.js";
import { createThreadsProvider } from "./providers/threads.js";
import { createLinkedInProvider } from "./providers/linkedin.js";
import { createXProvider } from "./providers/x.js";
import { json, makeDeps, mockFetch, POST_FIXTURE, SECRET } from "./test-utils.js";
import type { ConnectedAccount } from "./types.js";

const hosts = ["api.github.com"];
const URL_ = "https://api.github.com/x";
const acct = (provider: ConnectedAccount["provider"], externalId = "id1"): ConnectedAccount => ({
  provider, externalId, displayName: "O", username: "o", accessToken: SECRET, refreshToken: null, accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null, scopes: [], issuedAt: new Date("2026-11-01T00:00:00Z"), connectedAt: new Date("2026-11-01T00:00:00Z"),
});

/** Sarlavhalar darhol keladi, tana esa hech qachon tugamaydi. */
const hangingBody = () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("{")); } }), { status: 200 });

describe("create-mode server errors always win over provider refinement (item 1)", () => {
  it("Graph 500 {error:{code:2}} on threads_publish is outcome_unknown, not retryable", async () => {
    const m = mockFetch([() => json({ id: "C1" }), () => json({ status: "FINISHED" }), () => json({ error: { code: 2, message: "Service temporarily unavailable" } }, { status: 500 })]);
    const e = await createThreadsProvider().publish({ deps: makeDeps(m.fetch), account: acct("threads") }, { post: POST_FIXTURE, text: "t" }).then(() => null, (x: unknown) => x as { kind: string; retryable: boolean; step: string; partial: unknown });
    expect(e).toMatchObject({ kind: "outcome_unknown", retryable: false, step: "publish", partial: { containerId: "C1" } });
  });
  it("Graph 500 {code:1} on media_publish is outcome_unknown; a 500 on the container step stays transient", async () => {
    const IMG = "https://cdn.abdusoft.uz/a.jpg";
    const m = mockFetch([() => json({ id: "1001" }), () => json({ status_code: "FINISHED" }), () => json({ error: { code: 1, message: "unknown" } }, { status: 500 })]);
    await expect(createInstagramProvider().publish({ deps: makeDeps(m.fetch), account: acct("instagram") }, { post: POST_FIXTURE, text: "c", imageUrl: IMG })).rejects.toMatchObject({ kind: "outcome_unknown", retryable: false });
    const c = mockFetch(() => json({ error: { code: 2, message: "x" } }, { status: 500 }));
    await expect(createInstagramProvider().publish({ deps: makeDeps(c.fetch), account: acct("instagram") }, { post: POST_FIXTURE, text: "c", imageUrl: IMG })).rejects.toMatchObject({ kind: "transient", step: "container" });
  });
  it("408 and 5xx on create are outcome_unknown for every provider with a create call", async () => {
    for (const status of [408, 500, 502, 503, 504]) {
      const li = mockFetch(() => json({ message: "x" }, { status }));
      await expect(createLinkedInProvider().publish({ deps: makeDeps(li.fetch), account: acct("linkedin") }, { post: POST_FIXTURE, text: "x", linkMode: "text" })).rejects.toMatchObject({ kind: "outcome_unknown" });
      const x = mockFetch(() => json({ title: "x" }, { status }));
      await expect(createXProvider().publish({ deps: makeDeps(x.fetch), account: acct("x") }, { post: POST_FIXTURE, text: "t" })).rejects.toMatchObject({ kind: "outcome_unknown" });
    }
  });
});

describe("timeout covers the response body and size is capped (item 3)", () => {
  it("a body that never ends aborts: create => outcome_unknown, read => transient", async () => {
    const deps = { ...makeDeps(async () => hangingBody()), timeoutMs: 30 };
    const c = new HostClient(deps, hosts);
    await expect(c.request({ method: "POST", url: URL_, mode: "create" })).rejects.toMatchObject({ kind: "outcome_unknown" });
    await expect(c.request({ method: "GET", url: URL_, mode: "read" })).rejects.toMatchObject({ kind: "transient" });
    await expect(c.request({ method: "POST", url: URL_, mode: "refresh" })).rejects.toMatchObject({ kind: "refresh_ambiguous" });
  });
  it("rejects oversized bodies (declared and streamed) instead of buffering them", async () => {
    const big = "x".repeat(2000);
    const deps = { ...makeDeps(async () => new Response(big, { status: 200 })), maxResponseBytes: 1000 };
    await expect(new HostClient(deps, hosts).request({ method: "GET", url: URL_, mode: "read" })).rejects.toMatchObject({ kind: "transient" });
    await expect(new HostClient(deps, hosts).request({ method: "POST", url: URL_, mode: "create" })).rejects.toMatchObject({ kind: "outcome_unknown" });
    const streamed = { ...makeDeps(async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(600)); c.enqueue(new Uint8Array(600)); c.close(); } }), { status: 200 })), maxResponseBytes: 1000 };
    await expect(new HostClient(streamed, hosts).request({ method: "GET", url: URL_, mode: "read" })).rejects.toMatchObject({ kind: "transient" });
  });
  it("normal bodies under the cap still parse", async () => {
    const r = await new HostClient(makeDeps(async () => json({ ok: true })), hosts).request({ method: "GET", url: URL_, mode: "read" });
    expect(r.json).toEqual({ ok: true });
  });
});

describe("message redaction and URL-aware truncation (item 8)", () => {
  it("redacts a token that straddles the old 300-char cut (redact BEFORE truncating)", () => {
    const token = "AQUvlLDYEzvT2wz1QJiEPeLioeAqwertyuiop";
    const raw = `${"a".repeat(285)} access token ${token} trailing`;
    const out = sanitizeMessage(raw);
    expect(out).not.toContain(token.slice(0, 6));
    expect(out.length).toBeLessThanOrEqual(301);
  });
  it("redacts long token-like strings after phrases, without Bearer/access_token= prefixes", () => {
    for (const phrase of ["invalid access token", "the refresh token", "client secret is", "bad api key:", "Authorization:"]) {
      const out = sanitizeMessage(`${phrase} abcdEFGH1234567890xyzQ expired`);
      expect(out).not.toContain("abcdEFGH1234567890xyzQ");
    }
    expect(sanitizeMessage("token expired")).toBe("token expired");
    expect(sanitizeMessage("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123SIGNATURE ok")).not.toContain("eyJhbGci");
  });
  it("end to end: HostClient.fail redacts a token inside a long non-JSON body", () => {
    const c = new HostClient(makeDeps(async () => json({})), hosts, [SECRET]);
    const text = `${"z".repeat(290)}${SECRET}`;
    const e = c.fail({ status: 400, headers: new Headers(), text, json: undefined }, "read");
    expect(e.platformMessage).not.toContain(SECRET.slice(0, 12));
  });
  it("never cuts inside a URL", () => {
    const text = `see ${"w".repeat(10)} https://example.com/${"p".repeat(100)}/end rest`;
    const out = truncateUrlAware(text, 40);
    expect(out).not.toMatch(/https?:\/\/[^\s]*…/);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(41);
    expect(truncateUrlAware("short", 40)).toBe("short");
  });
});
